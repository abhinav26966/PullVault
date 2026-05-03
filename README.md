# PullVault

> Buy a mystery pack. Rip it. Discover what you pulled. Hold it, trade it, or auction it.

🔗 **Live demo:** https://pull-vault-web-goeq.vercel.app  ·  WS server: https://pullvault-production-9d82.up.railway.app
📦 **Source:** https://github.com/abhinav26966/PullVault
🎥 **Walkthrough:** _TBD (Loom, 8 min)_

---

## What is PullVault?

PullVault is a digital collectibles platform built around the Pokemon TCG. Users sign up with a $1,000 paper-trading balance, buy limited mystery packs, reveal cards one by one to discover their real market value, and then build a portfolio they can trade peer-to-peer or auction live to other users.

Every card has a market price drawn from real Pokemon TCG data, and prices move continuously, so the portfolio stays alive between sessions. Packs drop on a schedule with limited inventory, so the act of buying one is a competitive event in itself.

The product is a deliberate fusion of three existing experiences:

- **Pack ripping** like Packz.io or Courtyard, where the dopamine comes from the reveal
- **A trading marketplace** like StockX, where every item has a real market value
- **Live auctions** like Heritage or Goldin, where bidders compete in real time

The core loop is simple: deposit, drop, rip, hold or trade, repeat.

---

## The Core User Flow

1. **Sign up.** Receive $1,000 starting balance.
2. **Wait for a drop.** Three pack tiers (Bronze $4.99, Silver $14.99, Gold $49.99) drop on a schedule with limited inventory. Countdown is server-authoritative.
3. **Buy a pack.** When the drop goes live, all eligible users compete for inventory. Inventory decrements in real time over WebSocket.
4. **Rip the pack.** Cards reveal one by one. Common slots first, hit slots last. Each card shows its name, image, set, rarity, and live market value. A summary screen shows pack EV vs. price paid.
5. **Manage the collection.** Sort, filter, see live portfolio value, see P&L per card.
6. **List or auction.** Put a card up for fixed-price sale, or start a live auction with a 5 min, 30 min, or 2 hr timer.
7. **Watch auctions live.** Bid history, current high bid, watcher count, anti-snipe timer extension.
8. **Settle.** Auctions close server-side. Winner pays, seller is credited minus fee, card moves.

---

## Tech Stack

| Layer            | Choice                                     | Why                                                                                |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Frontend         | Next.js 14 App Router + TypeScript         | Mandated. App Router is mature.                                                    |
| Styling          | Tailwind CSS + shadcn/ui (selective)       | Mandated. shadcn for primitives only (button, dialog, input).                      |
| Backend (HTTP)   | Next.js Route Handlers (TypeScript)        | Co-located with frontend, single deploy on Vercel.                                 |
| Backend (WS)     | Standalone Node.js + Socket.io             | Vercel cannot host long-lived WS. Runs separately on Railway.                      |
| Database         | Supabase Postgres                          | Free tier, excellent table editor for debugging, standard `postgresql://` connection — used as plain Postgres only. |
| ORM              | Drizzle ORM                                | Explicit SQL surface. `FOR UPDATE` and atomic updates are first-class.             |
| Cache + Pub/Sub  | Redis on Upstash                           | Free tier, low latency, Pub/Sub bridges API server and WS server.                  |
| Background jobs  | node-cron inside the WS process            | The WS process is always-on. No need for a separate worker for this scale.         |
| Auth             | bcrypt + JWT in httpOnly cookie            | Simple, defensible, no third-party dependency. Supabase Auth is intentionally not used (see ARCHITECTURE §12). |
| Validation       | Zod                                        | Shared between client and server.                                                  |
| Money            | decimal.js                                 | Mandated. Floats are not acceptable for currency.                                  |
| Card data        | Pokemon TCG API (pokemontcg.io v2)         | Free, no auth required for read. Returns TCGplayer prices embedded with each card via pokemontcg.io's own mirror. TCGplayer's direct API is closed to new developers (per their [own docs](https://docs.tcgplayer.com/docs/getting-started)). |
| Price refresh    | Cron every 1h pulls real prices from API   | Insulates UX from upstream flakiness. Real prices are the source of truth. Demo mode adds synthetic jitter for video recordings only. |
| Deploy           | Vercel (web) + Railway (ws) + Supabase + Upstash | All have free tiers sufficient for the demo.                                 |

---

## Project Structure

This is a `pnpm` monorepo. Two apps share types and domain logic via internal packages.

```
pullvault/
├── apps/
│   ├── web/                  # Next.js 14 app, deployed on Vercel
│   │   ├── app/
│   │   │   ├── (auth)/       # Login, signup
│   │   │   ├── (app)/        # Dashboard, drops, collection, market, auctions
│   │   │   └── api/          # Route handlers (REST endpoints)
│   │   ├── components/
│   │   ├── hooks/
│   │   └── lib/
│   └── ws/                   # Socket.io + cron server, deployed on Railway
│       ├── src/
│       │   ├── server.ts     # Socket.io entry point
│       │   ├── auth.ts       # JWT verification on connect
│       │   ├── pubsub.ts     # Redis subscriber that fans out to clients
│       │   ├── handlers/     # Per-channel handlers
│       │   └── jobs/
│       │       ├── drop-activator.ts
│       │       ├── auction-closer.ts
│       │       ├── price-refresh.ts
│       │       └── price-demo-jitter.ts
├── packages/
│   ├── db/                   # Drizzle schema, client, migrations, seed
│   ├── domain/               # Pure business logic (pack rolling, EV math, bid rules)
│   └── shared/               # Types, constants, WS event contracts
├── README.md
├── ARCHITECTURE.md
├── pnpm-workspace.yaml
└── .env.example
```

The split exists so the WS server and the Next.js app share exactly one source of truth for types, schema, and business rules. Critically, the `domain/` package contains zero I/O; every function in it is unit-testable without a database. This is where the pack roller, EV calculator, and bid validator live.

---

## Quickstart

### Prerequisites

- Node.js 20+
- pnpm 8+
- A Postgres connection URL (Supabase free tier works — use the `postgresql://` connection string from Project Settings → Database)
- A Redis connection URL (Upstash free tier works)
- (Optional) A Pokemon TCG API key from [pokemontcg.io](https://pokemontcg.io) for higher rate limits — the API works without one for read access, but a key is recommended for the seed

### Setup

```bash
git clone <repo-url>
cd pullvault
pnpm install
cp .env.example .env.local
# fill in DATABASE_URL, REDIS_URL, JWT_SECRET, NEXT_PUBLIC_WS_URL
# (full reference: ARCHITECTURE.md Appendix B)
```

### Database

```bash
pnpm db:generate    # generates Drizzle migrations from schema
pnpm db:migrate     # runs migrations against DATABASE_URL
pnpm db:seed        # pulls ~500 cards from pokemontcg.io, inserts cards + prices, creates initial drops
```

### Run

```bash
pnpm dev            # runs web (port 3000) and ws (port 4000) in parallel
```

### Deploy

The split deploys to two platforms because Vercel cannot host long-lived WebSocket connections (their functions are short-lived).

```bash
# web (Vercel)
vercel --prod

# ws (Railway)
railway up
```

#### Environment variables

Both platforms read most variables from the same source of truth (`.env.example` documents them all). Below is the minimum set each side needs.

**Vercel (web):**

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Supabase pooler URL (port 6543) |
| `REDIS_URL` | Upstash `rediss://…` URL |
| `JWT_SECRET` | Same value as Railway |
| `WEB_PUBLIC_URL` | The Vercel domain itself, e.g. `https://pull-vault-web-*.vercel.app` |
| `NEXT_PUBLIC_WS_URL` | The Railway WSS URL, e.g. `wss://*-up.railway.app`. **Baked into the build at compile time** — change requires redeploy. |
| `POKEMON_TCG_API_KEY` | Optional but recommended (raises rate limit) |
| `PRICE_SOURCE` | `pokemontcg` (default) |

**Railway (ws):**

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Same Supabase pooler URL |
| `REDIS_URL` | Same Upstash URL |
| `JWT_SECRET` | Same value as Vercel — must match exactly so the WS server can verify tokens signed by the web app |
| `WEB_PUBLIC_URL` | The Vercel domain — used as the CORS allowlist origin |
| `PORT` | Railway provides automatically |
| `PRICE_REFRESH_INTERVAL_HOURS` | Default 1 |

#### Cross-domain WS auth

Because the Vercel domain (`*.vercel.app`) is unrelated to the Railway domain (`*.up.railway.app`), the browser will not send the `pv_session` cookie on the WS handshake even with `SameSite=None`. The client therefore fetches the JWT from a same-origin endpoint (`GET /api/auth/ws-token`) and passes it via the Socket.IO handshake auth payload (`io(url, { auth: { token } })`). The WS server reads `socket.handshake.auth.token` first, falling back to the cookie for same-origin local development. Full rationale in [ARCHITECTURE.md §12](./ARCHITECTURE.md#12-authentication).

---

## Features

The platform implements every must-have from the brief:

- **Auth and wallet.** Email/password sign-up. Each user gets $1,000 in paper money on creation. Wallet has two balances: `available` and `held`.
- **Pack drops.** Three tiers, scheduled drops with limited inventory, real-time inventory countdown via WebSocket. Atomic purchase that cannot oversell or double-charge.
- **Pack reveal.** Cards are rolled server-side at purchase time and persisted, so reveal is just a paginated read from the database. The reveal UI streams cards one at a time with rarity-ordered tension building.
- **Live prices.** Card prices are pulled from the Pokemon TCG API at boot (this is what populates the `cards` and `card_prices` tables — there is no separate "seed" concept), then refreshed every hour by the same code path. Real price changes that exceed a 1% drift threshold are pushed to all connected clients via WebSocket on the `prices:global` channel. A `PRICE_DEMO_MODE` flag adds gentle synthetic jitter every 30 seconds for demo recordings, since real market prices update on a daily cadence and won't visibly move inside an 8-minute video.
- **Portfolio.** Grid view of all owned cards, sort by value, rarity, or P&L, filter by rarity or set. Total portfolio value updates in real time. Per-card P&L vs. acquisition price. A simple total-return indicator shows portfolio performance since signup. Quick actions per card: list for sale, start auction, view details.
- **Marketplace.** List a card for fixed price. Buyer purchases atomically. Seller is credited minus a 3% fee.
- **Auctions.** Start an auction with 5 min, 30 min, or 2 hr duration. Bid increments enforced server-side. Bids hold funds in escrow until won, lost, or auction settles. Anti-snipe extends the timer when bids land in the final 30 seconds. The auction room shows current high bid, full bid history, server-authoritative countdown, and a live count of users watching the room.
- **Platform economics dashboard.** Shows pack tier EVs, realized house margin per tier, total fee revenue from trades and auctions.

The full architecture, including the concurrency model, anti-snipe specifics, and pack EV math, lives in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Data Sources

**Card data and prices come from real Pokemon TCG market data.**

- **Pokemon TCG API** ([pokemontcg.io](https://pokemontcg.io)) is our authoritative source for both card metadata (name, set, rarity, image) and prices. Each `/v2/cards` response includes embedded `tcgplayer.prices` and `cardmarket.prices` blocks, sourced from the same TCGplayer marketplace feed the brief references — so we are getting TCGplayer prices, just through pokemontcg.io's mirror.
- The price pipeline runs ~500 cards across 4-6 popular Pokemon expansions, normalizing the API's messy rarity strings ("Rare Holo VMAX", "Amazing Rare", "Hyper Rare") into our 5-bucket scheme (C/U/R/E/L). The first run at boot doubles as the initial population of the `cards` and `card_prices` tables; subsequent hourly runs update prices in place. There is no separate "seed" concept — it's one code path executed on a schedule.
- A price-refresh cron job in the WS process polls the API **every hour**, updates Postgres + Redis, and broadcasts meaningful changes (>1% drift) to all connected clients on `prices:global`.
- Real Pokemon TCG prices update on a **daily cadence** at most. The portfolio "feels alive" not from minute-to-minute price ticks but from real-time drops, auction bids, marketplace activity, and pack reveals — five concurrent real-time signals, of which prices are the slowest-moving by design. For demonstration purposes, a `PRICE_DEMO_MODE` flag adds gentle synthetic jitter every 30 seconds, anchored to the real baseline (clamped within ±5%). This is disabled in production. See [ARCHITECTURE.md §9](./ARCHITECTURE.md#9-price-engine) for the full spec including this design rationale.

**Why not TCGplayer's API directly?** Per their official [getting-started guide](https://docs.tcgplayer.com/docs/getting-started): *"We are no longer granting new API access at this time."* The TCGplayer Developer Program has been closed to new applicants for over a year. The brief itself anticipates this with its fallback clause ("If TCGPlayer access takes time to approve..."); in practice, no amount of waiting will produce a key. pokemontcg.io is therefore not a degraded fallback — it is the only viable path, and it serves TCGplayer prices through its own mirror anyway.

---

## API Surface (high level)

REST endpoints (Next.js Route Handlers under `apps/web/app/api`):

| Group     | Endpoint                            | Purpose                                         |
| --------- | ----------------------------------- | ----------------------------------------------- |
| Auth      | `POST /api/auth/signup`             | Create user, return session cookie              |
| Auth      | `POST /api/auth/login`              | Authenticate, return session cookie             |
| Wallet    | `GET /api/wallet`                   | Return available + held balances                |
| Drops     | `GET /api/drops`                    | List upcoming and active drops                  |
| Drops     | `POST /api/drops/:id/buy`           | Purchase one pack from this drop (atomic)       |
| Packs     | `GET /api/packs/:id`                | Fetch a purchased pack and its cards            |
| Packs     | `POST /api/packs/:id/reveal/:slot`  | Mark a pack slot as revealed (cosmetic)         |
| Cards     | `GET /api/cards/:id`                | Fetch a single card with current market price   |
| Portfolio | `GET /api/me/portfolio`             | Owned cards with current values and P&L         |
| Market    | `GET /api/listings`                 | Browse active listings, filter by rarity, etc.  |
| Market    | `POST /api/listings`                | Create a listing for one of my cards            |
| Market    | `POST /api/listings/:id/buy`        | Purchase a listing (atomic)                     |
| Auctions  | `GET /api/auctions`                 | List active auctions                            |
| Auctions  | `POST /api/auctions`                | Start an auction on one of my cards             |
| Auctions  | `GET /api/auctions/:id`             | Fetch auction state and recent bids             |
| Auctions  | `POST /api/auctions/:id/bid`        | Place a bid (atomic, with anti-snipe)           |
| Admin     | `GET /api/admin/economics`          | Pack EV, realized margin, fee revenue           |

## WebSocket Events

The WS server uses Socket.io rooms. A client subscribes to a room by emitting `subscribe` with a channel name.

| Channel                  | Direction       | Payload                                              |
| ------------------------ | --------------- | ---------------------------------------------------- |
| `drop:{dropId}`          | Server → client | `{ inventoryRemaining, isLive }`                     |
| `auction:{auctionId}`    | Server → client | `{ event: 'bid', currentBid, currentBidUserId, endsAt, bidCount }` |
| `auction:{auctionId}`    | Server → client | `{ event: 'watchers', count }`                       |
| `auction:{auctionId}`    | Server → client | `{ event: 'closed', winnerId, finalBid }`            |
| `user:{userId}`          | Server → client | `{ event: 'outbid', auctionId, ... }`                |
| `prices:global`          | Server → client | `[{ cardId, price }]` (batched every 60s)            |

---

## Parameter Decisions (summary)

Full justification in [ARCHITECTURE.md §14](./ARCHITECTURE.md#14-pack-economics).

| Parameter           | Value                                  |
| ------------------- | -------------------------------------- |
| Starting balance    | $1,000                                 |
| Pack tiers          | Bronze $4.99, Silver $14.99, Gold $49.99 |
| Cards per pack      | 5 / 7 / 10                             |
| Pack EV / margin    | $3.05 (39%) / $9.74 (35%) / $35.60 (29%) |
| Trading fee         | 3% of sale, paid by seller             |
| Auction fee         | 5% of winning bid, paid by seller      |
| Min bid increment   | max($0.50, 5% of current bid)          |
| Auction durations   | 5 min, 30 min, 2 hr                    |
| Anti-snipe          | Soft close: bid in final 30s extends `endsAt` to `now() + 30s` |
| Drop inventory      | 50 / 20 / 5 per drop (Bronze / Silver / Gold) |

---

## Scope Cuts

The brief calls out P0, P1, and P2 explicitly. I built every P0 and P1 item. The following P2 items were deliberately deferred:

- **Mobile-responsive design.** The desktop UI is functional but layouts do not collapse cleanly on narrow viewports. The brief explicitly de-prioritizes visual polish.
- **Historical price charts per card.** Spot prices are shown live but no historical sparkline. The price engine writes to a `price_history` table so this can be added without schema changes.
- **Offer system on marketplace.** Buyers cannot counter-offer; they either pay the listed price or skip. Adding offers would require its own state machine and was not worth the time tradeoff.
- **Pack reveal animations.** Cards flip in sequence but there are no 3D pack tear animations. The reveal logic is sound; only the visual treatment is minimal.

> Note on the brief's P2 list: "Multiple concurrent auctions" (multiple auctions running at the same time on different cards) is supported natively — auctions are independent rows and the auction-closer job processes any number of them. The brief item is therefore implemented, not deferred.

---

## Architecture

For the deep dive on concurrency, real-time architecture, money handling, anti-snipe mechanics, pack EV math, and what breaks at 10K users, see [ARCHITECTURE.md](./ARCHITECTURE.md).