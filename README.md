# PullVault

> Buy a mystery pack. Rip it. See what it's worth. Hold it, trade it, or auction it.

🔗 **Live demo:** https://pull-vault-web-goeq.vercel.app  ·  WS: https://pullvault-production-9d82.up.railway.app
📦 **Source:** https://github.com/abhinav26966/PullVault
🎥 **Walkthrough:** https://drive.google.com/file/d/1e-XvsPCadu4tSGXFAxc7bnNiq4a_syjj/view?usp=sharing

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

## Architecture

For the deep dive on concurrency, anti-snipe mechanics, EV math, and what breaks at 10K users, see [ARCHITECTURE.md](./ARCHITECTURE.md).
