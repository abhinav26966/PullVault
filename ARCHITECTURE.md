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

---

# Part B Addendum

> Sections §10–§14 below extend the Part A architecture (§1–§9 above
> stay unmodified — the Part A submission references them). Numbering
> picks up where Part A ended; the build plan's draft references to
> "§9 Pack Economics" map to §10 here.

## 10. Pack Economics

PullVault prices each pack tier so the platform expects a target margin
(default 30%) under the published rarity weights. The reverse-engineering
problem is: given target margin `m`, pack price `p`, and bucket-mean prices
`μ_C/U/R/E/L`, find per-slot rarity weights that produce `EV ≤ p · (1 − m)`
without driving win-rate to zero. Per-tier:

```
EV(tier) = Σ_slots[ slot.count · Σ_rarity( w_{slot,rarity} · μ_rarity ) ]
```

**The solver in plain English.** Every slot has two endpoints — an
*aspirational* distribution we'd love to advertise (generous in rares for
HIT/JACKPOT, conservative for FILLER) and a *floor* that still guarantees a
non-zero rare/epic/legendary chance. A single tilt knob per slot,
`t_s ∈ [0, 1]`, slides between floor and aspirational, with the resulting
weights `w_s(t_s) = (1 − t_s) · w_floor_s + t_s · w_aspire_s`. The solver
picks a tilt vector that hits the target EV while pulling each slot as
little as possible *away from its aspirational weights*, weighted by how
much EV that slot can swing — so when the constraint bites, the
high-leverage HIT and JACKPOT slots take the brunt and commons stay close
to advertised. Under the hood it's a Lagrangian with KKT first-order
conditions; the implementation bisects the global multiplier for 50
iterations with no early-exit shortcuts and rounds all tilts to 1e-6
before persisting, so the JSONB output is byte-identical across machines
and reruns.

**Why this beats a single global tilt.** A naive "pull every slot
proportionally toward the floor" extracts margin from the commons too —
they're cheap, but their advertised weights are what users see most often.
The per-slot variant concentrates the pain in slots that swing the most
EV per unit of tilt (HIT, JACKPOT), so the user-visible distribution drifts
less. Empirically about 3–5pp better win-rate at the same target margin.

**Snapshot semantics.** `packs.rarity_weights` JSONB is written inside the
buy transaction from the active `pack_economics_snapshots` row at that
instant. The pack-roller reads `packs.rarity_weights` at rip time — never
the live snapshot. Existing unopened packs are immune to any later
recompute. Recompute fires from two paths: the hourly price-refresh cron
and the `/admin/health` "Recompute now" button; both call the same
`recomputeAllTiers` in `@pullvault/db`. Every run writes a new
append-only row; previous active row flips to `is_active=false`.

**Calibration on the live ingest.** Rarity bucket means on the current
pokemontcg.io snapshot (C ≈ 12¢, U ≈ 12¢, R ≈ 28¢, E ≈ 129¢, L ≈ 153¢)
sit well below the documented assumption ($0.05 / $0.15 / $0.75 / $6.00 /
$50.00 per rarity). The pool's high-tier ceiling is ~$11 vs the
documented ~$50, and the L bucket holds 6 cards. The solver finds
aspirational weights feasible at this calibration and ships them
unchanged. The bucket-mean simulator returns win-rate = 0% across tiers
— mathematically forced when max realised value sits below pack price.
The card-level sampling mode added by the B4 carry-forward draws
specific cards within the rolled bucket and gives meaningful win-rate
distributions.

**Edge cases.** A 10-card pool: the solver runs identically on thin buckets
and warns when any bucket is empty. A single card priced > pack price:
its bucket EV dominates and the active-set clamps the legendary weight.
Infeasible price: `status='infeasible'`, `is_active=false`, and the notes
field captures the reason — surfaced as a red banner in the dashboard.

Reference: `packages/domain/src/economics/solver.ts`,
`packages/db/src/economics/recompute.ts`.

---

## 11. Anti-Bot, Rate Limiting, Drop Fairness

Three orthogonal mechanisms compose: a Lua-backed sliding-window-log rate
limiter (atomic, per-key), a fairness-window lottery for drop opens, and
a behavioural bot-scoring cron (decoration only, never blocks).

**Sliding-window-log Lua.** One Redis key per `(scope, scope_id,
endpoint)` storing a sorted set of request timestamps. The Lua script
runs as a single uninterrupted EVAL — a burst of 100 concurrent requests
sees fully serialised state with no GET-then-SET race window. Cluster-safe
because the key uses `{user:abc}` hash tags, so all entries live on one
shard and the ZSET operations stay single-key:

```lua
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window + 1000)
  return {1, limit - count - 1}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = oldest[2] and ((tonumber(oldest[2]) + window) - now) or window
return {0, math.max(0, retry)}
```

**Limits and reasoning.** `signup`: 3/hour per IP — anonymous, only IP
budget — throttles signup-cluster bots without bothering one-off humans.
`buy_drop`: 5/60s per user, 20/60s per IP — covers fast clickers without
blocking legitimate excitement. `bid_auction`: 5/30s per user — also
satisfies B3's rapid-fire-bidding detection (the 6th bid in 30s 429s).
`buy_listing`: 10/60s per user, 30/60s per IP — listings churn faster than
drops so the budget is roomier. Every block writes a `rate_limit_audit`
row for forensics.

**Lottery cron beats setTimeout.** The fairness window for a drop is
`[starts_at, starts_at + LOTTERY_WINDOW_MS]` (default 5s). Buys inside
the window enqueue into a Redis ZSET with a cryptographically random
score; a 2-second cron pops and mints in score order. Cron is restart-safe
by construction — a worker crash mid-drain just defers to the next tick,
gated by `pack_drops.lottery_resolved`. An in-process `setTimeout` would
lose state on restart and not survive horizontal scaling.

**Lottery pre-window note.** The in-window check is `now < starts_at +
LOTTERY_WINDOW_MS`, which means pre-`starts_at` buys also enqueue. This
is intentional — early-arriving fans pre-queue with no priority advantage
over latecomers, since the random score is independent of arrival time.

**Behavioural bot-scoring.** A 5-minute cron writes `users.bot_score`
from four signals: signup-to-first-buy delta (instant purchase scores
up), zero-interaction signature (no mouse/keyboard events between load
and buy, captured into `bot:sig:{userId}` Redis lists by the buy
endpoint), user-agent diversity per IP (many UAs from one IP scores
up), and client-seed identicality across users (activated by the B4
schema column). Forward-looking signals to add: per-request structured
access logs, raw user-agent fingerprints, and GeoIP-based timezone
validation. Decoration only — never blocks; threshold 80 lights an
orange chip on the `/admin/health` Fraud tab.

Reference: `apps/web/lib/rate-limit/sliding-window.lua`,
`apps/ws/src/jobs/lottery-resolver.ts`,
`apps/ws/src/jobs/bot-scoring.ts`.

---

## 12. Auction Integrity

Two layers shipped in B3: a 60-second sealed-bid window before settlement,
and a wash-trade detector that runs after settlement to score collusive
patterns.

**Sealed-bid window.** The auction state machine extends from `OPEN →
SETTLED` to `OPEN → SEALED → SETTLED`. The auction-closer cron flips
`OPEN → SEALED` at `ends_at − 60s`. Bids continue to be accepted while
sealed; the difference is purely a redaction concern: the public
`auction:{id}` WS room broadcasts events with `amount/bidder` fields
nulled out and an `is_sealed: true` marker. The bidder's own
`user:{userId}` channel still receives a confirmation with their actual
amount, so they know their bid registered. Settlement runs through the
existing `OPEN → SETTLED` atomic path at `ends_at`.

**Server-side blind beats commit-reveal here.** Cryptographic
commit-reveal — user submits `hash(amount + nonce)`, then reveals after
the window — is verifiable end-to-end but requires user-side state across
two transactions and an enforcement story for users who don't reveal
(grief vector). Server-side blinding accepts the trade-off: the server
sees sealed bids during the 60s window. The cost is bounded (60s per
auction, not cross-cutting) and the upside is keeping the existing
single-transaction settlement and the bidder's UX clean — no second
"reveal your bid" step, no abandoned bids polluting the close.

**Anti-snipe + sealed coexist.** A bid in the last 30 seconds extends
`ends_at` by 30s in an atomic UPDATE inside the bid endpoint. The sealed
window start is computed from `ends_at − 60s` on every closer tick, so
the extension rolls the sealed window forward in lockstep — both
mechanisms compose without breaking each other. `extension_count` on
the auction surfaces snipe-rate in the admin analytics.

**Fat-finger guards.** Two-tier: client-side warning at 3× current bid (a
confirmation modal — soft warning for "are you sure?" cases), server-side
hard cap at the larger of 100× current bid and 100× market price (returns
400 BID_TOO_HIGH). 100× is the "I fat-fingered a zero" guard, never
legitimate.

**Wash-trade detector.** Scores recently-settled auctions across 8
weighted signals: shared signup IP, prior P2P trade history,
account-cluster co-membership, low final-price ratio, single-bidder,
account-age delta, prior shared-IP recurrence, and exact-minimum-
increment win. Threshold 55 is calibrated so any two strong signals
trigger a flag. A 5-minute cron writes `auction_flags` rows; detection
only — flagged auctions stay SETTLED, and the admin queue at
`/admin/auctions` lets a human triage.

**Worked example.** The synthetic test we ran during B3 verification
created two accounts from the same IP minutes apart (`shared_signup_ip`
+30, `account_age_delta_lt_7d` +15) and ran a single-bid auction with no
contest (`single_bidder` +20). Total score: 65 ≥ 55 → flagged. The admin
queue at `/admin/auctions` rendered the row with all three reason codes
visible. The auction itself stayed `SETTLED` — detection only, never
auto-cancellation.

Reference: `apps/ws/src/jobs/wash-trade-detector.ts`,
`apps/ws/src/jobs/auction-closer.ts`,
`apps/web/app/api/auctions/[id]/bid/route.ts`.

---

## 13. Provably Fair Pack Openings

Every pack is verifiable end-to-end by a third party — the `/verify/[packId]`
page recomputes SHA-256 + HMAC client-side from raw inputs the server
hands over. The server is not the oracle; the user's browser is.

**Pre-committed seed pool.** A WS-side cron maintains ≥ 100 unused
`(commit, server_seed)` rows in `seed_pool`. `commit = SHA-256(server_seed)`,
hex of the UTF-8 encoded seed string — the same canonicalisation Web
Crypto's `subtle.digest` produces in the browser, so the verify page's
SHA-256 matches the stored commit byte-for-byte. The buy transaction
claims one row with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`. The public
endpoint `/api/audit/commits?status=unused` exposes the unused subset
(commits + created_at, **no server_seed leaked**), so any user can prove
their assigned commit was already in the public ledger before their
purchase. The server cannot have crafted a seed for their specific cards,
because it committed to that seed before knowing which user would draw it.

**Why this avoids the per-day-rotation gap.** A naive design rotates one
server seed per day and reveals it the next day. The verification gap:
if you buy at 23:59 and the seed reveals at 00:00, the server has a 1-minute
window where it knows the seed and your specific outcomes before reveal.
Pre-committed pool collapses that gap to zero — your commit is published
before any pack draws from it, regardless of when in the day you buy.

**HMAC-SHA256 sampler with byte-layout note.** A single shared module in
`packages/domain/src/provably-fair/sampler.ts` runs in both Node and the
browser via `globalThis.crypto.subtle`. Per slot `i` in pack `P`:

```
payload   = `${client_seed}:${P}:${i}`
digest    = HMAC-SHA256(server_seed, payload)            // 32 bytes
bucketF   = uint64BE(digest[0..8])  / 2^64               // [0,1)
cardF     = uint64BE(digest[8..16]) / 2^64               // [0,1)
bucket    = sampleByCDF(slot.weights, bucketF)
cardId    = uniformPick(eligibleCardsByRarity[bucket]
                          sorted by id, cardF)
```

`Uint8Array` everywhere, never `Buffer` (browser doesn't have it).
`BigInt → Number` conversion is spec-defined identically in both runtimes
(round to nearest, ties to even), so the fractions agree to the last bit.
Byte-layout test vectors locked in
`packages/domain/src/__tests__/provably-fair-sampler.test.ts:24` — a
regression in either runtime trips the locked digest assertion.

**Client-seed contribution.** The buy endpoint accepts `client_seed`
(32–128 hex chars; default = 32 random bytes from
`crypto.getRandomValues`). It mixes into the HMAC payload, so a flip in
either seed changes every digest. Server-side cherry-picking is
prevented by the commit ordering: server commits to `server_seed` before
knowing the client_seed, then the HMAC mixes both. Lottery winners (who
didn't submit `client_seed` at enqueue) get a random one generated at
mint time — the audit invariant still holds because the *server*
commit was pre-published.

**Audit endpoints.** `/api/audit/commits` (public, no `server_seed`),
`/api/audit/aggregates` (latest per (tier, rarity) for chi² verification),
`/api/packs/[id]/verify-data` (raw row dump, no precomputed booleans —
the comment in the route handler enforces "no `valid`, no `match`, no
`isPre*`" as a hard invariant for future maintainers).

**Trust model — what the server can and cannot do.** CAN: see your
`client_seed` during the buy transaction. CANNOT: choose your
`server_seed` (it was pre-published in `seed_pool` before your buy).
CANNOT: silently swap your `server_seed` post-purchase — the verify
page's SHA-256 step detects the mismatch with no server cooperation.
(Verified end-to-end on production: tamper `packs.server_seed` in psql
→ `/verify/[packId]` flips to red MISMATCH on next refresh; restore the
seed → green again.) CANNOT: substitute revealed
cards — `pack_cards.position N` must match the HMAC sample at slot N,
and the verify page recomputes every slot independently.

Reference: `packages/domain/src/provably-fair/sampler.ts`,
`apps/web/app/verify/[packId]/page.tsx`,
`apps/web/app/api/packs/[id]/verify-data/route.ts`.

---

## 14. Health Dashboard

`/admin/health` is the operational sibling to Part A's
`/admin/economics`. Four tabs (Economics, Fraud, Fairness, Users), SWR
auto-refresh every 30 s, no new tables — every metric is a query over
existing B1–B4 data.

**Two statistical tests, not one.** The Fairness tab reads the latest
`pack_audit_aggregates` snapshot per tier and runs chi-squared *and*
Kolmogorov-Smirnov. Different tests catch different kinds of unfairness:
chi² is bucket-by-bucket, so it lights up when a single rarity diverges
from its advertised weight. K-S is cumulative along the C → U → R → E → L
order — it catches systematic skew (e.g. "everything is shifted one
rarity-class down") that chi² can miss when individual buckets all stay
close to expected but the running total drifts. When both agree the
chip is green or red; when they disagree, yellow "investigate" — the
disagreement is itself a signal worth surfacing, rather than picking
a winner.

The implementations live in `packages/domain/src/stats/`. Chi-squared
sums `(obs − exp)² / exp` across rarity buckets and converts to a p-value
via the Wilson-Hilferty cube-root transform (≤ 0.005 approximation error
against scipy's `chi2.sf`). K-S takes the maximum cumulative gap between
observed and expected, scales by √n, and feeds the result into the
Kolmogorov distribution — an alternating series that converges roughly 4
orders of magnitude per term once λ ≥ 0.5, capped at 100 iterations
with a 1e-12 convergence threshold. Both have locked test vectors
against scipy reference output, so any regression in either function
fails the unit suite before deploy.

**Alert thresholds.** α = 0.05 (standard). Both p ≥ α → green ("no
evidence of unfairness"). Either p < α → red. Disagreement → yellow.
Economic alert: |actual_margin − target_margin| > 0.02 → red row.
Solver self-test failure (snapshot row with `is_active=false` and
`notes LIKE 'self-test failed:%'`) → loud red banner above the tier
table with the `lagrangian/tilt/delta` numbers parsed and rendered.
Fraud: `bot_score > 80` → orange chip. Users: 7-day retention < 30%
→ orange chip.

**Multiple-testing caveat.** Running daily across 3 tiers × 2 tests = 6
tests/day, so the family-wise false-positive rate over a week is
~30% — operationally meaningful but not a system-blocker because
flagged tiers go to human triage, not auto-kill. Acceptable given the
detect-only policy.

Reference: `packages/domain/src/stats/chi-squared.ts`,
`packages/domain/src/stats/ks.ts`,
`apps/web/app/(app)/admin/health/page.tsx`.
