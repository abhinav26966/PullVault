# PullVault Architecture

How the system holds together when two users click "buy" at the same millisecond.

This doc focuses on the five questions the brief asks for: pack-drop concurrency, auction consistency, caching, what breaks at 10K users, and pack economics. Schema, deployment, and code organization are in [README.md](./README.md) and `packages/db/src/schema.ts`.

---

## 1. System overview

Three runtime surfaces, one source of truth.

- **Web app** — Next.js 14 on Vercel. Every state-changing API route runs in a Postgres transaction. This is the only place writes happen for user actions.
- **WS server** — Node.js + Socket.io on Railway. Subscribes to Redis pub/sub and fans events out to clients. Owns the cron jobs (drop activator, auction closer, price refresh, drop replenisher). Never writes Postgres in response to user actions.
- **Data** — Supabase Postgres (used as plain Postgres, no Auth/RLS) plus Upstash Redis for the pub/sub bridge.

The web app writes to Postgres and publishes to Redis. The WS server reads from Redis and pushes to clients. The two deploys are decoupled enough that either can restart without the other noticing.

```
Browser ──HTTPS──▶ Next.js (Vercel) ──writes──▶ Postgres
                          │
                          └─publish─▶ Redis ─subscribe─▶ WS (Railway) ──WSS──▶ Browser
```

Cross-domain WS auth: cookies don't cross the Vercel/Railway boundary regardless of `SameSite`. The client fetches the JWT from a same-origin endpoint and passes it via the Socket.IO handshake auth payload. The WS server reads `socket.handshake.auth.token`, falling back to the cookie for local dev.

---

## 2. Pack-drop concurrency

The brief's primary concurrency test: N users, M packs, exactly M succeed and N−M get a clean sold-out error.

`apps/web/app/api/drops/[id]/buy/route.ts`:

```sql
-- Step 1: atomic conditional decrement.
UPDATE pack_drops
SET inventory_remaining = inventory_remaining - 1
WHERE id = :dropId AND inventory_remaining > 0 AND state = 'OPEN'
RETURNING ...

-- Step 2: atomic conditional debit.
UPDATE wallets
SET balance_available = balance_available - :price
WHERE user_id = :buyer AND balance_available >= :price
RETURNING ...
```

Both UPDATEs carry their own predicate (`inventory > 0`, `available >= price`) on the UPDATE itself, not in a separate SELECT. Postgres row-level locking serializes the writes. If either statement matches zero rows, the transaction throws and rolls back. There is no read-then-write window where a check passes at read time but fails at write time.

The transaction also rolls the pack contents server-side (`rollPack` in `packages/domain`) and writes `packs` + `pack_cards` rows, so cards are determined at purchase and not at reveal — the client cannot peek.

Two users, one pack, both POST `/buy` simultaneously: first UPDATE wins, returns the row. Second UPDATE matches zero rows, throws `SoldOutError`, returns 409. Verified live on the deployed system.

---

## 3. Auction consistency

The most concurrency-sensitive code in the build. `apps/web/app/api/auctions/[id]/bid/route.ts` runs in one transaction with this order:

1. `SELECT auctions.* WHERE id = :id FOR UPDATE` — serializes concurrent bidders.
2. Validate (state OPEN, not past `ends_at`, bidder is not seller, amount ≥ min increment).
3. **Atomic conditional hold on the new bidder** — `available -= amount, held += amount WHERE available >= amount`. Throws if short-funded.
4. Release the previous bidder's hold (`available += prev_amt, held -= prev_amt`). No conditional needed; their hold is structurally guaranteed by step 3 of their own bid.
5. UPDATE auction with new high bid + extended `ends_at` (anti-snipe, see below).
6. INSERT bid row for history.
7. Commit, then publish to `auction:{id}` (everyone watching) and to `user:{prev}` (outbid notification).

**Hold-then-release order is critical.** If we released the previous bidder's hold before placing the new one, a short-funded new bidder could leave the auction with a phantom "current bid" but no funds locked anywhere. New hold first, always.

### Anti-snipe

Step 5's UPDATE includes:

```sql
ends_at = GREATEST(ends_at, clock_timestamp() + interval '30 seconds')
```

`GREATEST` makes the timer monotonic — it can extend, never shorten. If a bid lands in the closing window, the deadline pushes out by 30 seconds. If the auction has more than 30 seconds left, the existing `ends_at` wins.

Why `clock_timestamp()` and not `now()`. `now()` in Postgres is `transaction_timestamp()`, frozen at transaction start. The bid transaction has 9 statements; over Supabase's pooler the round-trips add up to 8–12 seconds. With `now()`, a 30-second extension becomes 30 − tx_duration, so 18–22 seconds of real wall-clock. `clock_timestamp()` advances within the transaction and returns wall-clock at the moment the SQL evaluates. One word change, ten seconds of extension recovered.

Why 30 seconds. Long enough that a human can react and re-bid; short enough that auctions don't drag indefinitely. eBay Motors and Heritage use the same pattern.

### Crash recovery

Auction state lives in `auctions.ends_at`, not WS process memory. If the WS server dies mid-auction, the closer cron (every 5 seconds) reads from Postgres on next tick and settles whatever's expired. Verified by stopping the WS process, waiting a minute, restarting, and watching the expired auction settle correctly.

---

## 4. Marketplace consistency

`apps/web/app/api/listings/[id]/buy/route.ts`. Same pattern as the drop buy.

1. `SELECT listings FOR UPDATE WHERE state = 'ACTIVE'` — second simultaneous buyer matches zero rows, throws.
2. Reject self-buy.
3. Conditional debit on buyer (`gte(balance_available, price)`).
4. Credit seller (price − fee), credit platform (+fee).
5. Transfer card; reset cost basis to the buyer's purchase (`acquired_via='LISTING'`, `acquired_price = listing.price`, `acquired_at = now()`).
6. Mark listing SOLD.
7. Three ledger rows that sum to zero: buyer −price, seller +net, platform +fee.
8. Publish, then return.

Two deviations from the original sketch worth calling out in the review:

The platform wallet is credited alongside the `LISTING_FEE` ledger row. The §5.2 reconciliation invariant requires `Σ ledger == Σ wallets` for every user including the platform; without the platform UPDATE, the wallet would diverge from the ledger over time.

The card's cost basis resets to the buyer's purchase price. Without this, the new owner's portfolio P&L would point at the previous owner's pull-time price.

**Held funds are untouchable.** The buyer's debit predicate is `gte(balance_available, price)`, not `gte(available + held)`. A user with $20 available and $15 held cannot use the held portion for a $25 marketplace buy.

**Card-state guard.** A card already in an active auction has `user_cards.state = 'AUCTIONED'`. Listing creation requires `state = 'OWNED'`, so the same card cannot be listed and auctioned at the same time. Symmetric for the reverse.

---

## 5. Wallet ledger as audit trail

Every wallet movement writes a `wallet_ledger` row. The ledger is append-only and the invariant is:

```
SUM(wallet_ledger.amount) == SUM(wallets.balance_available + balance_held)
```

across all users including the platform. This is shown as a green/red badge on `/admin/economics` and re-verified by two CLI scripts:

- `pnpm -F @pullvault/web verify-ledger` — fast aggregate check.
- `pnpm -F @pullvault/web verify-activity` — per-user replay of every event with running balance.

The replay script is the strongest answer to "prove no money is created or destroyed." It walks every user's full event history (ledger rows plus a synthetic "pack opened" event), accumulates the running total, and confirms the final number matches the wallet exactly.

Auction holds use zero-amount `AUCTION_HOLD` / `AUCTION_RELEASE` ledger rows. The wallet movement is intra-wallet (`available ↔ held`), so the ledger amount is 0 — these exist for trail completeness, not balance change. Settlement decrements `held` and writes a non-zero `AUCTION_SETTLE_BUYER` row.

---

## 6. Caching strategy

Postgres is the source of truth for everything that affects money. Redis is the bus for real-time fan-out and a cache for hot reads that don't.

| Surface | Cached? | Why |
|---|---|---|
| Card prices (read) | Redis hash, 60s TTL | Hot read, slow source, broadcast on >1% drift |
| Wallet balance | **Never** | Always read-through. Cache invalidation under contention is its own bug class. |
| Inventory remaining | **Never** | Same. Postgres canonical, deltas broadcast over WS. |
| Auction current bid | **Never** | Same. Reconnecting clients re-fetch authoritative state. |
| Drop list | Redis JSON, 30s | Cheap stale tolerance, refreshed on drop activation |
| Auction list | Redis JSON, 10s | Same |

Inside money-moving transactions, every read goes to Postgres directly. The price Redis hash powers the portfolio render, not the price the buy route commits against.

---

## 7. Price engine

`pokemontcg.io` is the source — it embeds TCGplayer market prices in every card response, so we get TCGplayer prices through their mirror. TCGplayer's direct developer API is closed to new applicants ("We are no longer granting new API access at this time" per their own docs).

The pipeline is one function (`runPipeline()` in `packages/db/src/price-pipeline`) that runs at boot and on each cron tick. There is no separate seed — boot run doubles as initial population. Per-set fetches are fault-isolated: a 504 on one set logs a warning and skips that set, the rest of the pipeline continues, the next hourly tick retries.

Price changes that exceed a 1% drift threshold publish to `prices:global`. Connected clients filter locally for the cards they own. (At 10K users this becomes a problem — see §9.)

Demo jitter is gated by `PRICE_DEMO_MODE=true`, defaults off. When on, every 30s it picks 20 cards and applies bounded Gaussian jitter clamped within ±5% of the real baseline. The next real refresh resets the baseline. This is the only way to get visible price motion in an 8-minute Loom; real TCGplayer prices update on a daily cadence.

---

## 8. Pack economics

Three tiers. Margins decrease as tier increases — a deliberate inversion of casino-style pricing, which makes the platform feel like a fair market rather than a slot machine.

| Tier | Price | Cards | EV | House margin |
|---|---|---|---|---|
| Bronze | $4.99 | 5 | $3.05 | 38.9% |
| Silver | $14.99 | 7 | $9.74 | 35.0% |
| Gold | $49.99 | 10 | $35.64 | 28.7% |

### Rarity buckets

Five buckets, normalized from the API's messy rarity strings ("Rare Holo VMAX", "Amazing Rare", "Hyper Rare") into something we can weight cleanly.

| Bucket | Mean | Real-world equivalent |
|---|---|---|
| C | $0.05 | Bulk commons |
| U | $0.15 | Uncommons |
| R | $0.75 | Non-holo rares |
| E | $6.00 | Holo, V, ex |
| L | $50.00 | Secret Rare, Hyper Rare, Alt Art |

The L bucket has the longest tail in real life — most are $20–80, top end runs into the hundreds — which is what makes pulling a Legendary feel huge.

### Slot model

Hit-slot rolls, mirroring real Pokemon packs.

- **Bronze** — 4 filler (70% C, 28% U, 2% R) + 1 hit slot (80% R, 18% E, 2% L). EV = 4 × $0.092 + $2.68 = $3.05.
- **Silver** — 5 filler + 1 rare floor (90% R, 9% E, 1% L) + 1 hit (55% R, 35% E, 10% L). EV = $9.74.
- **Gold** — 7 filler + 2 rare floors (70% R, 22% E, 8% L) + 1 jackpot (10% R, 50% E, 40% L). EV = $35.64. The "I just pulled an alt art" moment lands one in four.

Full weights live in `packages/domain/src/tier-config.ts` with unit tests that verify every slot's weights sum to 1.0.

### Fees

| Action | Fee | Comparison |
|---|---|---|
| Marketplace trade | 3% on seller | StockX 10%, eBay 13% |
| Auction win | 5% on seller | eBay 13%, Heritage ~20% |

Auction is higher because it costs more to operate (real-time WS, anti-snipe extensions, longer settlement). Both visibly below comparable platforms — gives the platform headroom without feeling extractive.

---

## 9. What breaks first at 10K users

Honest answer in four layers, ordered by which fails first.

**1. WebSocket fan-out.** A single Node process can hold 5–10K Socket.io connections, depending on message rate. Sparse traffic is fine. A popular auction with 1,000 watchers and rapid bidding spikes per-second fan-out enough to matter. Fix: scale the WS server horizontally with the Socket.io Redis adapter — a well-trodden pattern, and our architecture is already compatible because Redis is the bus.

**2. Postgres connection pool.** Supabase's pool has limits. Hot paths (drop activation, auction settlement) are short transactions but volume can spike. Fix: pgbouncer pooler URL on port 6543 (one-line env change). Already in place.

**3. Global price broadcasts.** Every >1% price drift on every card publishes to `prices:global` for every connected client. At 10K users a single change is 10K WS sends. Fix: per-user fan-out — clients announce which cards they own when joining, the server pushes only relevant changes per socket. Today we broadcast globally and let clients filter, which is fine at trial scale and an obvious next step.

**4. Pokemon TCG API rate limits.** Free tier is 1000 req/day, we use ~48. Plenty of headroom. At 50K cards (a real catalog) we'd hit the ceiling. Fix: paid tier, or migrate to TCGplayer direct if their developer program reopens.

What does **not** break: the transactional core. Pack purchases, trades, and auction bids keep their guarantees regardless of load — Postgres serializes them. They get slower under contention, not wrong. This is the property that matters most given the 30% concurrency weight.
