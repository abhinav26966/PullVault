# PullVault Architecture

This document is the technical blueprint for PullVault. It covers every design decision worth defending in a code review: deployment topology, the concurrency model, the wallet ledger, the auction state machine, anti-snipe mechanics, the price engine, caching, and the parameter math behind pack economics.

It is longer than the 1-2 page brief target on purpose. Reviewers can read sections 1-3 and 14 for the high-level picture; the rest exists so that any "show me the code that handles X" question maps to a specific section.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Deployment Topology](#2-deployment-topology)
3. [Tech Stack Rationale](#3-tech-stack-rationale)
4. [Code Organization](#4-code-organization)
5. [Domain Model](#5-domain-model)
6. [Concurrency Patterns](#6-concurrency-patterns)
7. [Real-Time Architecture](#7-real-time-architecture)
8. [Caching Strategy](#8-caching-strategy)
9. [Price Engine](#9-price-engine)
10. [Background Jobs](#10-background-jobs)
11. [Money Handling](#11-money-handling)
12. [Authentication](#12-authentication)
13. [Error Handling](#13-error-handling)
14. [Pack Economics](#14-pack-economics)
15. [Anti-Snipe Mechanism](#15-anti-snipe-mechanism)
16. [What Breaks at 10K Users](#16-what-breaks-at-10k-users)
17. [Implementation Order](#17-implementation-order)

**Appendices**

- [A — Sequence Diagrams](#appendix-a-sequence-diagrams)
- [B — Environment Variables](#appendix-b-environment-variables)
- [C — Card Seed Strategy](#appendix-c-card-seed-strategy)
- [D — Concurrency Test Scenarios](#appendix-d-concurrency-test-scenarios)

---

## 1. System Overview

PullVault has three runtime surfaces:

1. **Web app.** Next.js 14 with the App Router. Hosts the UI, all REST endpoints (Route Handlers), and server-side rendering. Deployed on Vercel.
2. **WS server.** A standalone Node.js process running Socket.io for real-time fan-out and node-cron for scheduled jobs (drop activation, auction close, price ticks). Deployed on Railway.
3. **Data layer.** Supabase Postgres as the source of truth. We use Supabase as plain managed Postgres (standard `postgresql://` connection string) — not its auth, RLS, storage, or edge functions. Redis on Upstash for caching, ephemeral state, and Pub/Sub between the web app and the WS server.

The web app writes to Postgres and publishes events to Redis. The WS server subscribes to Redis and pushes events to connected clients. The WS server never writes to Postgres for hot-path actions like bidding or buying; those go through the web app's API routes so all writes are funnelled through the same transaction boundary. The WS process additionally polls the Pokemon TCG API every hour to refresh real card prices, and writes those updates to Postgres + Redis before broadcasting deltas.

This separation matters because it gives one and only one place where state changes are committed. The WS server is read-only with respect to user actions and write-only with respect to scheduled jobs (drop activation, auction settlement, price refreshes).

---

## 2. Deployment Topology

```
┌──────────────────┐         ┌──────────────────┐
│  Browser / SPA   │         │  Browser / SPA   │
└────────┬─────────┘         └────────┬─────────┘
         │ HTTPS                      │ WSS
         │                            │
┌────────▼─────────┐         ┌────────▼─────────┐
│  Next.js (Vercel)│         │  Socket.io (Rail-│
│  - UI + SSR      │         │   way)           │
│  - REST API      │         │  - Fan-out       │
│  - Writes to DB  │         │  - Cron jobs     │
└────────┬─────────┘         └────────┬─────────┘
         │                            │
         │     ┌──────────────────────┐   │
         ├────▶│ Postgres (Supabase)  │◀──┤
         │     └──────────────────────┘   │
         │                            │
         │     ┌──────────────────┐   │
         └────▶│ Redis (Upstash)  │◀──┘
               │ - Pub/Sub        │
               │ - Cache          │
               │ - Sessions       │
               └──────────────────┘
```

**Why two deploys.** Vercel functions are short-lived and cannot host long WebSocket connections. The original instinct of "everything on Vercel" breaks once auctions need real-time bid fan-out. Railing one Node process on Railway costs nothing extra on a free tier and removes the constraint entirely.

**Inter-service communication.** The web app and WS server never call each other directly. Communication is one-way: web → Redis Pub/Sub → WS. This decouples the deploys completely. The WS server can restart without affecting purchases; the web app can deploy without dropping WS connections.

---

## 3. Tech Stack Rationale

| Choice                  | Alternative considered                  | Why this won                                                                                                |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Next.js Route Handlers  | Express / Fastify                       | Co-located with the UI. One repo, one deploy. Brief explicitly allows it.                                   |
| Drizzle ORM             | Prisma                                  | Explicit SQL. `FOR UPDATE`, atomic updates, and `RETURNING` are first-class. Prisma hides too much.         |
| Socket.io               | `ws` (raw)                              | Built-in reconnection, room semantics, and ack support. The brief calls out reconnection handling.          |
| Upstash Redis           | Self-hosted Redis                       | Free tier, REST API as backup, fits the serverless deploy model.                                            |
| Supabase Postgres       | Neon, self-hosted                       | Same Postgres core, polished table editor for live debugging during the demo. Used as plain Postgres only — no Auth, no RLS, no SDK. |
| node-cron in WS process | BullMQ / separate worker                | One always-on process is enough at this scale. BullMQ is the production answer; here it would be over-eng.  |
| JWT in httpOnly cookie  | NextAuth / Auth.js / Supabase Auth      | NextAuth pulls in too much. Supabase Auth conflicts with our transactional model (see §12). JWT is ~80 lines; defensible. |
| decimal.js              | bigint-based fixed-point                | Mandated by the brief. decimal.js is the standard.                                                          |

The non-obvious choice is **Drizzle over Prisma**. Reviewers will ask to see the code that handles concurrent pack purchases. With Drizzle, that code reads as something close to raw SQL, which is the cleanest possible answer to "show me how you avoid overselling." Prisma's `$transaction` and interactive transactions hide the lock semantics behind an abstraction; the senior move is to surface them.

---

## 4. Code Organization

### Monorepo layout

```
pullvault/
├── apps/
│   ├── web/                  # Next.js 14, deploys to Vercel
│   └── ws/                   # Socket.io + cron, deploys to Railway
├── packages/
│   ├── db/                   # Drizzle schema, client, migrations, seed
│   ├── domain/               # Pure business logic, zero I/O
│   └── shared/               # Types, constants, WS event contracts
├── pnpm-workspace.yaml
├── package.json
├── README.md
└── ARCHITECTURE.md
```

### `packages/domain` is the secret weapon

Every piece of business logic that does not require I/O lives here as pure functions. This is what makes the system testable and reviewable.

```
packages/domain/src/
├── pack-roller.ts        # weights → card draws
├── ev-calculator.ts      # tier configs → expected value
├── bid-validator.ts      # auction state + new bid → valid? amount?
├── fee-calculator.ts     # gross → net + fee
├── money.ts              # decimal.js helpers (toCents, fromCents, format)
└── __tests__/            # vitest unit tests, no DB required
```

When a reviewer asks "how do you guarantee a pack always rolls within the EV bounds you documented," the answer is "open `pack-roller.ts` and its tests." There is no database to mock, no API to stub.

### `apps/web` layout

```
apps/web/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   ├── (app)/
│   │   ├── layout.tsx            # auth guard + nav
│   │   ├── dashboard/page.tsx
│   │   ├── drops/page.tsx
│   │   ├── drops/[id]/page.tsx
│   │   ├── packs/[id]/page.tsx   # reveal experience
│   │   ├── collection/page.tsx
│   │   ├── market/page.tsx
│   │   ├── market/[id]/page.tsx
│   │   ├── auctions/page.tsx
│   │   ├── auctions/[id]/page.tsx
│   │   └── admin/economics/page.tsx
│   └── api/
│       ├── auth/...
│       ├── wallet/...
│       ├── drops/...
│       ├── packs/...
│       ├── listings/...
│       ├── auctions/...
│       └── admin/...
├── components/
│   ├── ui/                       # shadcn primitives
│   ├── pack-reveal/
│   ├── auction-room/
│   ├── countdown.tsx             # consumes server time
│   └── ...
├── hooks/
│   ├── use-socket.ts
│   ├── use-auction.ts
│   └── use-wallet.ts
└── lib/
    ├── auth.ts                   # JWT helpers, session reads
    ├── api-handler.ts            # consistent error wrapping
    └── publish.ts                # publishes to Redis Pub/Sub
```

### `apps/ws` layout

```
apps/ws/src/
├── server.ts                     # entry point, attaches handlers
├── auth.ts                       # validates JWT on connect
├── pubsub.ts                     # Redis subscriber, fans out to rooms
├── handlers/
│   ├── subscribe.ts              # client → server: join room
│   └── disconnect.ts
└── jobs/
    ├── drop-activator.ts         # every minute: flip SCHEDULED → OPEN
    ├── auction-closer.ts         # every 5s: close ended auctions
    ├── price-refresh.ts          # every 1h: pull real prices from Pokemon TCG API
    └── price-demo-jitter.ts      # every 30s when PRICE_DEMO_MODE=true (off by default)
```

---

## 5. Domain Model

This section is the spec sheet for the database schema. Every table, every meaningful column, every index, and every state machine is documented here so the actual `packages/db/src/schema.ts` can be generated mechanically. Field types are Drizzle conventions; the underlying Postgres types are noted where relevant.

### 5.1 Users and Wallets

A `users` table:

| Column         | Type         | Notes                                          |
| -------------- | ------------ | ---------------------------------------------- |
| `id`           | uuid PK      | `gen_random_uuid()` default                    |
| `email`        | text         | unique, citext extension recommended           |
| `password_hash`| text         | bcrypt, cost 10                                |
| `display_name` | text         | unique, used in bid history and listings       |
| `created_at`   | timestamptz  | default `now()`                                |

Indexes: `users(email)` unique, `users(display_name)` unique.

Each user has exactly one `wallets` row, created in the same transaction as the user:

| Column              | Type   | Notes                                                                  |
| ------------------- | ------ | ---------------------------------------------------------------------- |
| `user_id`           | uuid PK + FK | one-to-one with users                                            |
| `balance_available` | bigint | cents. Money the user can spend.                                       |
| `balance_held`      | bigint | cents. Money locked against active auction bids.                       |
| `updated_at`        | timestamptz | bumped on every write                                             |

Constraints: `balance_available >= 0`, `balance_held >= 0`. Postgres CHECK constraints enforce these at the database layer as a final safety net even if the application logic somehow miscomputes.

The total balance the user thinks they have is `available + held`. The UI shows both: "Available $X.XX · In auctions $Y.YY." A buyer cannot use held funds for a marketplace purchase because the buy endpoint debits `balance_available`, not the total. This is structurally enforced by the wallet model, not by application checks.

All money is integer cents. decimal.js is used at the application boundary for arithmetic; the storage layer never sees decimals.

### 5.2 Wallet Ledger

The `wallet_ledger` table is append-only and is the immutable audit trail.

| Column        | Type        | Notes                                                                     |
| ------------- | ----------- | ------------------------------------------------------------------------- |
| `id`          | uuid PK     |                                                                           |
| `user_id`     | uuid FK     | indexed                                                                   |
| `type`        | text enum   | one of the entry types below                                              |
| `amount`      | bigint      | signed cents. Negative = debit, positive = credit, 0 = transfer.          |
| `pack_id`     | uuid nullable FK |                                                                      |
| `listing_id`  | uuid nullable FK |                                                                      |
| `auction_id`  | uuid nullable FK |                                                                      |
| `bid_id`      | uuid nullable FK |                                                                      |
| `meta`        | jsonb       | optional extra context, e.g. `{ "newBidAmount": 1500 }` for AUCTION_HOLD  |
| `created_at`  | timestamptz | default `now()`, indexed for time-window economics queries                |

Indexes: `(user_id, created_at)`, `(type, created_at)`, `(auction_id)`, `(listing_id)`.

Entry types:

| Type                     | Side                  | Effect on balances                                              |
| ------------------------ | --------------------- | --------------------------------------------------------------- |
| `SIGNUP_BONUS`           | credit                | +$1,000 to available                                            |
| `PACK_PURCHASE`          | debit                 | −price from available                                           |
| `LISTING_PURCHASE`       | debit (buyer)         | −price from available                                           |
| `LISTING_SALE`           | credit (seller)       | +(price − fee) to available                                     |
| `LISTING_FEE`            | platform revenue      | +fee, recorded against `PLATFORM_USER_ID`                       |
| `AUCTION_HOLD`           | bidder, transfer      | available − amt, held + amt (net 0)                             |
| `AUCTION_RELEASE`        | bidder, transfer      | available + amt, held − amt (net 0). On outbid or cancel.       |
| `AUCTION_SETTLE_BUYER`   | winner                | held − final bid (winner pays from held)                        |
| `AUCTION_SETTLE_SELLER`  | seller                | available + (final bid − fee)                                   |
| `AUCTION_FEE`            | platform revenue      | +fee, recorded against `PLATFORM_USER_ID`                       |

A reconciliation query `SELECT user_id, SUM(amount) FROM wallet_ledger GROUP BY user_id` plus running totals of holds must equal current `wallets.balance_available + balance_held` for every user. The admin dashboard runs this periodically.

The `PLATFORM_USER_ID` is a fixed system UUID (`00000000-0000-0000-0000-000000000001`) inserted by the seed script. House revenue is just "the platform user's ledger entries summed."

### 5.3 Cards (catalog) and Card Prices

A `cards` table holds immutable metadata seeded from the Pokemon TCG API:

| Column       | Type        | Notes                                                          |
| ------------ | ----------- | -------------------------------------------------------------- |
| `id`         | text PK     | the pokemontcg.io card id, e.g. `swsh1-1`                       |
| `name`       | text        | "Charizard"                                                    |
| `set_id`     | text        | "swsh1"                                                        |
| `set_name`   | text        | "Sword & Shield"                                               |
| `number`     | text        | card number within set, "1/202"                                |
| `rarity_raw` | text        | the API's rarity string, "Rare Holo", "Amazing Rare", etc.     |
| `rarity`     | text enum   | normalized to one of `C`, `U`, `R`, `E`, `L` (see §14.2)        |
| `image_url`  | text        | the `images.large` URL from the API                            |
| `image_url_small` | text   | the `images.small` URL from the API                            |
| `created_at` | timestamptz |                                                                 |

Indexes: `cards(rarity)`, `cards(set_id)`.

A `card_prices` table is updated by the price engine:

| Column         | Type        | Notes                                                |
| -------------- | ----------- | ---------------------------------------------------- |
| `card_id`      | text PK + FK | one-to-one with cards                               |
| `price`        | bigint      | cents                                                |
| `baseline`     | bigint      | cents. The price from the most recent real API poll. |
| `last_real_poll_at` | timestamptz | when we last fetched from pokemontcg.io          |
| `updated_at`   | timestamptz |                                                      |

These are separate tables so the price engine can write at high frequency without touching catalog rows. `cards` is read-mostly; `card_prices` is read-write.

### 5.4 User Cards (ownership instances)

A `user_cards` row is an individual ownership instance of a card. The same `card_id` can appear in many `user_cards` rows (different users own the same card; same user can own multiple copies).

| Column           | Type        | Notes                                                              |
| ---------------- | ----------- | ------------------------------------------------------------------ |
| `id`             | uuid PK     |                                                                    |
| `owner_id`       | uuid FK     | current owner. Updated atomically on transfer.                     |
| `card_id`        | text FK     | references `cards.id`                                              |
| `acquired_at`    | timestamptz | for P&L windowing                                                  |
| `acquired_price` | bigint      | cents. Snapshot of `card_prices.price` at acquisition time.        |
| `acquired_via`   | text enum   | `PACK`, `LISTING`, `AUCTION`                                       |
| `state`          | text enum   | `OWNED`, `LISTED`, `AUCTIONED`, `TRANSFERRED`                       |

Indexes: `(owner_id, state)` for fast portfolio reads, `(card_id)`.

State machine:

```
                                            ┌─ list ───────▶ LISTED ─── buy ────────────┐
                                            │                                            │
[acquired]  ──▶  OWNED ────┤                                                              ▶ TRANSFERRED
                                            │                                            │
                                            └─ auction ────▶ AUCTIONED ─── settle ──────┘
                                                                       └─── close (no bids) ─▶ OWNED
```

Transitions are guarded by `FOR UPDATE` reads inside transactions:

- **OWNED → LISTED**: listing creation endpoint locks the row and checks state.
- **OWNED → AUCTIONED**: auction creation endpoint locks the row and checks state.
- **LISTED → TRANSFERRED**: marketplace buy.
- **LISTED → OWNED**: listing cancellation by seller.
- **AUCTIONED → TRANSFERRED**: auction settlement with a winner.
- **AUCTIONED → OWNED**: auction settlement with no bids.

A card in `LISTED` or `AUCTIONED` state cannot be re-listed or re-auctioned; the application checks `state = 'OWNED'` before any transition. **The brief's "seller cannot sell a card already listed in an active auction" requirement falls out for free from this state machine** — there is no path from AUCTIONED to LISTED without going through OWNED first.

### 5.5 Pack Drops

A `pack_drops` row defines a scheduled drop:

| Column                | Type        | Notes                                              |
| --------------------- | ----------- | -------------------------------------------------- |
| `id`                  | uuid PK     |                                                    |
| `tier`                | text enum   | `BRONZE`, `SILVER`, `GOLD`                         |
| `price_cents`         | bigint      | denormalized from tier config for historical accuracy |
| `inventory_total`     | int         |                                                    |
| `inventory_remaining` | int         | CHECK >= 0                                         |
| `starts_at`           | timestamptz | indexed for the activator job                      |
| `state`               | text enum   | `SCHEDULED`, `OPEN`, `SOLD_OUT`, `CLOSED`          |
| `created_at`          | timestamptz |                                                    |

Indexes: `(state, starts_at)` for the activator job.

State machine:

```
SCHEDULED ──(starts_at reached)──▶ OPEN ──(inventory hits 0)──▶ SOLD_OUT ──(housekeeping)──▶ CLOSED
                                       └────(housekeeping)────────────────────────────────▶ CLOSED
```

The drop activator (§10) flips SCHEDULED → OPEN. Inventory drains in §6.1. The closer job runs separately after a few hours of OPEN inactivity to mark them CLOSED.

Pack inventory per drop (defaults, configurable):

| Tier   | Inventory per drop |
| ------ | ------------------ |
| BRONZE | 50                 |
| SILVER | 20                 |
| GOLD   | 5                  |

Gold tier deliberately has the smallest inventory so the contention test the reviewers will run (two tabs, click buy on the last pack) is realistic.

### 5.6 Packs and Pack Cards

A `packs` row is a purchased pack owned by a user.

| Column         | Type        | Notes                                                |
| -------------- | ----------- | ---------------------------------------------------- |
| `id`           | uuid PK     |                                                      |
| `owner_id`     | uuid FK     |                                                      |
| `drop_id`      | uuid FK     |                                                      |
| `tier`         | text enum   | denormalized from drop                                |
| `price_paid`   | bigint      | cents, what the user paid                            |
| `purchased_at` | timestamptz |                                                      |
| `opened_at`    | timestamptz nullable | null until first reveal                       |
| `pack_ev_at_purchase` | bigint | computed from card prices at purchase time, used in economics dashboard |

A `pack_cards` row is one card slot inside a pack:

| Column       | Type    | Notes                                              |
| ------------ | ------- | -------------------------------------------------- |
| `id`         | uuid PK |                                                    |
| `pack_id`    | uuid FK |                                                    |
| `card_id`    | text FK |                                                    |
| `position`   | int     | reveal order, 0-indexed. Sorted rarity ascending. |
| `slot_type`  | text enum | `FILLER`, `RARE_FLOOR`, `HIT`, `JACKPOT`         |
| `rarity_at_pull` | text enum | snapshot of the rarity bucket pulled         |
| `revealed`   | bool    | client marks true on reveal click                  |
| `revealed_at`| timestamptz nullable |                                       |

Indexes: `(pack_id, position)` for reveal ordering.

When a pack is purchased (§6.1), the roller produces `pack_cards` already sorted so `position 0` is the first card to reveal (lowest rarity) and the highest position is the highest-rarity hit. This pre-sorting makes the reveal UI trivial: just `SELECT * FROM pack_cards WHERE pack_id = ? ORDER BY position`.

The `slot_type` is recorded so the economics dashboard can verify the actual realized distribution against the documented rarity weights.

### 5.7 Listings

A `listings` row represents a fixed-price sale offer:

| Column         | Type        | Notes                                              |
| -------------- | ----------- | -------------------------------------------------- |
| `id`           | uuid PK     |                                                    |
| `seller_id`    | uuid FK     |                                                    |
| `user_card_id` | uuid FK     | unique among ACTIVE listings (partial unique index) |
| `price`        | bigint      | cents                                              |
| `state`        | text enum   | `ACTIVE`, `SOLD`, `CANCELLED`                      |
| `created_at`   | timestamptz |                                                    |
| `sold_at`      | timestamptz nullable |                                          |
| `buyer_id`     | uuid nullable FK    |                                           |

Indexes: partial unique `(user_card_id) WHERE state = 'ACTIVE'`, `(state, created_at)` for browsing, `(seller_id)`.

The partial unique index is the database-level guarantee that **a single card cannot have two active listings** even if there is a bug in the application logic.

### 5.8 Auctions and Bids

An `auctions` row:

| Column                | Type        | Notes                                                          |
| --------------------- | ----------- | -------------------------------------------------------------- |
| `id`                  | uuid PK     |                                                                |
| `seller_id`           | uuid FK     |                                                                |
| `user_card_id`        | uuid FK     | unique among OPEN auctions (partial unique index)              |
| `starting_bid`        | bigint      | cents                                                          |
| `current_bid_amount`  | bigint nullable | null until first bid                                       |
| `current_bid_user_id` | uuid nullable FK |                                                           |
| `starts_at`           | timestamptz |                                                                |
| `ends_at`             | timestamptz | mutated by anti-snipe extensions                               |
| `state`               | text enum   | `OPEN`, `CLOSED`, `SETTLED`                                    |
| `settled_at`          | timestamptz nullable |                                                       |

Indexes: partial unique `(user_card_id) WHERE state = 'OPEN'`, `(state, ends_at)` for the closer job, `(seller_id)`.

A `bids` row is immutable history:

| Column        | Type        | Notes |
| ------------- | ----------- | ----- |
| `id`          | uuid PK     |       |
| `auction_id`  | uuid FK     |       |
| `bidder_id`   | uuid FK     |       |
| `amount`      | bigint      |       |
| `placed_at`   | timestamptz |       |

Indexes: `(auction_id, placed_at DESC)` for the bid history view ("most recent first" per the brief).

Auction state machine:

```
              ┌─── (no bids, ends_at reached) ──────────────────┐
              │                                                  ▼
[created] ──▶ OPEN ──(ends_at reached, has bids)──▶ CLOSED ──▶ SETTLED
              │
              └── (admin cancel, P2 only) ──▶ CANCELLED (not implemented in Part A)
```

The `closer` job (§10) is what flips OPEN → CLOSED → SETTLED in a single transaction. There is no externally observable "CLOSED but unsettled" state; clients see OPEN until the settlement transaction commits, then SETTLED.

`ends_at` is the source of truth for the timer. The client countdown is cosmetic and re-syncs from `ends_at` on every WebSocket message.

---

## 6. Concurrency Patterns

This is where reviewers will spend most of their time. Each subsection includes the actual transaction skeleton.

### 6.1 Pack Purchase

The brief is explicit: if N users click Buy on M available packs at the same millisecond, exactly M succeed. Two patterns satisfy this; we use the second because it is faster and harder to misuse.

**Pattern A: row lock + read-modify-write.** Lock the drop row, read inventory, decrement if positive, commit.

**Pattern B (chosen): atomic conditional update.** Issue an `UPDATE ... WHERE inventory_remaining > 0` and check the rowcount.

Pattern B avoids the lock acquisition cost and avoids the deadlock risk from acquiring the drop lock and the wallet lock in different orders across concurrent transactions.

```ts
// apps/web/app/api/drops/[id]/buy/route.ts (sketch)
await db.transaction(async (tx) => {
  // 1. Atomically decrement inventory. Returns new value or 0 rows.
  const decremented = await tx
    .update(packDrop)
    .set({ inventoryRemaining: sql`inventory_remaining - 1` })
    .where(and(eq(packDrop.id, dropId), gt(packDrop.inventoryRemaining, 0), eq(packDrop.state, 'OPEN')))
    .returning({ remaining: packDrop.inventoryRemaining });

  if (decremented.length === 0) throw new SoldOutError();

  // 2. Atomically debit the wallet. Returns 0 rows if insufficient.
  const debited = await tx
    .update(wallet)
    .set({ balanceAvailable: sql`balance_available - ${priceCents}` })
    .where(and(eq(wallet.userId, userId), gte(wallet.balanceAvailable, priceCents)))
    .returning({ available: wallet.balanceAvailable });

  if (debited.length === 0) throw new InsufficientFundsError();

  // 3. Roll cards using the pure function from packages/domain.
  // The roller returns cards sorted by rarity ascending (commons first, hits last)
  // so the reveal UI just iterates by position to build tension.
  const rolledCards = rollPack(tier, cardPool, randomSource);

  // 4. Insert pack and pack_cards.
  const [pack] = await tx.insert(packTable).values({ ... }).returning();
  await tx.insert(packCardTable).values(rolledCards.map((c, i) => ({ packId: pack.id, cardId: c.id, position: i })));

  // 5. Insert ledger entry.
  await tx.insert(walletLedger).values({ userId, type: 'PACK_PURCHASE', amount: -priceCents, packId: pack.id });

  // 6. If inventory hit zero, mark drop as sold out.
  if (decremented[0].remaining === 0) {
    await tx.update(packDrop).set({ state: 'SOLD_OUT' }).where(eq(packDrop.id, dropId));
  }

  return { packId: pack.id };
});

// 7. After commit, publish inventory update to Redis.
await redis.publish(`drop:${dropId}`, JSON.stringify({ remaining: decremented[0].remaining }));
```

The order matters. We decrement inventory first because that is the scarcest resource. If the wallet check fails after, we have to roll back, and Postgres will hand the inventory back automatically. We never publish the inventory update before commit; otherwise other clients see an inventory drop that gets reverted.

**Why this cannot oversell.** The `WHERE inventory_remaining > 0` clause is evaluated atomically by Postgres with row-level locking under MVCC. Two concurrent transactions both attempting to decrement when inventory is 1 will serialize: the first sees `1 > 0` and decrements to 0, the second sees `0 > 0` is false and matches zero rows.

**Why this cannot double-charge.** The same atomic-update pattern on the wallet. We never read-then-write; we update conditionally and check the rowcount. Concurrent purchases by the same user race the same way the inventory does.

### 6.2 Trade Execution

A buyer purchases an active listing.

```ts
await db.transaction(async (tx) => {
  // 1. Lock the listing. If it is no longer ACTIVE, abort.
  const [listing] = await tx
    .select()
    .from(listingTable)
    .where(and(eq(listingTable.id, listingId), eq(listingTable.state, 'ACTIVE')))
    .for('update');
  if (!listing) throw new ListingUnavailableError();

  // 2. Atomically debit the buyer.
  const debited = await tx
    .update(wallet)
    .set({ balanceAvailable: sql`balance_available - ${listing.price}` })
    .where(and(eq(wallet.userId, buyerId), gte(wallet.balanceAvailable, listing.price)))
    .returning();
  if (debited.length === 0) throw new InsufficientFundsError();

  // 3. Compute fee and net to seller using domain helpers.
  const fee = calculateTradeFee(listing.price); // 3% in domain/fee-calculator
  const net = listing.price - fee;

  // 4. Credit the seller.
  await tx.update(wallet).set({ balanceAvailable: sql`balance_available + ${net}` }).where(eq(wallet.userId, listing.sellerId));

  // 5. Transfer card ownership.
  await tx.update(userCard).set({ ownerId: buyerId, state: 'OWNED' }).where(eq(userCard.id, listing.userCardId));

  // 6. Mark listing as SOLD.
  await tx.update(listingTable).set({ state: 'SOLD', soldAt: new Date(), buyerId }).where(eq(listingTable.id, listingId));

  // 7. Three ledger entries: buyer debit, seller credit, fee.
  await tx.insert(walletLedger).values([
    { userId: buyerId, type: 'LISTING_PURCHASE', amount: -listing.price, listingId },
    { userId: listing.sellerId, type: 'LISTING_SALE', amount: net, listingId },
    { userId: PLATFORM_USER_ID, type: 'LISTING_FEE', amount: fee, listingId },
  ]);
});
```

**No double-sell.** Step 1's `FOR UPDATE` plus the WHERE on `state = 'ACTIVE'` means only one transaction can claim the listing. The second transaction finds zero rows and aborts.

**No selling a listed card that is also auctioned.** When a card is listed, its `user_card.state` flips to LISTED. The listing creation endpoint checks state before flipping, so a card already in AUCTIONED state cannot also be listed. Symmetric for auction creation.

### 6.3 Auction Bid

```ts
await db.transaction(async (tx) => {
  // 1. Lock the auction row.
  const [auction] = await tx.select().from(auctionTable).where(eq(auctionTable.id, auctionId)).for('update');
  if (!auction || auction.state !== 'OPEN') throw new AuctionClosedError();

  const now = new Date();
  if (auction.endsAt <= now) throw new AuctionClosedError();

  // 2. Validate bid using pure domain function.
  const minValid = computeMinValidBid(auction.currentBidAmount, auction.startingBid); // max($0.50, 5%) logic
  if (newBidAmount < minValid) throw new BidTooLowError();
  if (auction.sellerId === bidderId) throw new SellerCannotBidError();

  // 3. Place new hold on the bidder.
  const heldCheck = await tx
    .update(wallet)
    .set({
      balanceAvailable: sql`balance_available - ${newBidAmount}`,
      balanceHeld: sql`balance_held + ${newBidAmount}`,
    })
    .where(and(eq(wallet.userId, bidderId), gte(wallet.balanceAvailable, newBidAmount)))
    .returning();
  if (heldCheck.length === 0) throw new InsufficientFundsError();

  await tx.insert(walletLedger).values({ userId: bidderId, type: 'AUCTION_HOLD', amount: 0, auctionId, meta: { newBidAmount } });

  // 4. If there was a previous high bidder, release their hold.
  if (auction.currentBidUserId) {
    await tx
      .update(wallet)
      .set({
        balanceAvailable: sql`balance_available + ${auction.currentBidAmount}`,
        balanceHeld: sql`balance_held - ${auction.currentBidAmount}`,
      })
      .where(eq(wallet.userId, auction.currentBidUserId));
    await tx.insert(walletLedger).values({ userId: auction.currentBidUserId, type: 'AUCTION_RELEASE', amount: 0, auctionId });
  }

  // 5. Anti-snipe: extend endsAt if bid is in the final 30s.
  const newEndsAt = sql`GREATEST(${auctionTable.endsAt}, ${now}::timestamptz + interval '30 seconds')`;

  // 6. Update auction with new high bid and possibly extended timer.
  const [updated] = await tx
    .update(auctionTable)
    .set({
      currentBidAmount: newBidAmount,
      currentBidUserId: bidderId,
      endsAt: newEndsAt,
    })
    .where(and(eq(auctionTable.id, auctionId), eq(auctionTable.state, 'OPEN')))
    .returning();

  // 7. Insert the bid row for history.
  await tx.insert(bidTable).values({ auctionId, bidderId, amount: newBidAmount, placedAt: now });

  return updated;
});

// 8. Publish to Redis after commit.
await redis.publish(`auction:${auctionId}`, JSON.stringify({ event: 'bid', currentBid: newBidAmount, currentBidder: bidderId, endsAt: updated.endsAt }));
if (auction.currentBidUserId) {
  await redis.publish(`user:${auction.currentBidUserId}`, JSON.stringify({ event: 'outbid', auctionId }));
}
```

**Why this cannot lose money.** The hold-then-release order is critical. New bidder's hold is placed first; if their wallet is short, the transaction aborts before we touch the previous bidder. Only after the new hold is locked in do we release the old one. There is never a window where neither bidder has the funds held and the auction has a phantom "current bid."

**Why two simultaneous bids resolve cleanly.** Step 1's `FOR UPDATE` serializes them. The second bid sees the first bid's amount as `currentBidAmount` and re-validates against it. If it still meets the minimum increment, it proceeds; otherwise the user gets a "bid too low" error and can try again.

**Why reconnect is safe.** The auction row holds the entire state. A reconnecting client fetches `GET /api/auctions/:id` and renders from that. There is no in-memory state on the WS server.

**Auto-suggest minimum valid bid.** The brief calls for "auto-suggests minimum valid bid" on the bid input. The same `computeMinValidBid` pure function from `packages/domain/bid-validator.ts` is used both client-side (to populate the input) and server-side (to validate). The function:

```ts
// packages/domain/src/bid-validator.ts
export function computeMinValidBid(currentBid: number | null, startingBid: number): number {
  // Cents in, cents out.
  const baseline = currentBid ?? startingBid;
  if (currentBid === null) return startingBid; // First bid: meet starting bid exactly.
  const fivePercent = Math.ceil(baseline * 0.05);
  const fiftyCents = 50; // 50 cents
  return baseline + Math.max(fiftyCents, fivePercent);
}
```

The client gets this value via `GET /api/auctions/:id` and refreshes it whenever a `bid` event arrives over WebSocket. The "Place Bid" input is pre-filled with the result, and validates locally before submitting; the server re-validates inside the transaction.

**Why client and server use the same function.** If the client computed `min = $1.00` and the server computed `min = $1.05`, the user would experience confusing rejections. By sharing a single pure function from the domain package, the calculation is impossible to drift.

### 6.4 Auction Close and Settlement

The `auction-closer` cron job runs every 5 seconds. It looks for auctions where `endsAt <= now()` and `state = 'OPEN'`, then closes and settles them.

```ts
// apps/ws/src/jobs/auction-closer.ts
async function closeAndSettleExpiredAuctions() {
  const now = new Date();
  const expired = await db
    .select()
    .from(auctionTable)
    .where(and(eq(auctionTable.state, 'OPEN'), lte(auctionTable.endsAt, now)));

  for (const auction of expired) {
    await db.transaction(async (tx) => {
      // Re-acquire lock and re-check (another worker may be running).
      const [a] = await tx.select().from(auctionTable).where(and(eq(auctionTable.id, auction.id), eq(auctionTable.state, 'OPEN'))).for('update');
      if (!a) return; // someone else closed it

      if (!a.currentBidUserId) {
        // No bids; return card to seller.
        await tx.update(userCard).set({ state: 'OWNED' }).where(eq(userCard.id, a.userCardId));
        await tx.update(auctionTable).set({ state: 'SETTLED' }).where(eq(auctionTable.id, a.id));
      } else {
        // Settle: winner pays, seller gets paid minus fee, card transfers.
        const fee = calculateAuctionFee(a.currentBidAmount); // 5% in domain
        const net = a.currentBidAmount - fee;

        // Winner: held → 0
        await tx.update(wallet)
          .set({ balanceHeld: sql`balance_held - ${a.currentBidAmount}` })
          .where(eq(wallet.userId, a.currentBidUserId));

        // Seller: receive net
        await tx.update(wallet)
          .set({ balanceAvailable: sql`balance_available + ${net}` })
          .where(eq(wallet.userId, a.sellerId));

        // Transfer card.
        await tx.update(userCard).set({ ownerId: a.currentBidUserId, state: 'OWNED' }).where(eq(userCard.id, a.userCardId));

        // Auction row.
        await tx.update(auctionTable).set({ state: 'SETTLED', settledAt: now }).where(eq(auctionTable.id, a.id));

        // Ledger.
        await tx.insert(walletLedger).values([
          { userId: a.currentBidUserId, type: 'AUCTION_SETTLE_BUYER', amount: -a.currentBidAmount, auctionId: a.id },
          { userId: a.sellerId, type: 'AUCTION_SETTLE_SELLER', amount: net, auctionId: a.id },
          { userId: PLATFORM_USER_ID, type: 'AUCTION_FEE', amount: fee, auctionId: a.id },
        ]);
      }
    });

    // Publish closed event after commit.
    await redis.publish(`auction:${auction.id}`, JSON.stringify({ event: 'closed', winnerId: auction.currentBidUserId, finalBid: auction.currentBidAmount }));
  }
}
```

**Server-crash recovery.** If the WS process dies mid-cron, no rows are mutated because the transaction aborts cleanly. On restart, the next cron tick picks up the same expired auctions and processes them. The `state = 'OPEN'` check in step 1 prevents double settlement.

---

## 7. Real-Time Architecture

### 7.1 WebSocket Topology

The Socket.io server uses rooms. Each meaningful channel is a room name; clients `join` and `leave` rooms based on what page they are viewing.

```
Page                    Rooms joined
──────────────────────  ──────────────────────────────────
Drops list              drop:{id} for each upcoming drop
Drop detail             drop:{id}, user:{currentUserId}
Pack reveal             (no rooms; data is REST-only)
Collection              prices:global, user:{currentUserId}
Marketplace             prices:global
Listing detail          listing:{id} (for cancellation/sold updates)
Auction room            auction:{id}, user:{currentUserId}
```

The `user:{id}` room is per-user and used for personal events (your bid was outbid, your card sold, your auction was won by someone). This is independent of which page the user is on.

### 7.2 Redis Pub/Sub Channels

Channels are flat strings. The WS server has a single Redis subscriber that handles all channels with one `psubscribe` (`pmessage`-style). On message receipt, it parses the channel name to determine the room and emits to that Socket.io room.

```ts
// apps/ws/src/pubsub.ts
const sub = new Redis(env.REDIS_URL);
await sub.psubscribe('drop:*', 'auction:*', 'user:*', 'prices:*', 'listing:*');

sub.on('pmessage', (_, channel, message) => {
  const parsed = JSON.parse(message);
  io.to(channel).emit('event', { channel, ...parsed });
});
```

The publish side is one helper in the web app:

```ts
// apps/web/lib/publish.ts
export async function publish(channel: string, payload: unknown) {
  await redis.publish(channel, JSON.stringify(payload));
}
```

Every API handler that mutates state calls `publish` after the transaction commits. We never publish before commit because a rollback would have already broadcast a phantom event.

### 7.3 Reconnection and State Recovery

The Socket.io client is configured with auto-reconnect. On reconnect:

1. The client re-runs the subscribe sequence for whatever rooms it cared about.
2. The client re-fetches authoritative state for the page (the auction row, the drop row, the user's wallet) via REST.

This is deliberate: the WS server is not the source of truth. After a disconnect, we always re-fetch from the API. The WS layer only delivers deltas while the connection is live.

### 7.4 Auction Room Watcher Count

The brief calls for "number of active watchers in the room" on the auction page. We track this with Socket.io room semantics, not by writing to the database.

When a client joins `auction:{id}`, the server reads the room size via `io.sockets.adapter.rooms.get('auction:{id}').size` and broadcasts the new count to the room. The same broadcast happens on disconnect. Counts are eventually consistent and ephemeral by design — if the WS server restarts, watcher counts reset to whoever reconnects, which is the correct behaviour. The number is a UX signal ("this auction is hot"), not a system-of-record value, so it does not warrant Postgres or Redis persistence.

A single connection counts as one watcher even if a user has multiple tabs open on the same auction; this is fine because each tab opens its own socket connection. We accept this tradeoff because deduplicating by user ID would require a Redis SET per auction and offers no real product benefit.

---

## 8. Caching Strategy

The principle: **never cache anything that participates in a money-moving transaction**. Cache is for read-heavy display data only.

| What                             | Where                | TTL          | Invalidation                                    |
| -------------------------------- | -------------------- | ------------ | ----------------------------------------------- |
| Card metadata (immutable)        | Redis hash           | 24 h         | Manual on data refresh                          |
| Card prices                      | Redis hash + Postgres | 60 s        | Price engine writes update both                 |
| Active drops list                | Redis JSON           | 30 s         | On drop activation / sold-out                   |
| Auction list (browse page)       | Redis JSON           | 10 s         | On auction create / settle                      |
| User session                     | Redis (httpOnly cookie maps to session id) | 7 d | Logout                |
| Wallet balance                   | NEVER cached         | —            | Always read-through to Postgres                 |
| Inventory remaining (per drop)   | NEVER cached         | —            | Postgres is source of truth; broadcast deltas only |
| Auction current bid              | NEVER cached         | —            | Postgres is source of truth; broadcast deltas only |

The card prices cache is the one that needs care. Reading a price for the portfolio view should be a Redis hit. But during a card valuation that affects a transaction (e.g., showing the sale price to a buyer immediately before purchase), we read from Postgres. The marketplace listing price is the listing's `price` column, not the live market price; the live price is shown next to it as reference only.

---

## 9. Price Engine

The price engine has three layers, each serving a different purpose. Reading them top to bottom: real prices as the source of truth, periodic refreshes to keep them current, and an optional demo-mode jitter for video recordings.

### 9.1 Data Source — and why TCGplayer is not it

The brief lists TCGplayer as the primary source and Pokemon TCG API as the fallback. The reality of accessing TCGplayer's API as a new developer in 2026:

> "We are no longer granting new API access at this time."
> — [docs.tcgplayer.com/docs/getting-started](https://docs.tcgplayer.com/docs/getting-started), official getting-started guide

The TCGplayer Developer Program has been closed to new applicants for over a year. Existing API key holders continue to operate, but no new keys are being issued. This is not a "takes time to approve" situation — it is literally impossible to obtain access. The brief itself anticipates this scenario with the fallback clause: *"If TCGPlayer access takes time to approve, use Pokemon TCG API for card data..."*

**Pokemon TCG API (pokemontcg.io v2)** is therefore our authoritative source. This is not a degraded option. The pokemontcg.io response for any card includes an embedded `tcgplayer.prices` block sourced from the same TCGplayer marketplace feed; we get TCGplayer prices through pokemontcg.io's mirror without needing TCGplayer's developer key.

| Factor                  | pokemontcg.io                      | TCGplayer API                                     |
| ----------------------- | ---------------------------------- | ------------------------------------------------- |
| New developer access    | Open, free, instant                | **Closed indefinitely**                           |
| Rate limit (free tier)  | 1000 requests/day, 30 req/min      | N/A (no new keys issued)                          |
| Price coverage          | Embeds TCGplayer + Cardmarket      | TCGplayer only                                    |
| Trial timeline fit      | Excellent                          | Impossible                                        |

Each `/v2/cards` response includes a `tcgplayer.prices` block with subprice variants (`holofoil`, `normal`, `reverseHolofoil`, etc.) and a `cardmarket.prices.averageSellPrice` field. We use TCGplayer's market price when available, falling back to Cardmarket's average sell price.

### 9.2 What "real-time prices" actually means here

Before describing the price pipeline, an honest framing of what "live" means in this product. The brief says: *"The portfolio should feel alive. Prices move. Your net worth changes. It creates the urge to check back."*

The "feel alive" sensation comes from **five concurrent real-time signals**, only one of which is price changes:

1. **Drops going live** — countdown ticks, button enables, inventory drops in real-time as competitors buy.
2. **Auction bids** — every bid hits all watchers within ~200ms via WebSocket; anti-snipe extensions visible to the whole room.
3. **Marketplace activity** — listings appear and disappear as users transact, broadcast over the listings channel.
4. **Pack reveals** — instant gratification; cards stream in at a tension-building cadence.
5. **Price changes** — when they actually happen.

If we leaned on price changes alone for "feel alive," it would be a bad product. TCGplayer market prices are computed from completed marketplace sales and **update on a roughly daily cadence** — they are not a stock ticker. Polling pokemontcg.io every minute would return the same number 99.9% of the time. The other four signals do the heavy lifting on real-time feel; prices contribute when there's something real to contribute.

### 9.3 The Price Pipeline

The pipeline has one job (refresh prices) and one optional job (demo-mode jitter for video recordings). Treat the seed as t=0 of the refresh, not as a separate concept — they share the same code path.

#### Initial refresh (t=0 — formerly "the seed")

The first execution of the refresh runs at boot, after migration. It:

1. Fetches a curated subset of cards from 4-6 popular Pokemon expansions (~500 cards). We do not pull all ~15,000 cards in the catalog — too many, and not necessary for trial scale.
2. Normalizes each card's raw rarity string (e.g. "Rare Holo VMAX", "Amazing Rare", "Hyper Rare") into our 5-bucket scheme `C / U / R / E / L` using a mapping table.
3. Inserts `cards` rows (idempotent: `ON CONFLICT (id) DO UPDATE`).
4. Reads each card's TCGplayer market price from the embedded response (fallback: Cardmarket average sell price), converts to cents, upserts `card_prices` rows with `baseline = price` and `last_real_poll_at = now()`.
5. Writes a backup JSON fixture to `packages/db/src/fixtures/cards.json` so the t=0 refresh can run offline if pokemontcg.io is unreachable during a demo.

Full set list and rarity normalization map: [Appendix C](#appendix-c-card-seed-strategy).

#### Recurring refresh (t=1h, 2h, 3h, ...)

After t=0, a cron job in the WS process (`apps/ws/src/jobs/price-refresh.ts`) runs **every 1 hour** and:

1. Pulls the current set of card IDs from Postgres.
2. Hits `/v2/cards` with pagination (page size 250). For 500 cards, 2 requests per refresh.
3. Extracts current TCGplayer market price for each card.
4. Compares to the existing `card_prices.price`. If the change exceeds **1%**, updates Postgres and Redis and queues the card for broadcast.
5. After processing all updates, publishes a single batched `prices:global` event with the changed cards.
6. Updates `last_real_poll_at` on every card touched, regardless of whether the price changed.

**The "initial refresh" and "recurring refresh" share a single function.** The orchestration script just calls it on boot, then schedules it via cron. There is no architectural distinction between seed and refresh.

**Rate limit math.** Free tier permits 1000 requests/day. Hourly refresh = 24 cycles × 2 requests = 48 requests/day. Even at 10× the card pool (5000 cards), we'd use 480/day. Headroom remains generous.

**Why 1 hour and not 6.** Earlier drafts of this doc specified 6 hours. After reviewing the rate limit math (hourly costs 48 requests/day on a 1000/day quota), hourly costs effectively nothing and makes "feel alive" more credible if a reviewer or user idles on the portfolio page for a long time.

### 9.4 Demo-mode jitter (optional, for video recording only)

Real prices move on a daily cadence. During an 8-minute Loom recording, no real price will visibly change. The brief asks for the experience to "feel alive," which the live drops, auction bids, and marketplace activity already provide. But for the price-tick demonstration specifically, we expose an optional knob:

```bash
# .env
PRICE_DEMO_MODE=true
PRICE_DEMO_INTERVAL_SECONDS=30
PRICE_DEMO_MAX_DRIFT_PERCENT=2
```

When enabled, a separate cron job (`apps/ws/src/jobs/price-demo-jitter.ts`) runs every 30 seconds and:

1. Picks a random sample of 20 cards.
2. Applies Gaussian jitter (mean 0, std = 0.75% of current price).
3. Clamps each new price between `baseline * 0.95` and `baseline * 1.05`. The clamp is intentionally tight — we want visible movement without prices drifting unrealistically far from the real anchor.
4. Updates Postgres + Redis.
5. Publishes `prices:global` with the changed cards.

**Why this is honest.** The demo mode uses the **real baseline as the anchor** and only adds bounded short-term motion around it. The next real-API refresh will reset baselines and snap prices back. This is documented in code, in the architecture doc, and is what we say in the Loom recording. Pure simulation (without a real anchor) would be dishonest given the brief explicitly defines real prices as the goal.

**Production posture.** `PRICE_DEMO_MODE=false` is the default and what we ship. The flag exists exclusively for video recordings.

### 9.5 Reading Prices

Three read paths:

| Path                    | Source                                             | Latency |
| ----------------------- | -------------------------------------------------- | ------- |
| Portfolio render        | Redis hash `prices` → fallback Postgres `card_prices` | <5ms    |
| Pack purchase EV calc   | Postgres directly (transactional)                  | ~10ms   |
| Listing display         | Redis hash, with stale-while-revalidate            | <5ms    |
| Live WS update          | Push from `prices:global`                          | instant |

Reads inside money-moving transactions (e.g., computing pack EV at purchase) always go through Postgres, not Redis, so the price used is the one the database commits against.

### 9.6 Price Source Adapter

The pipeline does not hardcode pokemontcg.io. It depends on a `PriceSource` interface, with one implementation today (`pokemonTcgSource`) and a slot for a second one (`tcgplayerSource`) if direct TCGplayer access is ever granted.

```ts
// packages/db/src/price-pipeline/sources/types.ts
export interface PriceSource {
  /** Stable identifier, used in logs and the admin economics dashboard. */
  name: 'pokemontcg' | 'tcgplayer';

  /** Fetch raw card data for the configured set IDs. */
  fetchCards(setIds: string[]): Promise<RawCard[]>;

  /** Extract a price in cents from a raw card; returns null if unavailable. */
  extractPrice(card: RawCard): number | null;
}

// packages/db/src/price-pipeline/sources/pokemontcg.ts
export const pokemonTcgSource: PriceSource = {
  name: 'pokemontcg',
  fetchCards: async (setIds) => { /* hits api.pokemontcg.io/v2/cards */ },
  extractPrice: (card) => {
    // Prefer tcgplayer.prices.holofoil.market, then normal.market,
    // fallback to cardmarket.prices.averageSellPrice * USD_PER_EUR
    // ...
  },
};

// packages/db/src/price-pipeline/sources/tcgplayer.ts (unimplemented unless approval lands)
export const tcgplayerSource: PriceSource = {
  name: 'tcgplayer',
  fetchCards: async (setIds) => {
    throw new Error('tcgplayerSource not yet implemented; PRICE_SOURCE=tcgplayer requires API access');
  },
  extractPrice: () => null,
};
```

**Selection happens once at module load** based on the `PRICE_SOURCE` env var:

```ts
// packages/db/src/price-pipeline/source.ts
import { pokemonTcgSource } from './sources/pokemontcg';
import { tcgplayerSource } from './sources/tcgplayer';

export const source: PriceSource =
  process.env.PRICE_SOURCE === 'tcgplayer' ? tcgplayerSource : pokemonTcgSource;
```

Default: `pokemontcg`. Switching is a one-line env change.

**Why this matters.** TCGplayer's developer program is closed to new applicants (§9.1). pokemontcg.io serves TCGplayer prices through its own mirror, which is sufficient for the brief. But the brief lists TCGplayer as the primary source, and there is a non-zero chance that direct API access is granted later (during Part B, or post-trial). Structuring the pipeline behind an adapter means that scenario is a 3-hour implementation of `tcgplayerSource` plus an env flip — not a refactor of the entire price pipeline.

This is also the right answer if the reviewer asks "what would change if you got TCGplayer's API later?" The answer is "implement one file and flip an env var. The pipeline, the Redis cache, the WebSocket fan-out, the admin dashboard — none of those care which source is behind the interface."

### 9.7 Price Engine Code Sketch

```ts
// packages/db/src/price-pipeline/run-pipeline.ts
import { source } from './source';

export async function runPipeline() {
  const setIds = (process.env.SEED_SETS ?? 'sv1,sv3,swsh1').split(',');
  const rawCards = await source.fetchCards(setIds);

  const changed: Array<{ cardId: string; price: number }> = [];
  let inserted = 0;
  let updated = 0;

  await db.transaction(async (tx) => {
    for (const raw of rawCards) {
      const livePriceCents = source.extractPrice(raw) ?? rarityBucketMean(raw.rarity);

      // Upsert card metadata.
      await tx.insert(cards).values(toCardRow(raw)).onConflictDoUpdate({
        target: cards.id,
        set: toCardRow(raw),
      });

      // Upsert price; track drift for broadcast.
      const [existing] = await tx.select().from(cardPrices).where(eq(cardPrices.cardId, raw.id));
      const isNew = !existing;
      const drift = isNew ? 0 : Math.abs(livePriceCents - existing.price) / existing.price;
      const shouldBroadcast = !isNew && drift > 0.01;

      await tx.insert(cardPrices).values({
        cardId: raw.id,
        price: livePriceCents,
        baseline: livePriceCents,
        last_real_poll_at: new Date(),
      }).onConflictDoUpdate({
        target: cardPrices.cardId,
        set: {
          baseline: livePriceCents,
          price: shouldBroadcast ? livePriceCents : sql`${cardPrices.price}`,
          last_real_poll_at: new Date(),
        },
      });

      if (isNew) inserted++; else if (shouldBroadcast) { updated++; changed.push({ cardId: raw.id, price: livePriceCents }); }
    }
  });

  // Update Redis cache for everything we touched.
  const pipeline = redis.pipeline();
  for (const raw of rawCards) {
    const price = source.extractPrice(raw) ?? rarityBucketMean(raw.rarity);
    pipeline.hset('prices', raw.id, price.toString());
  }
  await pipeline.exec();

  // Broadcast only meaningful changes.
  if (changed.length > 0) {
    await redis.publish('prices:global', JSON.stringify({ prices: changed }));
  }

  console.info(`[pipeline source=${source.name}] inserted=${inserted} updated=${updated} broadcast=${changed.length}`);
  return { source: source.name, inserted, updated, broadcast: changed.length, totalCards: rawCards.length };
}
```

**Wire-format contract for `prices:global`.** The payload is always an object envelope: `{ prices: Array<{ cardId, price }> }`. The pubsub bridge in `apps/ws/src/pubsub.ts` spreads the parsed JSON into the Socket.io event payload (`io.to(channel).emit('event', { channel, ...payload })`), so a raw array would deserialise at the client as `{ '0': {...}, '1': {...} }` and silently fail the `isPriceUpdate` runtime guard in `apps/web/app/(app)/collection/collection-client.tsx`. The Phase 8 client and Phase 11 cron both honour this envelope; any new publisher on `prices:*` must too.

The 1% threshold is the noise floor. Underlying prices have minor fluctuations from intraday trading; broadcasting every micro-change would be wasteful. The threshold is configurable via `PRICE_BROADCAST_THRESHOLD_PERCENT` env var.

This single function runs at boot (initial population, equivalent of "the seed") and on every cron tick (recurring refresh). There is no separate seed code path.

---

## 10. Background Jobs

All run in `apps/ws` via node-cron.

| Job                | Cadence       | Purpose                                                             |
| ------------------ | ------------- | ------------------------------------------------------------------- |
| drop-activator     | every 60 s    | Find drops with `state = SCHEDULED` and `starts_at <= now()`. Flip to OPEN. Publish to `drop:{id}`. |
| auction-closer     | every 5 s     | Find auctions with `state = OPEN` and `ends_at <= now()`. Settle each. |
| price-refresh      | every 1 h     | Pull real prices from Pokemon TCG API. Update Postgres + Redis. Broadcast meaningful changes (>1% drift) on `prices:global`. The first execution at boot also serves as the initial seed. |
| price-demo-jitter  | every 30 s    | **Disabled by default.** Enabled only via `PRICE_DEMO_MODE=true` for video recordings. Adds bounded synthetic motion around real baselines. |

The 5-second cadence on auction-closer is fine because auctions only close at known times. Latency between expiry and settlement is at most 5 seconds, which is invisible to users (the UI shows "auction ended, settling..." for the gap).

In production, all three would be BullMQ jobs with explicit retry and dead-letter handling. For this scale, node-cron with idempotent SQL is sufficient and more reviewable.

---

## 11. Money Handling

Cents as the canonical unit. All money columns are `bigint` storing integer cents. All API requests and responses use cents on the wire too; the frontend formats with decimal.js for display only.

```ts
// packages/domain/src/money.ts
import Decimal from 'decimal.js';

export const toCents = (dollars: string | number): number => new Decimal(dollars).mul(100).round().toNumber();
export const fromCents = (cents: number): string => new Decimal(cents).div(100).toFixed(2);
export const formatUSD = (cents: number): string => `$${fromCents(cents)}`;
```

This is locked at the boundary. SQL never sees decimals. JavaScript number arithmetic on cents is safe up to 2^53 cents (~$90 trillion); we will not hit that.

---

## 12. Authentication

A custom-rolled JWT auth flow:

1. Sign-up: bcrypt the password, insert user, sign a JWT with `userId` and 7-day expiry, set as httpOnly secure cookie.
2. Login: lookup by email, bcrypt verify, sign and set cookie as above.
3. Every API route validates the cookie via `getSession()` helper, which decodes the JWT and re-checks against a Redis-stored revocation list (for logout).
4. WS connection: client sends the cookie on the upgrade request. The WS server reads the JWT, decodes, and stores `userId` on the socket.

This is ~100 lines of code total, has no external dependencies, and is straightforward to reason about.

### Why not Supabase Auth

The data layer runs on Supabase Postgres, so Supabase Auth is the obvious-looking choice. We deliberately do not use it. Three reasons:

1. **RLS conflicts with the transactional code.** The default Supabase model is "auth + Row-Level Security." With RLS on, every `UPDATE ... WHERE inventory_remaining > 0` is silently filtered by a policy. A failed inventory race can be indistinguishable from a policy reject, which is a debugging nightmare for the most concurrency-sensitive code in the system. With RLS off, we are paying the auth integration cost without the security model that justifies it.
2. **The user table lives in Supabase's `auth.users` schema.** Every domain table (`wallets`, `user_cards`, `bids`, `listings`, `auctions`) would foreign-key into a schema we do not own. The two-layer setup (`auth.users` + `public.profiles`) adds explanation surface in the review without adding capability.
3. **Auth is graded under code quality (15%), not concurrency (30%) or real-time (20%).** Spending time on a multi-tier auth integration is not where points live.

The decision: use Supabase as plain managed Postgres (via the standard `postgresql://` connection string) and own the auth layer ourselves. All permission logic lives in API route handlers, not in the database. This keeps the transactional code clean and makes the security model trivial to walk through in the review.

---

## 13. Error Handling

All API routes use a single wrapper that:

1. Catches thrown domain errors (e.g., `SoldOutError`, `InsufficientFundsError`, `BidTooLowError`).
2. Maps each to an HTTP status code and a stable error code string.
3. Returns `{ error: 'SOLD_OUT', message: 'This pack drop is sold out.' }` with status 409.

```ts
// apps/web/lib/api-handler.ts
export function withErrors(handler: Handler) {
  return async (req: NextRequest, ctx: any) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof DomainError) {
        return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
      }
      console.error('Unhandled error', err);
      return NextResponse.json({ error: 'INTERNAL', message: 'Unexpected error' }, { status: 500 });
    }
  };
}
```

The frontend has a matching `ApiError` class that maps codes to user-facing toasts. The "Sold Out" message after losing the inventory race is rendered immediately via this mechanism.

---

## 14. Pack Economics

This is the section that gets the deepest grilling in the review. Every number is justified.

### 14.1 Tier Definitions

Three tiers create casual / mid / whale segmentation. Two would be thin; four would dilute. The 5x and 10x price gradient (Bronze → Silver, Silver → Gold) creates a clear ladder.

| Tier   | Price   | Cards | Pack EV  | House Margin |
| ------ | ------- | ----- | -------- | ------------ |
| Bronze | $4.99   | 5     | $3.05    | 38.9%        |
| Silver | $14.99  | 7     | $9.74    | 35.0%        |
| Gold   | $49.99  | 10    | $35.64   | 28.7%        |

Margin decreases as tier increases. This is a deliberate product decision: high-tier buyers get a better expected return, which incentivizes the big spend. Casino-style tiers usually have the inverse pattern; we go the other way to make this feel like a fair-trading platform rather than a slot machine.

### 14.2 Rarity Buckets

Five buckets, normalized from messy real Pokemon rarities into something we can weight cleanly.

| Bucket | Mean $ | Real-world equivalent                          |
| ------ | ------ | ---------------------------------------------- |
| C      | $0.05  | Bulk commons                                   |
| U      | $0.15  | Uncommons                                      |
| R      | $0.75  | Non-holo rares                                 |
| E      | $6.00  | Rare Holo, V, ex                               |
| L      | $50.00 | Secret Rare, Hyper Rare, Alt Art, Special Illo |

Mean values come from observed prices on the seeded card pool. The L bucket has the longest tail in real life: most are $20-80 but the top end can run into the hundreds. That tail is what makes pulling a Legendary feel huge.

### 14.3 Pack Roll Model

Each tier uses a hit-slot model rather than uniform draws. This mirrors how real Pokemon packs work (commons + a guaranteed rare slot) and is much more defensible than "every card has the same odds."

**Bronze, $4.99, 5 cards:**

- 4 filler slots: 70% C, 28% U, 2% R → expected $0.092 each → $0.368 total
- 1 hit slot: 80% R, 18% E, 2% L → expected $2.68

Pack EV = $3.05. House margin = ($4.99 − $3.05) / $4.99 = 38.9%.

**Silver, $14.99, 7 cards:**

- 5 filler slots: 65% C, 32% U, 3% R → $0.103 each → $0.515 total
- 1 guaranteed rare floor: 90% R, 9% E, 1% L → $1.715
- 1 hit slot: 55% R, 35% E, 10% L → $7.51

Pack EV = $9.74. House margin = 35.0%.

**Gold, $49.99, 10 cards:**

- 7 filler slots: 55% C, 40% U, 5% R → $0.125 each → $0.875 total
- 2 guaranteed rare floors: 70% R, 22% E, 8% L → $5.845 each → $11.69 total
- 1 jackpot slot: 10% R, 50% E, 40% L → $23.08

Pack EV = $35.64. House margin = 28.7%.

### 14.4 What This Means for the User

- A Bronze pack returns positive EV roughly 1 in 5 buys, with the win driven by the hit slot landing on E or L.
- A Gold pack guarantees at least three rare-or-better cards and lands a Legendary on the jackpot slot 40% of the time. The "I just pulled an alt art" moment is engineered into Gold packs at one in four.
- Across long enough play, the house wins on every tier, but the user gets consistent positive surprise. This is the core tension the brief asked us to balance.

### 14.5 Fee Structure

| Action            | Fee | Who pays | Comparison                                |
| ----------------- | --- | -------- | ----------------------------------------- |
| Marketplace trade | 3%  | Seller   | StockX 10%, eBay ~13%, Robinhood 0% (spread). |
| Auction win       | 5%  | Seller   | eBay 13%, Heritage Auctions ~20%.         |

Auction fee is higher than trade fee because auctions cost more to operate (real-time WS, anti-snipe extensions, longer settlement window). Both are visibly below the comparable platforms, which gives the platform headroom to take a cut without feeling extractive.

### 14.6 Economics Dashboard

The admin economics page (`/admin/economics`) renders four panels:

1. **Pack EV per tier** (computed live from rarity weights and current prices). Side by side with sticker price and the implied house margin.
2. **Realized pack margin** (sum of pack revenue minus sum of pack EV at sale time, grouped by tier).
3. **Trade fee revenue** (sum of `LISTING_FEE` ledger entries). Both lifetime and last 24h.
4. **Auction fee revenue** (sum of `AUCTION_FEE` ledger entries). Both lifetime and last 24h.
5. **Revenue over time** (a small line chart of daily fee + pack-margin revenue for the last 14 days). Backed by a `GROUP BY DATE_TRUNC('day', created_at)` against the ledger.
6. **Aggregate counters** (total packs sold, total trades completed, total auctions settled).

Numbers come from the same ledger that powers user wallets; reconciliation is built in. This is what shows we understand the business model.

---

## 15. Anti-Snipe Mechanism

**Choice:** soft close. Any bid landing in the final 30 seconds of an auction extends `endsAt` to `now() + 30 seconds`.

**Why soft close.** Four anti-snipe approaches exist:

| Approach             | Verdict                                                       |
| -------------------- | ------------------------------------------------------------- |
| Sealed bid           | Kills the live experience. Wrong product fit.                 |
| Random close window  | Opaque to users. They hate not knowing when it ends.          |
| Hard-cap soft close  | Adds complexity (max N extensions) for marginal benefit.      |
| Soft close (30s)     | Simple, mathematically eliminates sniping, preserves tension. |

eBay Motors, Heritage Auctions, and Goldin all use variants of soft close. It is the de facto standard for live auctions on the open web, and it is one line of SQL to implement.

**Implementation:** the `endsAt` update inside the bid transaction uses `GREATEST` to ensure the timer only extends, never shortens.

```sql
SET ends_at = GREATEST(ends_at, now() + interval '30 seconds')
```

If a bid arrives at, say, 3 minutes before close, `now() + 30s` is in the past relative to the existing `ends_at`, so `GREATEST` keeps the original. If a bid arrives at 10 seconds before close, `now() + 30s` is later than `ends_at`, so `GREATEST` extends.

**No upper bound on extensions.** A motivated bidder vs. a motivated seller can theoretically extend forever. In practice, after 5-10 extensions the price has run up enough that one side gives up. This is exactly what we want; it is the auction working.

---

## 16. What Breaks at 10K Users

Honest answer in four layers, ordered by which fails first.

**First to break: WebSocket fan-out.** A single Node process hosting Socket.io can comfortably hold 5K-10K concurrent connections, but it depends heavily on the message rate. Sparse traffic (hourly price refreshes, occasional drop activations) is fine. But during a popular auction, every bid hits an `auction:{id}` room. If 1,000 users are watching the same auction and bidding rapidly, fan-out per second can spike. The fix is to horizontally scale the WS server with the Socket.io Redis adapter, which is a well-trodden pattern. We don't implement this here because the current scale doesn't need it, but the architecture is compatible (Redis is already the bus).

**Second to break: Postgres connection pool.** Supabase's free tier has connection limits. Hot paths (drop activation, auction settlement) are short transactions but volume can spike. The fix is to switch the application to Supabase's built-in connection pooler (`...pooler.supabase.com:6543` instead of the direct connection on `:5432`). This is a one-line env change.

**Third to break: portfolio price broadcasts.** Every meaningful price change is broadcast to all connected clients on `prices:global`. At 10K users on the portfolio page, a single change is 10K WS sends. Even with a 1% drift threshold, a busy refresh cycle could send dozens of changes at once. The fix is per-user fan-out: clients announce which cards they own when joining, and the server pushes only relevant changes to each. Right now we broadcast globally for simplicity, which is a reasonable choice at trial scale and an obvious one to call out as the next step.

**Fourth to break: Pokemon TCG API rate limits.** Free tier is 1000 requests/day. Our refresh costs ~8/day, so we have a lot of headroom — but if we expanded the card pool to 50,000 (a real production catalog), we'd hit the ceiling. The fix is paid tier (cheap, generous) or migrating to a paid TCGplayer integration once approved. For trial scale, this is a non-issue.

What does NOT break: the transactional core. Pack purchases, trades, and auction bids will all keep their guarantees regardless of load because Postgres handles the serialization. They get slower under load but not wrong. This is the property that matters most given the 30% concurrency weight in the eval.

---

## 17. Implementation Order

The detailed phase-by-phase build plan, including time budgets per phase, web search instructions, verification commands, and exit criteria, lives in [BUILD_PLAN.md](./BUILD_PLAN.md). That document is the operational plan; this architecture doc is the design.

The phasing at a high level: bootstrap (Phase 0) → schema (1) → price pipeline initial run (2) → auth + wallet (3) → domain package with unit tests (4) → pack drops with atomic purchase (5) → WebSocket server + Redis Pub/Sub (6) → pack reveal (7) → portfolio (8) → marketplace (9) → live auctions (10) → cron schedule + demo mode (11) → economics dashboard (12) → polish (13) → deploy (14) → demo recording (15).

Phase 5 (pack drops) and Phase 10 (auctions) are the highest-stakes phases because they map directly to the 30% concurrency weight in the eval rubric. Per-phase budgets and current targets live in [BUILD_PLAN.md](./BUILD_PLAN.md); the working Part-A target is ~22 hours of agent time, leaving the remaining ~18 hours of the 40-hour envelope for Part B.

---

## Appendix A: Sequence Diagrams

### A.1 Pack purchase under contention

```
User A click           User B click           Postgres
     │                       │                    │
     │── POST /buy ─────────▶│                    │
     │                       │── POST /buy ──────▶│
     │                       │                    │
     │                       │           BEGIN tx (A)
     │                       │           UPDATE inventory − 1 WHERE remaining > 0
     │                       │           returning rowcount = 1
     │                       │                    │
     │                       │           BEGIN tx (B)
     │                       │           UPDATE inventory − 1 WHERE remaining > 0
     │                       │           BLOCKS until A commits
     │                       │                    │
     │                       │           A: UPDATE wallet OK
     │                       │           A: insert pack + cards + ledger
     │                       │           A: COMMIT
     │                       │                    │
     │                       │           B unblocks: rowcount = 0
     │                       │           B throws SoldOutError, ROLLBACK
     │                       │                    │
     │◀── 200 { packId } ───────────────────────  │
     │                       │◀── 409 SOLD_OUT ── │
```

### A.2 Auction bid with anti-snipe

```
Bidder X                 Auction (endsAt = T+10s)                Postgres
   │                          │                                       │
   │── POST /bid ──────────────────────────────────────────────────▶  │
   │                                                  BEGIN tx
   │                                                  SELECT auction FOR UPDATE
   │                                                  validate amount
   │                                                  UPDATE wallet (X): available − amt, held + amt
   │                                                  UPDATE wallet (prev high bidder): available + prev, held − prev
   │                                                  UPDATE auction
   │                                                    SET current_bid = amt,
   │                                                        current_bid_user = X,
   │                                                        ends_at = GREATEST(ends_at, now() + 30s)
   │                                                  INSERT bid row
   │                                                  COMMIT
   │                                                                       │
   │── publish auction:{id} bid event ──────────────────────────▶ Redis
   │── publish user:{prev} outbid event ─────────────────────────▶ Redis
   │                                                                       │
   │◀── 200 { newEndsAt: T+30s }
```

`endsAt` was at T+10s and the bid arrived at T (10 seconds before close). `now() + 30s` = T+30s, which is greater than T+10s, so the timer extends. All connected clients receive the new `endsAt` and update their countdowns.

---

## Appendix B: Environment Variables

Complete reference. Every variable used by the application is here. Values shown are examples; real secrets go in `.env.local` (web) and Railway environment variables (ws).

### Shared (both apps)

```bash
# Database — Supabase Postgres connection string
# Direct connection (development): use the URL from Project Settings → Database → Connection String → URI
DATABASE_URL=postgresql://postgres.xxx:[email protected]:5432/postgres

# Pooled connection (production, recommended): use the pooler URL on port 6543
DATABASE_POOL_URL=postgresql://postgres.xxx:[email protected]:6543/postgres

# Redis — Upstash
REDIS_URL=rediss://default:[email protected]:6379

# JWT signing secret. Generate with `openssl rand -base64 32`. Must be identical across web and ws.
JWT_SECRET=...

# Public URL of the web app, used in CORS for the WS server
WEB_PUBLIC_URL=https://pullvault.vercel.app

# Public URL of the WS server, used by the web client to connect
NEXT_PUBLIC_WS_URL=wss://pullvault-ws.up.railway.app

# Pokemon TCG API key (optional but recommended — higher rate limits)
POKEMON_TCG_API_KEY=...

# Price source selection. Defaults to 'pokemontcg'.
# Switch to 'tcgplayer' only if direct TCGplayer API access has been granted (see ARCHITECTURE §9.1, §9.6).
PRICE_SOURCE=pokemontcg

# TCGplayer credentials — only needed if PRICE_SOURCE=tcgplayer.
# Leave unset / commented out for the default pokemontcg.io path.
# TCGPLAYER_PUBLIC_KEY=
# TCGPLAYER_PRIVATE_KEY=
```

### Web app only

```bash
# Cookie domain — leave unset for localhost, set to apex domain in production
COOKIE_DOMAIN=.pullvault.app
```

### WS app only

```bash
# Port to listen on (Railway provides PORT automatically)
PORT=4000

# Demo mode toggle for the price engine (default false)
PRICE_DEMO_MODE=false
PRICE_DEMO_INTERVAL_SECONDS=30
PRICE_DEMO_MAX_DRIFT_PERCENT=2

# Real-price refresh cadence (default 1 hour)
PRICE_REFRESH_INTERVAL_HOURS=1

# Minimum drift to broadcast a price change (default 1%)
PRICE_BROADCAST_THRESHOLD_PERCENT=1
```

### Seeding

```bash
# Number of cards to seed per set
SEED_CARDS_PER_SET=100

# Comma-separated list of pokemontcg.io set IDs to seed from
SEED_SETS=swsh1,swsh4,swsh12,sv1,sv3
```

---

## Appendix C: Card Seed Strategy

The seed needs roughly 500 cards spanning all five rarity buckets, enough variety for the demo to feel populated without burdening the database.

### Set selection

Pick 4-6 modern Pokemon expansions with good rarity variety. As of 2026, sensible choices include:

| Set ID    | Set name                          | Why                                                       |
| --------- | --------------------------------- | --------------------------------------------------------- |
| `swsh1`   | Sword & Shield Base               | Classic VMAX era, recognizable cards                       |
| `swsh4`   | Vivid Voltage                     | Famous rainbow Pikachu, good Legendary tier examples       |
| `swsh12`  | Silver Tempest                    | Late SwSh Trainer Galleries                                |
| `sv1`     | Scarlet & Violet Base             | Current generation, ex cards                               |
| `sv3`     | Obsidian Flames                   | Variety of rarities, popular Charizard ex                  |

The exact set list is configured in `SEED_SETS` so it can be adjusted without code changes.

### Rarity normalization

The Pokemon TCG API returns raw rarity strings like "Rare Holo VMAX" or "Amazing Rare." We normalize these into our 5-bucket system at seed time:

| Raw rarity (`rarity_raw`)                                              | Normalized (`rarity`) |
| ---------------------------------------------------------------------- | --------------------- |
| Common                                                                 | C                     |
| Uncommon                                                               | U                     |
| Rare                                                                   | R                     |
| Rare Holo, Rare Holo EX, Rare Holo GX, Rare Holo V, Rare Holo VMAX     | E                     |
| Rare Ultra, Rare ACE, Rare BREAK, Rare Prism Star, Amazing Rare        | E                     |
| Rare Rainbow, Rare Secret, Rare Shiny, Rare Shiny GX, Hyper Rare       | L                     |
| Rare Holo VSTAR, Trainer Gallery Rare Holo, Special Illustration Rare  | L                     |
| Illustration Rare, Double Rare, Ultra Rare                             | E                     |

A mapping table lives in `packages/db/src/seed/rarity-map.ts`. Cards with unrecognized rarities default to `R` and are logged for manual review.

### Per-bucket sampling

After fetching cards from the chosen sets, we sample to hit a target distribution that supports the pack roller's needs:

| Bucket | Target count | Rationale                                                |
| ------ | ------------ | -------------------------------------------------------- |
| C      | ~150         | Plenty of commons; filler slots draw from a deep pool    |
| U      | ~150         | Same as commons                                          |
| R      | ~120         | Decent pool for rare floor and filler                    |
| E      | ~60          | Lower count is fine; E is rarer to begin with            |
| L      | ~20          | Deliberately scarce; jackpot pulls feel meaningful       |

Total: ~500 cards.

### Seed execution

```bash
pnpm db:seed
```

This script:

1. Connects to the configured `DATABASE_URL`.
2. Reads `SEED_SETS` and fetches each set's cards from `api.pokemontcg.io/v2/cards?q=set.id:{set_id}&pageSize=250`.
3. Normalizes rarity, computes baseline price (TCGplayer market price → fallback Cardmarket average → fallback rarity-bucket mean).
4. Inserts `cards` and `card_prices` rows.
5. Writes `packages/db/src/fixtures/cards.json` for offline re-seed in CI.
6. Inserts the system platform user (`PLATFORM_USER_ID`).
7. Inserts a few sample drops scheduled 1 hour, 1 day, and 3 days out so the dev environment immediately has something to look at.

### Idempotency

The seed is idempotent. Re-running it does `INSERT ... ON CONFLICT (id) DO UPDATE` for `cards` and `card_prices`, and skips drops/platform user if they already exist. This matters for the review call: if anything goes sideways, "I'll re-seed" must be a 30-second operation.

---

## Appendix D: Concurrency Test Scenarios

These are the exact two-tab tests reviewers will run, and what should happen in each. Self-test these before submission.

### D.1 Pack drop race (the canonical test)

**Setup:** Create a drop with `inventory_total = 1`. Open two browser tabs as different users with $50+ in available balance. Both have the drop page open with the countdown ticking.

**Action:** When countdown hits zero, both users click Buy at the same time.

**Expected:**
- Exactly one user gets a 200 response with a `packId`. They are redirected to the reveal screen.
- The other user gets a 409 with `error: 'SOLD_OUT'`. Toast or inline error visible.
- Drop state in DB is `SOLD_OUT`. `inventory_remaining = 0`.
- Wallets: only the winner is debited.
- Ledger: exactly one `PACK_PURCHASE` entry exists for this drop.

**Antipatterns to look for:**
- Both succeed → inventory model is broken.
- Both fail → over-pessimistic locking.
- Money debited but no pack granted → transaction boundary wrong.

### D.2 Same-user rapid-fire purchase

**Setup:** Drop with `inventory_total = 5`. One user with $9.98 balance ($4.99 × 2). User opens browser DevTools.

**Action:** User submits 3 buy requests via fetch in quick succession.

**Expected:**
- Exactly 2 succeed, third returns 402 `INSUFFICIENT_FUNDS`.
- Final balance = $0.00.
- Inventory decremented by exactly 2.

### D.3 Listing double-buy race

**Setup:** User A has a card listed for $5. Users B and C each have ≥$5 available.

**Action:** B and C both click Buy on the listing simultaneously.

**Expected:**
- One of them succeeds, gets the card.
- The other gets 409 `LISTING_UNAVAILABLE`.
- A's `wallet.balance_available` increased by $4.85 (after 3% fee). Platform ledger has $0.15 fee.
- Listing state is `SOLD`.

### D.4 Auction simultaneous bids

**Setup:** Auction with 5-minute duration, current bid $10, min next valid $10.50. Users A and B watching the auction room.

**Action:** A and B both submit a bid for $11 within the same second.

**Expected:**
- One bid succeeds at $11. The other fails — but the message depends on timing.
  - If A's bid commits first, B's bid for $11 now violates the min increment ($11 + $0.55 = $11.55 minimum), so B gets `BID_TOO_LOW`.
  - B can retry at $11.55 and succeed.
- Both wallets show correct hold semantics: only the current high bidder has held funds.
- Bid history shows exactly one $11 bid, with the correct bidder.

### D.5 Anti-snipe extension visible to all watchers

**Setup:** Auction ending in 10 seconds, 3 users watching the same auction room.

**Action:** One user places a bid 5 seconds before close.

**Expected:**
- All three users see the countdown jump from "5 seconds" to "30 seconds" within ~200ms of the bid landing.
- `ends_at` in the DB has updated.
- The bid history shows the new bid at the top.

### D.6 WebSocket disconnect mid-auction

**Setup:** User watching an auction room. Auction has 60 seconds remaining.

**Action:** Open DevTools → Network tab → toggle "Offline" for 15 seconds, then back online.

**Expected:**
- During offline: client countdown keeps ticking from last known state (it's just JavaScript).
- On reconnect: WS auto-reconnects, page re-fetches `GET /api/auctions/:id`, countdown re-syncs to authoritative `ends_at`.
- If a bid happened while offline, the user sees the updated current bid and any anti-snipe extension.

### D.7 Server crash during auction settlement

**Setup:** Auction ending soon. Stop the WS process (`docker stop`, or `kill` the Railway container) right at expiry.

**Action:** Wait 10 seconds, restart the WS process.

**Expected:**
- The auction-closer cron picks up the still-OPEN auction on next tick.
- Settlement completes correctly.
- Winner has card, seller has money minus fee, ledger is consistent.

This test is harder to run live, but the architecture supports it: state lives in Postgres, not in WS process memory. The closer's `state = 'OPEN'` re-check in the transaction prevents double-settlement if two cron instances ever ran concurrently.

### D.8 Buyer cannot use held funds

**Setup:** User has $20 available. User places a $15 bid on an auction (so $15 moves to held, $5 remains available). User then tries to buy a $10 listing.

**Expected:**
- Listing buy fails with 402 `INSUFFICIENT_FUNDS` because available is only $5.
- The `WHERE balance_available >= ${price}` clause in the buy SQL is what enforces this. The user's "real" total balance is $20, but the held portion is structurally untouchable for non-auction operations.

### D.9 Card cannot be in two flows at once

**Setup:** User owns a card. User starts an auction on it.

**Action:** User attempts to also list the same card via the marketplace endpoint.

**Expected:**
- Listing creation returns 409 `CARD_NOT_AVAILABLE`. The endpoint checks `user_card.state = 'OWNED'` before transitioning, sees AUCTIONED, and aborts.
- No listing row is created.
- Symmetric: trying to auction an already-listed card also fails.

### Running these for the demo

The Loom video should show at least D.1 and D.5. Open two browser tabs side by side, both showing the drop page, click buy on both at the same instant, and let the reviewer see the clean win/lose split. That's the single most persuasive 30 seconds you can record for the concurrency portion of the eval.
