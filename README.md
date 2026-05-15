# PullVault

> Buy a mystery pack. Rip it. See what it's worth. Hold it, trade it, or auction it.

**Live demo:** https://pull-vault-web-goeq.vercel.app

**WS:** https://pullvault-production-9d82.up.railway.app

**Source:** https://github.com/abhinav26966/PullVault

**Part A walkthrough:** https://drive.google.com/file/d/1e-XvsPCadu4tSGXFAxc7bnNiq4a_syjj/view?usp=sharing

**Part B walkthrough:** https://drive.google.com/file/d/1QheJ8WGpI37FblulhIrRJdgZ61JOyri4/view?usp=sharing

---

## What is PullVault?

A digital collectibles platform built around the Pokémon TCG. Sign up, get $1,000 in paper money, buy limited packs at scheduled drops, rip them, and end up with a portfolio of real cards at real TCGplayer market prices. From there: trade peer-to-peer, list at fixed price, or run live auctions with anti-snipe.

Three things to point at:

- **Pack ripping** (Packz, Courtyard) — the reveal is the moment.
- **Trading marketplace** (StockX) — every item has a real market value.
- **Live auctions** (Heritage, Goldin) — bidders compete in real time, anti-snipe extends the timer when a bid lands in the closing window.

Core loop: deposit, drop, rip, hold or trade, repeat.

---

## Core flow

1. **Sign up.** $1,000 paper balance.
2. **Wait for a drop.** Three tiers — Bronze $4.99 / Silver $14.99 / Gold $49.99. Limited inventory, scheduled `starts_at`. Countdown is server-authoritative.
3. **Buy.** All eligible users compete for inventory. Atomic, no oversell.
4. **Rip.** Cards reveal one at a time, commons first, hit last.
5. **Manage.** Sort/filter the collection, see live total return since signup, click any card for a full activity timeline straight from the wallet ledger.
6. **List or auction.** Fixed-price listing or live auction with 5 min / 30 min / 2 hr durations.
7. **Auction room.** Bid history, server-authoritative countdown, watcher count, anti-snipe extension on late bids.
8. **Settle.** Auctions close server-side. Winner pays from held funds, seller credited net of fee.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Web | Next.js 14 (App Router) + TypeScript + Tailwind | Mandated. Co-located UI + REST. |
| WS | Standalone Node + Socket.io | Vercel can't host long-lived sockets. Runs on Railway. |
| Database | Supabase Postgres | Used as plain Postgres (no Auth, no RLS). pgbouncer pooler in production. |
| ORM | Drizzle | Explicit SQL surface. `FOR UPDATE` and atomic conditional UPDATEs are first-class. |
| Cache + Pub/Sub | Upstash Redis | Bridges the web app's writes and the WS server's fan-out. |
| Background jobs | node-cron in WS process | Always-on. No separate worker needed at this scale. |
| Auth | bcrypt + JWT in httpOnly cookie + handshake-token for cross-domain WS | ~120 lines, no external dependency. Supabase Auth not used (RLS conflicts with the transactional model). |
| Money | decimal.js at boundaries, integer cents on the wire and in storage | Mandated. |
| Card data | Pokemon TCG API (pokemontcg.io v2) — serves TCGplayer prices through its mirror | TCGplayer's direct API is closed to new applicants. |
| Deploy | Vercel + Railway + Supabase + Upstash | All free tier. |

---

## Project structure

```
pullvault/
├── apps/
│   ├── web/          # Next.js 14 → Vercel
│   └── ws/           # Socket.io + cron → Railway
├── packages/
│   ├── db/           # Drizzle schema, migrations, price pipeline
│   ├── domain/       # Pure business logic — pack rolling, EV math, bid validation, fees. Zero I/O.
│   └── shared/       # WS event contracts, shared types
├── README.md
└── ARCHITECTURE.md
```

The split exists so the web app and the WS server share exactly one source of truth for types, schema, and business rules. `domain/` has no I/O — the pack roller, EV calc, and bid validator are unit-testable without a database.

---

## Quickstart

```bash
git clone <repo-url>
cd pullvault
pnpm install
cp .env.example .env.local   # fill in DATABASE_URL, REDIS_URL, JWT_SECRET, NEXT_PUBLIC_WS_URL
pnpm db:generate             # generate Drizzle migrations
pnpm db:migrate              # run them
pnpm dev                     # web on :3000, ws on :4000
```

The first WS boot runs the price pipeline against pokemontcg.io and populates `cards` + `card_prices`. There's no separate seed step.

### Useful CLI scripts

```bash
pnpm -F @pullvault/web verify-ledger     # aggregate ledger ↔ wallet check (§5.2 invariant)
pnpm -F @pullvault/web verify-activity   # per-user replay of every event with running balance
pnpm -F @pullvault/web reset-ledger      # destructive: rebuild wallets from ledger
```

---

## Deploy

Two platforms because Vercel can't host long-lived sockets.

**Vercel (web):**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase pooler URL (port 6543) |
| `REDIS_URL` | Upstash `rediss://…` |
| `JWT_SECRET` | Same value as Railway |
| `WEB_PUBLIC_URL` | The Vercel domain itself |
| `NEXT_PUBLIC_WS_URL` | The Railway `wss://…` URL. **Baked into the build at compile time** — change requires redeploy. |
| `POKEMON_TCG_API_KEY` | Optional, raises rate limits |

**Railway (ws):**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Same Supabase pooler URL |
| `REDIS_URL` | Same Upstash URL |
| `JWT_SECRET` | Same value as Vercel — must match exactly so the WS server can verify tokens signed by the web app |
| `WEB_PUBLIC_URL` | Vercel domain (used as CORS allowlist) |
| `POKEMON_TCG_API_KEY` | Optional |
| `PORT` | Railway provides automatically |

Part B introduces four additional env vars (`LOTTERY_WINDOW_MS`, `SEALED_WINDOW_MS`, `ECONOMICS_AUTO_RECOMPUTE`, `SEED_POOL_TARGET`). All have sane defaults and are documented in the [Part B addendum](#part-b-addendum) below.

### Cross-domain WS auth

Cookies don't cross unrelated origins (Vercel ≠ Railway) regardless of `SameSite`. The browser fetches the JWT from a same-origin endpoint (`GET /api/auth/ws-token`) and forwards it via the Socket.IO handshake (`io(url, { auth: { token } })`). The WS server reads `socket.handshake.auth.token`, falling back to the cookie for same-origin local dev. Full rationale in [ARCHITECTURE.md §1](./ARCHITECTURE.md#1-system-overview).

---

## Parameter decisions

Justified in [ARCHITECTURE.md §8](./ARCHITECTURE.md#8-pack-economics).

| Parameter | Value |
|---|---|
| Starting balance | $1,000 |
| Pack tiers | Bronze $4.99 / Silver $14.99 / Gold $49.99 |
| Cards per pack | 5 / 7 / 10 |
| Pack EV (margin) | $3.05 (39%) / $9.74 (35%) / $35.64 (29%) |
| Trading fee | 3% on seller |
| Auction fee | 5% on seller |
| Min bid increment | max($0.50, 5% of current bid) |
| Auction durations | 5 min, 30 min, 2 hr |
| Anti-snipe | Soft close: bid in final 30s extends `ends_at` to `clock_timestamp() + 30s` |
| Drop inventory | 50 / 20 / 5 per drop |

---

## Scope cuts

P0 and P1 from the brief are all built. P2 deferrals:

- **Mobile-responsive design.** Desktop UI is functional; layouts don't collapse cleanly on narrow viewports. Brief explicitly de-prioritizes visual polish.
- **Historical price charts.** Spot prices are live; no per-card sparkline.
- **Offer system on marketplace.** Buyers either pay the listed price or skip. Counter-offers would need their own state machine.
- **3D pack tear animations.** Cards flip in sequence with a tasteful reveal but the visual treatment is minimal.

The brief lists "multiple concurrent auctions" under P2 but it's actually supported natively — auctions are independent rows and the closer cron processes any number.

---

## Part B addendum

Part B adds five workstreams on top of Part A: a pack-economics solver that keeps the platform profitable as card prices drift, anti-bot defenses for both drops and bidding, sealed-bid auction integrity, provably-fair pack openings any user can verify in their own browser, and an operational health dashboard tying it all together. The architecture deep-dive lives in [ARCHITECTURE.md §10–§14](./ARCHITECTURE.md#part-b-addendum); the bullets below are the elevator pitch.

- **Pack economics solver** ([§10](./ARCHITECTURE.md#10-pack-economics)) — per-slot Lagrangian solver replaces the static rarity weights. Hourly recompute against live `card_prices` writes append-only snapshots; `packs.rarity_weights` is frozen at purchase time so in-flight packs are immune.
- **Sliding-window-log rate limiter** ([§11](./ARCHITECTURE.md#11-anti-bot-rate-limiting-drop-fairness)) — atomic Lua over Redis ZSETs. Per-endpoint user + IP budgets; a 100-concurrent-requests stress script verifies exact-count enforcement.
- **Drop-fairness lottery** (§11) — first 5 s after `starts_at`, buys enqueue with random scores; a 2 s cron mints in score order. Pre-`starts_at` buys also queue, by design (no priority advantage from early arrival).
- **Behavioural bot-scoring** (§11) — 5-min cron writes `users.bot_score` from four signals (signup→first-buy delta, zero-interaction, UA-diversity per IP, cross-account client-seed). Decoration only; threshold 80 → orange chip.
- **Sealed-bid auctions** ([§12](./ARCHITECTURE.md#12-auction-integrity)) — `OPEN → SEALED → SETTLED`. At `ends_at − 60 s` the public WS room redacts amount/bidder; the bidder's private channel still confirms. Anti-snipe and sealed compose (anti-snipe extension rolls the sealed window forward in lockstep).
- **Wash-trade detector** (§12) — 5-min cron scores 8 weighted signals; score ≥ 55 writes an `auction_flags` row. Detection-only — auctions stay SETTLED.
- **Provably-fair pack openings** ([§13](./ARCHITECTURE.md#13-provably-fair-pack-openings)) — pre-committed seed pool, public commit ledger at `/api/audit/commits`, in-browser SHA-256 + HMAC verification at `/verify/[packId]`. Tampering with `packs.server_seed` in psql flips the verify page to MISMATCH on refresh — verified end-to-end on production.
- **Health dashboard** ([§14](./ARCHITECTURE.md#14-health-dashboard)) — `/admin/health` with Economics / Fraud / Fairness / Users tabs. χ² + K-S over rarity distributions, 30 s SWR refresh, agreement chip surfaces test disagreement. Part A's `/admin/economics` stays unmodified.
- **Audit aggregator** — 10-min cron writes `pack_audit_aggregates`; boot-time backfill on the WS process so the dashboard has data day one rather than after the first tick.

### New endpoints

**Public (no auth):**

- `GET /verify/[packId]` — verification page; runs SHA-256 + HMAC in the browser
- `GET /api/packs/[id]/verify-data` — raw row dump for the verify page (no precomputed booleans by design)
- `GET /api/audit/commits?status=unused|used|all` — pre-published seed-commit ledger
- `GET /api/audit/aggregates` — latest per (tier, rarity) for χ² verification

**Admin (auth required, trial-scope permissive):**

- `GET /admin/health?tab=economics|fraud|fairness|users` — operational dashboard
- `GET /admin/auctions` — wash-trade flag queue + auction analytics (B3)
- `GET /api/admin/health/{economics,fraud,fairness,users}` — data sources for the dashboard tabs
- `POST /api/admin/economics/recompute` — manual solver tick
- `POST /api/admin/economics/simulate?tier=…&n=…` — Monte Carlo simulator

**User-facing change:**

- `POST /api/drops/[id]/buy` now accepts `{ client_seed: <32–128 hex chars> }` (optional; default = 32 random bytes). During the lottery window the response is `202 { status: 'queued', position, resolveAfterMs }`; outside it, the existing `201 { packId }`.

### Part B env vars

| Variable | Default | Set on | Purpose |
|---|---|---|---|
| `LOTTERY_WINDOW_MS` | `5000` | web + ws | Lottery fairness window after a drop's `starts_at` |
| `SEALED_WINDOW_MS` | `60000` | ws | Sealed-bid window before an auction's `ends_at` |
| `ECONOMICS_AUTO_RECOMPUTE` | _unset_ | ws | Set to `1` to enable hourly solver recompute on the price-refresh cron |
| `SEED_POOL_TARGET` | `100` | ws | Unused-commit count maintained by the refill cron |

### Migration deploy note

`pnpm db:migrate` can silently abort on migrations that `ALTER TYPE … ADD VALUE` an enum and then reference the new enum value within the same outer transaction (drizzle-kit wraps the entire run in `BEGIN`/`COMMIT`; Postgres rejects). Affects `0004_white_micromax.sql` (adds `'SEALED'` to `pullvault_auction_state` and reuses it in a unique-index predicate) and `0005_windy_captain_america.sql` (extends the FK chain that touches the same enum). `psql -f` runs each statement in its own implicit transaction, so the enum-add followed by the predicate is allowed — the conflict only arises when wrapped in a single outer `BEGIN`/`COMMIT`.

If `pnpm db:migrate` aborts on production due to `ALTER TYPE ADD VALUE` in 0004 or 0005, apply via psql, then mark as applied in the journal:

```bash
# 0004 — applied + journaled
psql "$DATABASE_URL" -f packages/db/drizzle/0004_white_micromax.sql
HASH=$(shasum -a 256 packages/db/drizzle/0004_white_micromax.sql | awk '{print $1}')
WHEN=$(jq -r '.entries[] | select(.tag == "0004_white_micromax") | .when' packages/db/drizzle/meta/_journal.json)
psql "$DATABASE_URL" -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$HASH', $WHEN);"

# 0005 — same pattern
psql "$DATABASE_URL" -f packages/db/drizzle/0005_windy_captain_america.sql
HASH=$(shasum -a 256 packages/db/drizzle/0005_windy_captain_america.sql | awk '{print $1}')
WHEN=$(jq -r '.entries[] | select(.tag == "0005_windy_captain_america") | .when' packages/db/drizzle/meta/_journal.json)
psql "$DATABASE_URL" -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$HASH', $WHEN);"
```

Subsequent `pnpm db:migrate` invocations skip these migrations because the journal `created_at` is now ≥ the migration's `when`.

---

## Demo runbook — reproducing the Part B mechanics

Operational guide for replaying the Part B demo against the deployed app (or a local checkout). Concise on purpose — each section is a single mechanic with copy-paste commands.

### Setup (once per shell)

All `psql` commands assume `DATABASE_URL` is loaded from `.env.local`. All `curl` commands need an authenticated session cookie:

```bash
set -a && source .env.local && set +a

curl -s -c cookie.txt -X POST https://pull-vault-web-goeq.vercel.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@test.com","password":"DemoLoom!2026"}' > /dev/null
```

### Test users

| Email | Password | Notes |
|---|---|---|
| `alice@test.com` | `DemoLoom!2026` | seller in the staged auctions |
| `bob@test.com` | `DemoLoom!2026` | bidder counterpart |

Or sign up fresh — every new user gets a $1000 signup bonus.

### Fire a drop's lottery window (B §11)

Stage an OPEN drop with a near-future `starts_at`. Pre-window Buy clicks enqueue with cryptographically random tickets; the resolver cron drains at `starts_at + LOTTERY_WINDOW_MS`.

```bash
psql "$DATABASE_URL" -c "UPDATE pack_drops SET state='OPEN', starts_at = now() + interval '60 seconds', lottery_resolved = false, inventory_remaining = 1 WHERE id = '<DROP_ID>';"
```

Open `/drops/<DROP_ID>` in two browser windows (different users). Click **Buy** on each. Wait ~65 seconds. One window toasts 🎉 *Pack acquired* + redirects to `/packs/<id>`. The other toasts 🎰 *Didn't win this lottery*. Inventory and SOLD_OUT state propagate over the `drop:<id>` WS channel.

### Sealed-bid auction window (B §12)

```bash
psql "$DATABASE_URL" -c "UPDATE auctions SET ends_at = now() + interval '120 seconds', state='OPEN' WHERE id = '<AUCTION_ID>';"
```

Open `/auctions/<AUCTION_ID>` in two windows. Bid in the first 60 seconds — amount + bidder visible publicly. At `ends_at − 60s` the banner flips to **SEALED**; bid again — the bidder's private toast confirms their amount, the public room redacts both fields. Settles at `ends_at` via the same atomic path as Part A.

### Tamper / restore a verify pack (B §13)

```bash
PACK_ID=<pack-id>   # buy a pack and copy the id from the /packs/<id> URL
ORIGINAL_SEED=$(psql "$DATABASE_URL" -t -A -c "SELECT server_seed FROM packs WHERE id = '$PACK_ID';" | head -1)

# 1) Open https://pull-vault-web-goeq.vercel.app/verify/$PACK_ID — confirm green.

# 2) Tamper
psql "$DATABASE_URL" -c "UPDATE packs SET server_seed = 'deadbeef0000000000000000000000000000000000000000000000000000dead' WHERE id = '$PACK_ID';"

# 3) Refresh verify page → MISMATCH (every per-slot row red). Server sent no signal — browser caught it.

# 4) Restore
psql "$DATABASE_URL" -c "UPDATE packs SET server_seed = '$ORIGINAL_SEED' WHERE id = '$PACK_ID';"

# 5) Refresh verify page → green.
```

### Trigger an economics recompute (B §10)

```bash
curl -X POST -b cookie.txt 'https://pull-vault-web-goeq.vercel.app/api/admin/economics/recompute'
```

Or click **Recompute now** on `/admin/health?tab=economics`. Writes a new append-only row to `pack_economics_snapshots` per tier; the previous active row flips to `is_active=false`. In-flight unopened packs keep their original weights — admin reconfig can't retroactively change anyone's odds.

### Run the pack simulator (B §10)

```bash
curl -X POST -b cookie.txt \
  'https://pull-vault-web-goeq.vercel.app/api/admin/economics/simulate?tier=GOLD&n=10000' \
  | jq '.result'
```

Runs 10,000 fake openings against current `card_prices`. Returns `meanCents`, `marginActual`, `winRate`, percentile distribution. Use it to catch an infeasible solver configuration before it goes live.

### Inspect the wash-trade flag queue (B §12)

Cron runs every 5 minutes automatically. View flagged auctions at `/admin/auctions` — each shows the score and contributing reason chips (`shared_signup_ip` +30, `account_age_delta_lt_7d` +15, `single_bidder` +20, etc.). Detection-only — flagged auctions stay `SETTLED`; operator decides whether to escalate.

### Reconcile the wallet ledger (A §5)

```bash
pnpm -F @pullvault/web verify-ledger      # aggregate Σ check across all wallets
pnpm -F @pullvault/web verify-activity    # per-user event replay with running balance
```

Both green → `SUM(wallet_ledger.amount) == SUM(wallets.balance_available + balance_held)` exactly, including the platform wallet. Re-runnable from the command line; same invariant powers the green badge on `/admin/economics`.

### Rate-limiter stress test

```bash
pnpm -F @pullvault/web rate-limit-stress
```

Fires 100 concurrent requests at the sliding-window-log Lua. Expects exact-count enforcement — first N succeed, rest 429 — proving the atomic single-EVAL has no GET-then-SET race.

---

## Architecture

For the deep dive on concurrency, anti-snipe mechanics, EV math, what breaks at 10K users (§1–§9), and the Part B addendum covering pack economics, anti-bot, auction integrity, provably fair, and the health dashboard (§10–§14), see [ARCHITECTURE.md](./ARCHITECTURE.md).
