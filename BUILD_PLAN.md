# PullVault Build Plan for Claude Code

**Audience:** Claude Code (agentic coding tool).
**Owner:** Abhinav.
**Goal:** Ship Part A of the PullVault work trial in ≤22 hours of agent time, leaving ≥18 hours for Part B.

---

## How To Use This Document

You are Claude Code. You will build the PullVault platform by working through this document phase by phase. This is not a suggestion — it is the build plan. Deviating from the phase order will cause integration breakage.

**Before you write a single line of code, do these three things:**

1. **Read `README.md` end to end.** This is the product description and feature inventory. Internalize it.
2. **Read `ARCHITECTURE.md` end to end.** Pay particular attention to §5 (Domain Model — the schema spec), §6 (Concurrency Patterns — the actual transactional code), §14 (Pack Economics — the EV math), Appendix B (Env Vars), Appendix C (Seed Strategy), Appendix D (Concurrency Test Scenarios). Every numbered section reference in this document points into ARCHITECTURE.md unless prefixed with "README §".
3. **Run the web searches in Phase 0** to ground your knowledge of the current state of every library and platform you're about to use. Your training data is not authoritative on package versions, deployment quirks, or third-party API formats.

After that, start at Phase 0 and work sequentially. Each phase has:

- **Goal** — one sentence describing what done looks like.
- **Web searches** — current-information lookups you must run before starting.
- **Tasks** — ordered work items with specific file paths.
- **Verification** — exact shell commands or test scenarios that must pass before moving on.
- **Exit criteria** — what the user (Abhinav) can run to confirm the phase is done.
- **Common pitfalls** — things that go wrong here, called out in advance.
- **What NOT to do** — over-engineering tangents to avoid.

---

## Global Rules for Claude Code

These apply to every phase. Read them once, then internalize.

### Rule 1 — Web search aggressively at phase boundaries

You have a knowledge cutoff. Library versions, API responses, and deployment platforms have changed since then. **At the start of every phase, run the web searches listed.** If a search returns information that contradicts this build plan, surface it to the user and ask before proceeding. Do not silently work around stale guidance — flag it.

### Rule 2 — Commit per phase, not per task

After completing a phase's exit criteria, make a single git commit with a message like `phase 4: domain package with unit tests`. This gives the user clean checkpoints to review and revert from. Do not make 30 micro-commits.

### Rule 3 — When you don't know, stop and ask

The following situations require you to stop and ask Abhinav, not guess:

- Two equally valid implementation choices that the docs don't decide between
- A test scenario from Appendix D fails and the cause is unclear after 30 minutes of investigation
- A third-party API or platform behaves differently than the docs say
- You discover that ARCHITECTURE.md or README.md is internally inconsistent
- A phase looks like it will exceed its time budget by >50%

When asking, present: (a) what you tried, (b) what failed, (c) two or three options, (d) your recommendation. Don't ask open-ended questions.

### Rule 4 — The transactional code is sacred

Sections §6.1, §6.2, §6.3, §6.4 of ARCHITECTURE.md describe the only acceptable transaction patterns for pack purchase, trade, bid, and settlement. Do not refactor, simplify, or "improve" these. The code sketches in those sections are nearly verbatim what should ship. Reviewers will read this code line by line. If you think you have a better idea, surface it to the user — do not just implement it.

### Rule 5 — Money is integer cents, full stop

There is no path through this codebase where money is stored or transmitted as a float, a decimal in JSON, or a string. Money is `bigint` in Postgres, `number` (representing cents) in TypeScript on the wire, and converted to `Decimal` from decimal.js only at the boundary for arithmetic and display formatting. If you find yourself wanting to send `"$4.99"` over the wire, stop — send `499`.

### Rule 6 — Test the concurrency scenarios as you build

Appendix D of ARCHITECTURE.md contains nine concurrency test scenarios. As you complete each phase, run the relevant scenarios from Appendix D. **Do not finish a phase that introduces a transactional surface without testing its scenario.** Phase 5 must pass D.1 and D.2 before exit. Phase 9 must pass D.3 and D.8. Phase 10 must pass D.4 through D.9. No exceptions.

### Rule 7 — Visual polish is not a goal

The brief says explicitly: "Visual design, animations, and pixel-perfection are NOT weighted heavily." Use Tailwind defaults, plain shadcn/ui components, no custom animations beyond a basic pack-flip. If you find yourself spending time on gradients, hover effects, or layout finesse, stop and move to the next phase. Functional and clean is the bar.

### Rule 8 — Time-boxing per phase

Each phase has a target hour budget. If you exceed the target by 50% (e.g., a 2-hour phase hits the 3-hour mark) and you are not on the final exit criterion, stop and report status to Abhinav. Do not let one phase eat the time budget for the rest of the build.

### Rule 9 — Update the build plan if reality differs

If you discover that this BUILD_PLAN.md is wrong — for example, a library version specified here is unavailable, or a phase ordering creates a deadlock — flag it to Abhinav and propose an update. Do not silently work around it. The plan should match the build.

### Rule 10 — Pending TCGplayer application context

Abhinav has applied to TCGplayer's affiliate program in case it leads to direct API access. The default state is: **TCGplayer is closed, we use pokemontcg.io, and the `sources/tcgplayer.ts` adapter exists only as a stub that throws "not yet implemented."** Do not implement the TCGplayer adapter for real during Part A regardless of what happens with the application. If approval lands during Part A or Part B and Abhinav specifically asks to swap, that is a separate task with its own scope (~3 hours, OAuth client-credentials flow + response shape mapping). The architecture is structured so the swap is one file plus an env var; the rest of the codebase never knows which source is configured. See ARCHITECTURE §9.6.

---

## Tech Stack Lock-In

Use **exactly** these versions and packages. Do not substitute. If something is unavailable when you check (Phase 0 web search), surface it before changing.

```
Node.js               20 LTS (latest 20.x)
pnpm                  9.x
TypeScript            5.x
Next.js               14.x (App Router)
React                 18.x
Tailwind CSS          3.x
shadcn/ui             latest
Drizzle ORM           latest stable
drizzle-kit           latest stable
postgres-js           latest (Drizzle's recommended driver for Postgres)
ioredis               5.x (server-side; not @upstash/redis SDK — we want raw Pub/Sub)
Socket.io             4.x (server) + socket.io-client 4.x (client)
node-cron             3.x
bcryptjs              2.x (NOT `bcrypt` — bcryptjs is pure JS, no native build issues)
jsonwebtoken          9.x
zod                   3.x
decimal.js            10.x
vitest                latest (for domain unit tests)
```

Frontend libraries we are explicitly **not** using: Redux, Zustand, React Query, React Hook Form, NextAuth, Prisma, Sequelize, Knex, Express. Don't add them.

---

# Phase 0 — Project Bootstrap

**Goal:** A pnpm monorepo with the right shape, a clean `.env.example`, and verified library versions. Zero application code yet.

**Time budget:** 1 hour.

## Web searches to run first

1. **`Next.js 14 App Router latest stable version 2026`** — confirm the current minor. App Router has changed cookie handling between minors; you need to know which docs apply.
2. **`Drizzle ORM postgres-js setup 2026`** — confirm the current driver setup. Drizzle's docs change frequently.
3. **`pnpm workspaces TypeScript shared packages 2026`** — confirm current `pnpm-workspace.yaml` syntax and `tsconfig` path mapping for cross-package imports.
4. **`Socket.io v4 vs v5 current stable`** — confirm v4 is still the recommended stable.
5. **`bcryptjs vs bcrypt 2026 serverless`** — confirm bcryptjs is still the preferred choice for Vercel-style serverless deployments (it is, but verify).

If any search returns information that contradicts the Tech Stack Lock-In section above, stop and ask Abhinav.

## Tasks

1. **Initialize the monorepo:**
   ```bash
   mkdir pullvault && cd pullvault
   git init
   pnpm init
   ```
   Create `pnpm-workspace.yaml` with the apps and packages listed in ARCHITECTURE.md §4.

2. **Create the directory skeleton** matching ARCHITECTURE.md §4 exactly:
   ```
   apps/web/, apps/ws/, packages/db/, packages/domain/, packages/shared/
   ```
   Do not create `app/` subfolders inside `apps/web/` yet. Do not create `src/` inside `apps/ws/` yet. Just the empty directories.

3. **Initialize each package** with its own `package.json`:
   - `@pullvault/web` — depends on `@pullvault/db`, `@pullvault/domain`, `@pullvault/shared`
   - `@pullvault/ws` — same dependencies
   - `@pullvault/db` — depends on `@pullvault/shared`
   - `@pullvault/domain` — depends on `@pullvault/shared` only (it must remain pure — no DB, no I/O)
   - `@pullvault/shared` — no internal dependencies

4. **Set up TypeScript:** root `tsconfig.base.json` with strict mode, then per-package `tsconfig.json` extending it. Path mapping so `@pullvault/db` resolves to `packages/db/src/index.ts`.

5. **Install root dev dependencies:**
   - `typescript`, `prettier`, `eslint`, `vitest`, `tsx`

6. **Install per-package dependencies** as specified in Phase 1+ when each package is built. **Do not install everything at once.** Each phase installs what it needs.

7. **Create `.env.example`** at the repo root with every variable from ARCHITECTURE.md Appendix B. Use comments to explain each. Do **not** check in `.env.local` (add to `.gitignore`).

8. **Set up Prettier and ESLint** with reasonable defaults. Don't tune for hours — accept the basic shadcn/Next.js conventions.

9. **Add root `package.json` scripts:**
   ```json
   "dev": "pnpm -r --parallel dev",
   "build": "pnpm -r build",
   "lint": "pnpm -r lint",
   "typecheck": "pnpm -r typecheck",
   "test": "pnpm -r test"
   ```

10. **First commit:** `phase 0: monorepo bootstrap`.

## Verification

```bash
pnpm install
pnpm typecheck   # should succeed (nothing to check yet, but no errors)
pnpm -F @pullvault/domain test   # should report no tests, no errors
ls apps/ packages/   # 2 entries in apps, 3 in packages
```

## Exit criteria

- `pnpm install` runs cleanly.
- `pnpm typecheck` returns 0.
- `git log` shows one commit on `main`.
- `.env.example` exists and is complete.

## Common pitfalls

- **pnpm workspace path mapping.** Cross-package imports must work via TypeScript path mapping, not via published packages. The `tsconfig.base.json` paths and the `pnpm-workspace.yaml` workspaces have to agree.
- **Next.js inside a workspace.** Next.js needs special config to transpile workspace packages. Add `transpilePackages: ['@pullvault/db', '@pullvault/domain', '@pullvault/shared']` to `next.config.js` when you create the web app.
- **Strict TypeScript everywhere.** Don't disable strict mode to get past a type error. Fix the type.

## What NOT to do

- Do not set up Storybook, GitHub Actions, Husky, lint-staged, or any developer ergonomics tooling. Save it for after Part B.
- Do not write a single line of application code in this phase. The goal is shape only.
- Do not configure CI/CD. We deploy manually.

---

# Phase 1 — Database Foundation

**Goal:** Drizzle schema for every table in ARCHITECTURE.md §5, migrations generated and applied to a Supabase Postgres instance, a working `db` client exported from `@pullvault/db`. No domain logic yet.

**Time budget:** 2 hours.

## Web searches to run first

1. **`Supabase Postgres connection string direct vs pooler 2026`** — confirm the current port numbers (5432 direct, 6543 pooled) and the URL formats. Supabase has changed these.
2. **`Drizzle ORM enums postgres latest syntax`** — Drizzle's enum syntax has churned. Confirm the current API for `pgEnum`.
3. **`Drizzle ORM bigint mode number vs bigint 2026`** — bigint columns can be returned as `number`, `bigint`, or `string` depending on driver config. We want `number` because our cents fit in safe integer range. Confirm the config syntax.
4. **`Drizzle ORM partial unique index syntax`** — we need partial unique indexes for listings and auctions per ARCHITECTURE §5.7 and §5.8.

## Tasks

1. **Provision Supabase:** Abhinav has already done this if a `DATABASE_URL` is set in `.env.local`. If not, stop and ask him to create a Supabase project at supabase.com (free tier) and provide the direct + pooler connection strings.

2. **Install Drizzle dependencies in `@pullvault/db`:**
   ```bash
   pnpm -F @pullvault/db add drizzle-orm postgres
   pnpm -F @pullvault/db add -D drizzle-kit
   ```

3. **Create `packages/db/drizzle.config.ts`** pointing at `src/schema.ts` and the `DATABASE_URL` env var.

4. **Create `packages/db/src/schema.ts`** implementing every table from ARCHITECTURE.md §5. Reference the section subnumbers exactly:
   - §5.1 — `users`, `wallets`
   - §5.2 — `wallet_ledger`
   - §5.3 — `cards`, `card_prices`
   - §5.4 — `user_cards` (note the explicit state machine — implement it as a Postgres enum)
   - §5.5 — `pack_drops`
   - §5.6 — `packs`, `pack_cards`
   - §5.7 — `listings` (with the **partial unique index** on `user_card_id WHERE state = 'ACTIVE'`)
   - §5.8 — `auctions` (with the **partial unique index** on `user_card_id WHERE state = 'OPEN'`), `bids`

   Every column type must match the spec table exactly. Use `bigint` with `mode: 'number'` for all money columns. Use `pgEnum` for every enum field. Add CHECK constraints for non-negative balance columns.

5. **Create `packages/db/src/client.ts`:**
   ```ts
   import { drizzle } from 'drizzle-orm/postgres-js';
   import postgres from 'postgres';
   import * as schema from './schema';
   const queryClient = postgres(process.env.DATABASE_URL!);
   export const db = drizzle(queryClient, { schema });
   ```

6. **Create `packages/db/src/index.ts`** that re-exports `db`, `schema`, and useful types (`InferSelectModel`, `InferInsertModel` for each table).

7. **Generate the migration:**
   ```bash
   pnpm -F @pullvault/db drizzle-kit generate
   ```
   This produces a SQL file under `packages/db/drizzle/`. Review it manually. Confirm: every CHECK constraint is present, every partial unique index is present, every enum is created.

8. **Apply the migration:**
   ```bash
   pnpm -F @pullvault/db drizzle-kit push   # or apply via `migrate`
   ```

9. **Smoke test the connection:** create `packages/db/src/__smoke__/connect.ts` that imports `db`, runs `select 1`, and exits. Run with `tsx packages/db/src/__smoke__/connect.ts`.

10. **Commit:** `phase 1: drizzle schema + migrations`.

## Verification

```bash
# From repo root with .env.local set:
pnpm -F @pullvault/db drizzle-kit generate   # produces migration files
pnpm -F @pullvault/db drizzle-kit push       # applies to Supabase
tsx packages/db/src/__smoke__/connect.ts     # prints 1
```

In the Supabase dashboard's Table Editor:
- All 11 tables exist (`users`, `wallets`, `wallet_ledger`, `cards`, `card_prices`, `user_cards`, `pack_drops`, `packs`, `pack_cards`, `listings`, `auctions`, `bids` — that's 12, count carefully).
- Indexes are visible on each table.
- Enum types are created in the `public` schema.

## Exit criteria

- All migrations applied.
- The smoke test connects and queries successfully.
- The schema in the database matches ARCHITECTURE.md §5 column for column.

## Common pitfalls

- **Bigint mode default is string.** If you forget `mode: 'number'`, your money columns return as `string` and arithmetic explodes silently. Set it on every bigint column.
- **Drizzle enum naming.** Postgres enum types are global (per schema). Name them with a `pullvault_` prefix or similar to avoid collisions if you ever share the database.
- **Partial unique indexes.** Drizzle has a specific syntax for these. They are critical for the "no double-listing" guarantee. Verify the SQL output of `drizzle-kit generate` includes `WHERE state = 'ACTIVE'` clauses.
- **CHECK constraints.** Easy to forget. `balance_available >= 0` and `balance_held >= 0` and `inventory_remaining >= 0` are not optional. They are the last line of defense against application bugs.

## What NOT to do

- Do not write seed data yet (Phase 2).
- Do not write any query helpers (`getUserById`, etc.) yet. Those go where they're used.
- Do not enable Row-Level Security on any table.

---

# Phase 2 — Card Catalog + Price Pipeline (Initial Run)

**Goal:** ~500 real Pokemon cards loaded into the `cards` and `card_prices` tables via the **same code path** that will run as an hourly cron in Phase 11. There is no "seed" code separate from "refresh" code — there is one price pipeline, and Phase 2 builds it and runs it for the first time.

**Time budget:** 2 hours.

## Critical context: why this phase is structured this way

Earlier drafts of this plan separated "seed" (Phase 2) from "price refresh" (Phase 11). That was the wrong frame. The seed is just t=0 of the recurring refresh — it inserts when there's nothing in the DB and updates when there is. Building one code path that handles both keeps the system honest and avoids the "seed and refresh drifted apart" bug class.

So in Phase 2, you build the refresh pipeline as a function. You run it once manually. In Phase 11 you wire it into a cron schedule. Same function, two execution contexts.

Also critical: **TCGplayer's API is closed to new developers.** Direct quote from [their getting-started page](https://docs.tcgplayer.com/docs/getting-started): *"We are no longer granting new API access at this time."* This is not a delay you can wait out — it is closed indefinitely. Pokemon TCG API (pokemontcg.io v2) is the source of truth, and it returns TCGplayer prices through its own mirror, so we get the brief's intent without TCGplayer's developer key. ARCHITECTURE.md §9.1 has the full disclosure.

## Web searches to run first

1. **`pokemontcg.io API v2 endpoint format 2026`** — confirm the current base URL (`https://api.pokemontcg.io/v2`), the cards endpoint, the query syntax (`q=set.id:swsh1`), and the page size limits.
2. **`pokemontcg.io API key required 2026`** — confirm whether read access still works without a key (it does, with lower rate limits) and the header format (`X-Api-Key`).
3. **`pokemontcg.io card response tcgplayer cardmarket prices structure`** — fetch one example card and look at the actual `tcgplayer.prices` shape. The subprice keys (`holofoil`, `normal`, `reverseHolofoil`, `1stEditionHolofoil`, etc.) vary per card. Decide which to prefer when computing the price.
4. **`Pokemon TCG popular sets 2026 Scarlet Violet`** — confirm that `sv1`, `sv3`, `sv4`, `sv5` are real set IDs. If newer SV sets exist, prefer them. Do NOT trust the set IDs hardcoded in ARCHITECTURE Appendix C without verification — sets get added.

After verifying the API, **fetch one card directly** to inspect the response shape:
```bash
curl 'https://api.pokemontcg.io/v2/cards?pageSize=1' | jq
```
Look at: `id`, `name`, `set.id`, `set.name`, `number`, `rarity`, `images.large`, `images.small`, `tcgplayer.prices.*.market`, `cardmarket.prices.averageSellPrice`.

If the response shape differs from what ARCHITECTURE.md Appendix C assumes, surface this to Abhinav before proceeding.

## Tasks

1. **Build the price pipeline behind a `PriceSource` adapter interface in `packages/db/src/price-pipeline/`** (per ARCHITECTURE §9.6):
   - `sources/types.ts` — defines the `PriceSource` interface with `name`, `fetchCards(setIds)`, and `extractPrice(rawCard)`. Also defines the `RawCard` shape.
   - `sources/pokemontcg.ts` — implements `PriceSource` against pokemontcg.io. This is the active source.
   - `sources/tcgplayer.ts` — stub implementation that throws "not yet implemented" if called. This file exists so the env switch is wired up if Abhinav's TCGplayer application is ever approved.
   - `source.ts` — exports a single `source: PriceSource` selected at module load based on `process.env.PRICE_SOURCE` (defaults to `pokemontcg`).
   - `rarity-map.ts` — the normalization map from ARCHITECTURE Appendix C §"Rarity normalization." If your web search reveals new rarity strings (newer sets often have new rarity names like "Special Illustration Rare"), add them. Default unknown values to `R` and log them.
   - `sample-by-bucket.ts` — first-run only: samples the fetched cards to hit the per-bucket targets in Appendix C. On subsequent runs, no-op (we only update existing cards' prices, not the catalog).
   - `run-pipeline.ts` — the **single entry point** that uses `source.fetchCards()` and `source.extractPrice()` and never knows which adapter is actually behind them. Does:
     1. Fetch cards via `source.fetchCards(setIds)`.
     2. For each fetched card: upsert `cards` row (`ON CONFLICT (id) DO UPDATE`), upsert `card_prices` row.
     3. On the upsert path: if the card already exists, compare new price vs old price. If drift > 1%, queue for broadcast.
     4. After all upserts: publish the broadcast list to Redis `prices:global` (no-op if the function is being called before Phase 6's Redis is set up).
     5. Update `last_real_poll_at` on every card touched.
     6. Return a structured summary: `{ source, inserted, updated, broadcast, totalCards }`.

   **Why the adapter.** TCGplayer is closed to new applicants today, but Abhinav has applied to their affiliate program in case access opens up. If approval lands during Part A or Part B, swapping to TCGplayer is a 3-hour implementation of `sources/tcgplayer.ts` plus `PRICE_SOURCE=tcgplayer` in env — no other code changes. If approval never comes, `sources/tcgplayer.ts` stays as a stub forever and costs nothing. Either way, the architecture answer in the review call is "implement one file and flip an env var."

2. **Add a CLI entry point at `packages/db/src/price-pipeline/run.ts`:** loads env, calls `run-pipeline.ts`, prints the summary, exits. Wire it as a pnpm script: `"db:pipeline": "tsx src/price-pipeline/run.ts"`. (Keep `db:seed` as an alias to the same script for muscle memory, but they're the same thing.)

3. **Make the pipeline idempotent.** Every write uses `ON CONFLICT DO UPDATE`. Re-running the pipeline must update prices in place, not error or duplicate rows.

4. **Cache the API response to disk** at `packages/db/src/fixtures/cards.json` after the first successful fetch. On subsequent runs, if `SEED_USE_CACHE=true` is set, load from the file instead of hitting the API. This is for offline pipeline runs during the review call if the public API is having a bad day.

5. **Insert the platform user** (system UUID `00000000-0000-0000-0000-000000000001` per ARCHITECTURE §5.2) with a placeholder email and a random unguessable password hash. This user is for ledger entries only — no one ever logs in as it. Run this only on first execution (skip if exists).

6. **Insert sample drops** at the end of the first execution: one BRONZE starting in 2 minutes, one SILVER starting in 1 hour, one GOLD starting in 3 hours. This gives Abhinav something to demo immediately. Make them reseed-safe (skip if a drop with the same `tier + starts_at` already exists). On subsequent pipeline runs, this section is a no-op.

7. **Run the pipeline manually for the first time:**
   ```bash
   pnpm db:pipeline
   ```
   Expected output:
   ```
   [pipeline source=pokemontcg] inserted=500 updated=0 broadcast=0
   Fetched 642 cards from 5 sets
   Sampled to {C: 154, U: 148, R: 122, E: 58, L: 18}
   Inserted 500 cards, 500 prices
   Updated 0 prices (drift > 1%)
   Inserted platform user
   Inserted 3 sample drops
   ```

8. **Run the pipeline a second time** to verify idempotency. Expected:
   ```
   Fetched 642 cards from 5 sets
   Inserted 0 cards, 0 prices
   Updated N prices (drift > 1%)  — N is small or 0 if real prices haven't moved
   Platform user exists, skipping
   Sample drops exist, skipping
   ```

9. **Commit:** `phase 2: price pipeline + initial run`.

## Verification

```bash
pnpm db:pipeline   # first run, populates DB
pnpm db:pipeline   # second run, idempotent no-op (or small price updates)
```

In Supabase Table Editor:
- `cards` table has ~500 rows. Spot-check 5 random rows and confirm `image_url` loads in a browser.
- `card_prices` table has matching rows. Every `price` is > 0. `last_real_poll_at` is recent.
- `users` has the platform user.
- `pack_drops` has 3 rows in `SCHEDULED` state.

## Exit criteria

- 500-ish cards visible in Supabase, balanced across rarity buckets per the targets in Appendix C (verify with `SELECT rarity, COUNT(*) FROM cards GROUP BY rarity`).
- Platform user exists.
- 3 sample drops exist.
- Re-running `pnpm db:pipeline` is idempotent.
- `last_real_poll_at` updates on every card on every run.

## Common pitfalls

- **Rate limiting on first fetch.** With no API key, the limit is tighter. Add a 200ms delay between paginated requests, or get an API key from pokemontcg.io (it's free and instant).
- **Price field absent.** Some cards lack TCGplayer prices entirely (newly added cards, niche promos). The `extractPrice` implementation in `sources/pokemontcg.ts` must return `null` for these, and `run-pipeline.ts` must fall back to a rarity-bucket mean.
- **Cardmarket prices are in EUR.** If you use them, convert at a fixed rate (1 EUR ≈ 1.07 USD is fine for trial purposes — don't fetch a live FX rate).
- **Image URL hotlinking.** pokemontcg.io's image URLs are CDN-served and CORS-friendly. They will work in `<img src>` directly. Do not try to proxy or download them.
- **Building the seed and refresh as separate functions.** Don't. They are the same function. If you find yourself writing two paths, stop and refactor.
- **Hardcoding `import { fetchPokemontcgCards } from ...` in the pipeline.** Don't. The pipeline imports `source` from `./source.ts` and calls `source.fetchCards()` and `source.extractPrice()`. The pipeline never names a specific provider.

## What NOT to do

- Do not pull all 15,000 Pokemon cards. 500 is the target, more wastes pipeline time and DB rows for no benefit.
- Do not fetch prices in a separate step. The card response already includes them.
- Do not write a UI for browsing cards yet (Phase 7).
- Do not wire this into a cron schedule yet (Phase 11). For now, it's a manual command.
- **Do not implement `sources/tcgplayer.ts` for real in this phase.** It stays as a stub that throws "not yet implemented." Real implementation only happens if/when Abhinav's TCGplayer application is approved, and that work is post-Part-A. The whole point of the adapter is that the rest of the codebase doesn't care which source is configured.

---

# Phase 3 — Authentication and Wallet Creation

**Goal:** Sign up, log in, log out, get current user, see wallet balance. New users automatically get a $1,000 signup bonus and a wallet ledger entry.

**Time budget:** 2 hours.

## Web searches to run first

1. **`Next.js 14 App Router cookies httpOnly Route Handler 2026`** — confirm the current API. The `cookies()` helper has stabilized but the import path matters.
2. **`bcryptjs Next.js Vercel serverless 2026`** — confirm bcryptjs works on Vercel's runtime (it does, but verify) and the recommended cost factor (10).
3. **`jsonwebtoken vs jose Next.js App Router`** — `jose` is now the more modern choice and works in edge runtimes. We're on the Node runtime so `jsonwebtoken` is fine, but quickly check whether `jose` has displaced it as the standard.

## Tasks

1. **Install dependencies in `apps/web`:**
   ```bash
   pnpm -F @pullvault/web add bcryptjs jsonwebtoken zod
   pnpm -F @pullvault/web add -D @types/bcryptjs @types/jsonwebtoken
   ```

2. **Create the Next.js app skeleton** if not already done:
   ```bash
   pnpm -F @pullvault/web exec next # initialize App Router structure manually if needed
   ```
   Set up `apps/web/app/layout.tsx`, `globals.css`, `tailwind.config.ts`, `next.config.js` (with `transpilePackages` from Phase 0 pitfall).

3. **Auth helpers in `apps/web/lib/auth.ts`:**
   - `hashPassword(password: string): Promise<string>`
   - `verifyPassword(password: string, hash: string): Promise<boolean>`
   - `signSessionToken(userId: string): string` — JWT with 7-day expiry
   - `verifySessionToken(token: string): { userId: string } | null`
   - `getSessionUser(): Promise<User | null>` — reads cookie, validates JWT, looks up user

4. **API routes:**
   - `POST /api/auth/signup` — Zod-validated body `{ email, password, displayName }`. Inside a transaction: insert user, insert wallet with `balance_available = 100000` (cents = $1,000), insert `wallet_ledger` row with type `SIGNUP_BONUS`. Sign JWT, set httpOnly secure cookie, return user.
   - `POST /api/auth/login` — lookup by email, verify password, sign JWT, set cookie.
   - `POST /api/auth/logout` — clear cookie.
   - `GET /api/auth/me` — return current user from session, or 401.
   - `GET /api/wallet` — return `{ available, held }` from the wallet table for the current user.

5. **Server-side auth guard:** create `apps/web/lib/require-auth.ts` for use inside server components and route handlers. Returns user or throws (which converts to 401 via the error wrapper from §13).

6. **Error handling wrapper** as specified in ARCHITECTURE §13. Implement `withErrors` in `apps/web/lib/api-handler.ts` and use it on every route from here forward.

7. **Minimal UI:** signup page, login page, "logged in as X · $Y available" header. Use Tailwind defaults, plain `<form>` with `onSubmit` (per the artifact rules in your context — though this isn't an artifact, plain HTML forms are fine here for actual Next.js submission).

8. **Commit:** `phase 3: auth + wallet creation`.

## Verification

```bash
pnpm dev
# Open localhost:3000
# Sign up as alice@test.com / password123 / Alice
# Confirm: redirected to dashboard, "Available: $1000.00" visible
# Log out, log back in — same wallet, same balance
# Sign up as bob@test.com — new user, also $1000
```

In Supabase:
- 2 user rows (plus the platform user).
- 2 wallet rows, each with `balance_available = 100000`.
- 2 wallet_ledger rows of type `SIGNUP_BONUS`.

## Exit criteria

- Signup flow works end to end.
- Login persists across page refresh.
- `GET /api/auth/me` returns user when authed, 401 when not.
- The signup transaction is atomic — abort one inside Postgres (e.g. drop the unique constraint, try again, restore) and confirm no partial state can be created.

## Common pitfalls

- **Cookie SameSite.** For local dev across `localhost:3000`, use `SameSite=Lax`. For prod with separate domains for web and ws, you may need `SameSite=None; Secure` so the WS server can read the cookie on upgrade. Document this when you hit it in Phase 6.
- **JWT_SECRET differs between web and ws.** They must be identical. Set it once in `.env.local` and load from there everywhere.
- **Email uniqueness race.** Two signup requests with the same email race. Postgres unique constraint catches this; your code should handle the constraint violation as a 409 not a 500.
- **Password validation.** Use Zod with a sane minimum length (8 chars). Don't go overboard with complexity rules.

## What NOT to do

- Do not implement password reset, email verification, OAuth, or any other auth feature. Email/password is enough.
- Do not implement rate limiting. Out of scope for Part A.
- Do not store JWTs in localStorage. httpOnly cookie or nothing.

---

# Phase 4 — Domain Package (Pure Logic)

**Goal:** Every piece of business logic that doesn't need I/O lives in `@pullvault/domain` as pure, fully unit-tested functions. This is the foundation for Phases 5, 9, and 10.

**Time budget:** 2.5 hours.

## Web searches to run first

1. **`vitest setup TypeScript 2026`** — confirm current config.
2. **`decimal.js bigint conversion safe integer 2026`** — confirm the recommended conversion patterns. Cents fit in safe integer; we want `toCents` to round, not truncate.

## Tasks

This phase has no external dependencies, no DB access, no React. Just pure TypeScript functions and tests.

1. **Install vitest in `@pullvault/domain`:**
   ```bash
   pnpm -F @pullvault/domain add decimal.js
   pnpm -F @pullvault/domain add -D vitest @types/node
   ```

2. **Create `packages/domain/src/money.ts`:**
   - `toCents(dollars: string | number): number`
   - `fromCents(cents: number): string` — returns formatted "X.YZ"
   - `formatUSD(cents: number): string` — returns "$X.YZ"

3. **Create `packages/domain/src/tier-config.ts`:**
   - The full tier config from ARCHITECTURE §14.3, encoded as a typed const:
     ```ts
     export const TIER_CONFIG = {
       BRONZE: {
         priceCents: 499,
         cardCount: 5,
         slots: [
           { type: 'FILLER', count: 4, weights: { C: 0.70, U: 0.28, R: 0.02, E: 0, L: 0 } },
           { type: 'HIT',    count: 1, weights: { C: 0,    U: 0,    R: 0.80, E: 0.18, L: 0.02 } },
         ],
       },
       SILVER: { /* ... per §14.3 ... */ },
       GOLD:   { /* ... per §14.3 ... */ },
     } as const;
     ```
   - Verify the weights for each slot sum to 1.0. Add a unit test for this.

4. **Create `packages/domain/src/pack-roller.ts`:**
   - `rollPack(tier, cardPool, rng): RolledCard[]` — deterministic given `rng`. Returns cards sorted by rarity ascending (commons first, hits last) per §5.6 and §6.1.
   - `RolledCard` type includes `cardId`, `rarity`, `slotType`.
   - The `rng` parameter is a function `() => number` returning [0, 1). Default to `Math.random`. The tests pass a seeded RNG for reproducibility.
   - The `cardPool` is `Array<{ id: string; rarity: 'C' | 'U' | 'R' | 'E' | 'L' }>`.

5. **Create `packages/domain/src/ev-calculator.ts`:**
   - `computeTierEV(tier, priceMap): { ev: number; margin: number }` — `priceMap` is `Record<rarity, meanPriceCents>`. Returns expected pack value and house margin percentage.
   - This is the function the economics dashboard calls.

6. **Create `packages/domain/src/bid-validator.ts`:**
   - `computeMinValidBid(currentBid: number | null, startingBid: number): number` — exact logic from ARCHITECTURE §6.3 explanation.
   - `validateBid(currentBid, startingBid, newBid): { ok: true } | { ok: false; reason: 'TOO_LOW' | 'TOO_HIGH' }` — the second variant catches bids above 100x current bid as a fat-finger guard.

7. **Create `packages/domain/src/fee-calculator.ts`:**
   - `calculateTradeFee(saleCents: number): number` — 3%, rounded up to nearest cent.
   - `calculateAuctionFee(winningBidCents: number): number` — 5%, rounded up.
   - Both return integer cents. Use `Math.ceil` so the platform never shorts itself.

8. **Create `packages/domain/src/anti-snipe.ts`:**
   - `computeNewEndsAt(currentEndsAt: Date, bidPlacedAt: Date, extensionSeconds: number): Date` — implements `GREATEST(currentEndsAt, bidPlacedAt + extensionSeconds)`. Pure JS version. Used by tests.

9. **Unit tests for everything in `packages/domain/src/__tests__/`.** Target 100% coverage on the domain package. Specifically:
   - `pack-roller.test.ts` — test that 10,000 rolls of each tier produce empirical rarity distributions within 5% of the configured weights. This is your statistical proof that the EV math is implemented correctly.
   - `ev-calculator.test.ts` — test that EVs match the documented values in ARCHITECTURE §14.3 to the cent.
   - `bid-validator.test.ts` — test boundary cases: first bid, bid exactly at min, bid one cent below min, bid 100x current bid.
   - `fee-calculator.test.ts` — test that fees are always rounded toward platform.
   - `money.test.ts` — test conversion edge cases (1 cent, 100 cents, 99 cents, 1234567890 cents).

10. **Commit:** `phase 4: domain package with full unit test coverage`.

## Verification

```bash
pnpm -F @pullvault/domain test
# All tests pass.

pnpm -F @pullvault/domain test --coverage
# Coverage is 100% (or very close).
```

Run the EV test specifically:
```bash
pnpm -F @pullvault/domain test ev-calculator
# Output should print computed EVs that match §14.3:
# Bronze: $3.05, margin 38.9%
# Silver: $9.74, margin 35.0%
# Gold: $35.60, margin 28.8%
```

If your computed EVs differ from these values by more than 1 cent, your weights are wrong. Re-check against §14.3.

## Exit criteria

- All tests pass.
- The empirical rarity distribution test (10,000 rolls) confirms the pack roller respects the configured weights within 5% tolerance.
- EVs match the documented values to the cent.

## Common pitfalls

- **Float drift in weight sums.** `0.70 + 0.28 + 0.02 = 1.0` in math, but in IEEE 754 it might be `0.9999...`. Either use weights that are exact (e.g. multiples of 0.01) or sum-and-renormalize at runtime.
- **Sorting stability.** When sorting cards by rarity for reveal order, two cards with the same rarity should retain their original order, not get shuffled. Use a stable sort.
- **Random source determinism.** Tests must inject a seeded RNG. Don't call `Math.random` directly inside `rollPack`.

## What NOT to do

- Do not import anything from `@pullvault/db` or `@pullvault/web`. The domain package is pure.
- Do not add caching, memoization, or "performance" optimization. These are simple functions.
- Do not skip the statistical tests. They are the proof your EV math is correct, which is what reviewers will probe.

---

# Phase 5 — Pack Drops + Atomic Purchase

**Goal:** Drops list page, drop detail page with countdown, atomic buy endpoint that passes scenarios D.1 and D.2, drop activator cron in the WS process. The user can buy a pack and have its contents persisted.

**Time budget:** 3 hours. **This is the highest-stakes phase. It is the canonical concurrency test.**

## Web searches to run first

1. **`Drizzle ORM atomic update WHERE rowcount returning 2026`** — confirm the exact syntax for `.returning()` after `.update()` with a conditional WHERE. The pattern is:
   ```ts
   const result = await tx.update(table).set(...).where(...).returning(...);
   if (result.length === 0) throw new ConflictError();
   ```
   This is the linchpin of the inventory race. Get it right.
2. **`Drizzle ORM transaction isolation level postgres`** — confirm the default isolation (read committed) is sufficient for our atomic-update pattern (it is — we don't need serializable). Don't bump it without reason.

## Tasks

1. **Domain errors** in `apps/web/lib/errors.ts`:
   ```ts
   export class DomainError extends Error { code: string; status: number; }
   export class SoldOutError extends DomainError { code = 'SOLD_OUT'; status = 409; }
   export class InsufficientFundsError extends DomainError { code = 'INSUFFICIENT_FUNDS'; status = 402; }
   export class DropNotOpenError extends DomainError { code = 'DROP_NOT_OPEN'; status = 409; }
   // ... and the rest from across the brief
   ```

2. **`GET /api/drops`** — list of drops where `state IN ('SCHEDULED', 'OPEN')` and `starts_at > now() - 1h`. Order by `starts_at`. Return tier, price, inventory_remaining, starts_at, state.

3. **`GET /api/drops/:id`** — single drop detail.

4. **`POST /api/drops/:id/buy`** — implement **exactly** the transaction from ARCHITECTURE §6.1. Key requirements:
   - Atomic conditional `UPDATE pack_drops SET inventory_remaining = inventory_remaining - 1 WHERE id = ? AND inventory_remaining > 0 AND state = 'OPEN'` — check rowcount.
   - Atomic conditional `UPDATE wallets SET balance_available = balance_available - ? WHERE user_id = ? AND balance_available >= ?` — check rowcount.
   - Roll cards using `rollPack` from the domain package, with the seeded card pool (you'll need a query that returns cards grouped by rarity bucket — cache this in module scope; it's read-only data).
   - Insert `pack`, `pack_cards` (sorted by rarity ascending), `wallet_ledger` row.
   - If inventory hits 0, mark drop as `SOLD_OUT`.
   - After commit, publish to Redis `drop:{id}` channel — but Redis isn't set up yet. Use a stub `publish()` function for now that logs to console, real Redis integration in Phase 6.

5. **Drop activator cron in `apps/ws`:** since the WS server doesn't exist yet (Phase 6), put this script in `apps/web/scripts/drop-activator.ts` for now and run it manually with `tsx` during dev. Move to the WS process in Phase 6.

   The job: every 60 seconds, find drops where `state = 'SCHEDULED'` and `starts_at <= now()`, flip to `OPEN`. Should be a single SQL UPDATE.

6. **UI:**
   - `/drops` page — server-rendered list of drops with their states.
   - `/drops/[id]` page — drop detail with a countdown component (`apps/web/components/countdown.tsx`). Pre-drop: shows the countdown, button disabled. At drop time: button enabled, says "Buy for $X.XX". Post-purchase: redirect to `/packs/[id]` (Phase 7).
   - Inventory remaining display. For now, server-rendered on each page load. Real-time WS updates in Phase 6.

7. **Run scenarios D.1 and D.2** from ARCHITECTURE Appendix D. These are not optional. Document the results.

8. **Commit:** `phase 5: pack drops + atomic purchase + concurrency tests passing`.

## Verification

```bash
# Run scenario D.1: two-tab race for the last pack
# Create a drop with inventory_total = 1, starts_at = now() + 60s
# (Update the seed or insert via Supabase Table Editor)

# In two browser tabs as alice@test.com and bob@test.com:
# Both navigate to /drops/{id} and watch the countdown.
# At drop time, click Buy in both tabs simultaneously.

# Expected:
# - One tab gets a packId and redirects.
# - The other tab gets a 409 with SOLD_OUT.
# - The wallet of the winner is debited by exactly $4.99.
# - The wallet of the loser is unchanged.
# - The drop's inventory_remaining is 0.
# - The drop's state is SOLD_OUT.

# Verify in SQL:
SELECT * FROM pack_drops WHERE id = '...';
SELECT user_id, balance_available FROM wallets;
SELECT * FROM packs;
SELECT * FROM wallet_ledger ORDER BY created_at DESC LIMIT 5;
```

For scenario D.2 (rapid fire same user):
```bash
# Set alice's balance to 998 cents ($9.98 = exactly 2 Bronze packs).
# In one terminal:
for i in {1..3}; do
  curl -X POST -b "session=alice_token" http://localhost:3000/api/drops/{id}/buy &
done
wait

# Expected:
# - 2 succeed with packIds.
# - 1 fails with INSUFFICIENT_FUNDS.
# - Final balance is 0.
```

## Exit criteria

- D.1 passes: race for last pack always produces exactly one winner.
- D.2 passes: rapid same-user purchase never exceeds available balance.
- Pack contents are persisted as `pack_cards` rows ordered by rarity ascending.
- The drop activator successfully flips a SCHEDULED drop to OPEN at its `starts_at`.

## Common pitfalls

- **Order of operations matters.** Decrement inventory FIRST. If the wallet check fails after, Postgres rolls back the inventory change automatically. The reverse order — debit wallet first, then check inventory — leaks: a sold-out drop would still debit users.
- **Don't read inventory before the UPDATE.** The atomic-conditional-update is the entire trick. If you do `SELECT inventory_remaining` then `UPDATE`, you've reintroduced the race.
- **Rollbacks must be transparent.** If the transaction throws, Postgres handles the cleanup. Don't write manual compensation logic.
- **Card pool query.** Don't query the entire cards table inside the transaction. Load it once at module load and pass to `rollPack`. The cards table is read-mostly and small.

## What NOT to do

- Do not add an "are you sure?" confirmation step. The brief wants instant resolution.
- Do not implement pack reveal yet (Phase 7).
- Do not implement WebSocket updates yet (Phase 6). Just static page loads.

---

# Phase 6 — WebSocket Server + Redis Pub/Sub

**Goal:** A separate Node process running Socket.io, connected to Redis, receiving Pub/Sub events from the web app and fanning them out to subscribed clients. Drop inventory updates flow live.

**Time budget:** 2.5 hours.

## Web searches to run first

1. **`Socket.io v4 server setup standalone Node 2026`** — confirm the current bootstrap pattern.
2. **`ioredis Pub/Sub psubscribe pmessage 2026`** — confirm the current event names and pattern syntax.
3. **`Socket.io CORS Vercel domain Railway domain 2026`** — confirm how to whitelist the web app's domain on the WS server. CORS misconfig is the #1 cause of "WS won't connect in prod."
4. **`Upstash Redis Pub/Sub free tier 2026`** — confirm Pub/Sub is supported on the free tier (it is) and that ioredis works with the `rediss://` connection string they provide.
5. **`Railway Node service deploy nixpacks 2026`** — for Phase 14, but worth noting the start command convention now.

## Tasks

1. **Install dependencies in `apps/ws`:**
   ```bash
   pnpm -F @pullvault/ws add socket.io ioredis jsonwebtoken zod
   pnpm -F @pullvault/ws add -D @types/node @types/jsonwebtoken tsx
   ```

2. **Create `apps/ws/src/server.ts`:**
   - HTTP server that Socket.io attaches to.
   - CORS allowlist from `WEB_PUBLIC_URL` env var.
   - Graceful shutdown on SIGTERM (close Socket.io, close Redis, exit).

3. **`apps/ws/src/auth.ts`:** validate JWT cookie on connection. Reject unauthed connections. Store `userId` on `socket.data`.

4. **`apps/ws/src/pubsub.ts`:** Redis subscriber with `psubscribe` on the channel patterns from ARCHITECTURE §7.2. On `pmessage`, parse channel and route to the matching Socket.io room.

5. **`apps/ws/src/handlers/subscribe.ts`:** client emits `subscribe` with a channel name. Server validates the channel name (regex: `^(drop|auction|listing|prices|user):.+$`), checks user is allowed (e.g. can only subscribe to their own `user:{id}`), and joins the room.

6. **`apps/ws/src/handlers/disconnect.ts`:** for auction rooms, recompute watcher count and broadcast.

7. **Move drop-activator cron** from `apps/web/scripts/` to `apps/ws/src/jobs/drop-activator.ts`. Set up node-cron to run it every 60 seconds.

8. **Update `apps/web/lib/publish.ts`** from the Phase 5 stub to actually publish to Redis. Use ioredis (not @upstash/redis) so you get the same Pub/Sub semantics.

9. **Web client side:**
   - `apps/web/hooks/use-socket.ts` — manages a singleton Socket.io connection, exposes `subscribe(channel)` and `unsubscribe(channel)`.
   - `apps/web/components/countdown.tsx` already exists; now wire it to listen for `drop:{id}` events and update inventory display in real time.

10. **Run Phase 5's verification again with two browser tabs.** The losing tab should now see the inventory tick to 0 in real time before its buy attempt fails. This is the live-feel test.

11. **Commit:** `phase 6: ws server + redis pubsub + live inventory`.

## Verification

```bash
# Terminal 1
pnpm -F @pullvault/ws dev   # starts on :4000

# Terminal 2
pnpm -F @pullvault/web dev  # starts on :3000

# Browser
# Open /drops/{id} for an OPEN drop with inventory > 1.
# In a second tab as a different user, open the same /drops/{id}.
# In tab 1, click Buy.
# Expected: inventory display in tab 2 ticks down within 200ms.
```

Test reconnection:
```bash
# Open auction page (Phase 10) or drop page.
# DevTools → Network → set to Offline.
# Wait 10 seconds.
# Set back to Online.
# Expected: socket reconnects, page state re-syncs (no errors in console).
```

## Exit criteria

- WS server starts cleanly with proper logs.
- Drop inventory updates appear in connected clients within 200ms of purchase.
- Disconnect/reconnect works without errors.
- The drop-activator successfully flips a SCHEDULED drop to OPEN and broadcasts the state change.

## Common pitfalls

- **Cookie not sent on WS upgrade.** Cross-origin WS requires `withCredentials: true` on the client and proper CORS on the server. If your web is on `localhost:3000` and WS on `localhost:4000`, this is cross-origin even in dev.
- **Forgetting to publish after commit, not before.** ARCHITECTURE §6.1 step 8 is critical: publish to Redis ONLY after the transaction commits. If you publish inside the transaction and the transaction rolls back, you've broadcast a phantom event.
- **Redis connection per request.** Reuse a single ioredis client; don't `new Redis()` on every API call.
- **Subscribing to too much.** Don't blanket-subscribe to all channels. Subscribe per page based on what's displayed.

## What NOT to do

- Do not use the `@upstash/redis` SDK. It's a REST wrapper and doesn't support Pub/Sub. Use `ioredis` with the connection string Upstash gives you.
- Do not horizontally scale the WS server with the Redis adapter yet. One process is fine for trial scale; the architecture supports adding the adapter later (ARCHITECTURE §16).
- Do not implement reconnect-with-state-replay. The pattern is "reconnect, then re-fetch via REST" (ARCHITECTURE §7.3).

---

# Phase 7 — Pack Reveal Experience

**Goal:** After buying a pack, the user clicks to open it, cards reveal one at a time in rarity order, summary screen shows total value vs price paid.

**Time budget:** 2 hours.

## Web searches to run first

None — this is mostly UI work using already-set-up tech.

## Tasks

1. **`GET /api/packs/:id`** — returns the pack with its cards, joined to current prices. Include each card's rarity and image URL. Sort by `position` ascending.

2. **`POST /api/packs/:id/reveal/:position`** — marks one card slot as revealed (sets `revealed = true` and `revealed_at = now()`). Cosmetic only — does not affect contents or prices. Idempotent: re-revealing is a no-op.

3. **`/packs/[id]` page (`apps/web/app/(app)/packs/[id]/page.tsx`):**
   - Fetches pack via the API.
   - State machine: `unopened` → `revealing` → `complete`.
   - In `unopened`: show pack art (a tier-themed colored rectangle is fine — visual polish is not weighted), button "Rip Open."
   - In `revealing`: show one card at a time, with prev/next buttons or auto-advance. Each card shows name, set, image, rarity, current price. The reveal call to the API happens as each card is shown.
   - In `complete`: show all cards in a grid with total pack value, total paid, P&L (positive number in green, negative in red).

4. **Rarity-specific styling:** wrap card images in a colored border by rarity (gray for C, green for U, blue for R, purple for E, orange/gold for L). 1 line of Tailwind per rarity. Don't spend more than 5 minutes here.

5. **Quick action buttons** on the summary screen: per card, "List for Sale" and "Start Auction" buttons. These are placeholders for now (link to placeholder routes); the endpoints come in Phases 9 and 10.

6. **Commit:** `phase 7: pack reveal experience`.

## Verification

- Buy a pack from a drop.
- Confirmed redirect to `/packs/[id]`.
- Click "Rip Open."
- Cards reveal in rarity-ascending order (commons first, hits last).
- Summary screen shows total value, total paid, profit/loss.
- The pack's `pack_cards` rows in DB have `revealed = true` for revealed slots.

## Exit criteria

- Reveal flow works end to end.
- Cards appear in rarity-ascending order.
- Summary shows correct totals.
- The user can navigate away and come back; revealed state persists.

## Common pitfalls

- **Revealing too fast.** Don't auto-advance in <1 second. The brief calls for "tension." Use a 1.5s delay or require a click between cards.
- **Image loading.** pokemontcg.io images can be ~500KB. Use `<Image>` with `loading="lazy"` for the summary grid.
- **P&L formatting.** Negative numbers should show with a minus sign and red color. Positive with green and a "+" prefix is nice but not required.

## What NOT to do

- Do not implement 3D pack-tear animations. Out of scope.
- Do not gate the next reveal on the previous one being marked `revealed=true` server-side — it makes the UX feel laggy. The revealed flag is for analytics, not gating.

---

# Phase 8 — Portfolio / Collection View

**Goal:** Grid of all owned cards, current prices, P&L per card, total portfolio value, sort/filter, live updates over WebSocket.

**Time budget:** 2 hours.

## Tasks

1. **`GET /api/me/portfolio`** — returns the user's `user_cards` joined with `cards` and `card_prices`. For each card include: name, set, rarity, image, acquired_price, current_price, pnl (= current - acquired), state (OWNED/LISTED/AUCTIONED).

2. **`/collection` page:**
   - Grid of cards with image, name, current value, P&L.
   - Total portfolio value at the top: sum of current prices for cards in OWNED state, plus sum of current bid amount for cards in AUCTIONED state, plus sum of listing prices for cards in LISTED state. (Cards in LISTED/AUCTIONED are still "yours" until sold.)
   - Sort dropdown: "Value desc," "Value asc," "Rarity," "P&L desc."
   - Filter chips: "All," "C," "U," "R," "E," "L."
   - Show a small badge per card if it's currently LISTED or AUCTIONED.
   - Quick action buttons per card (only visible when state = OWNED): "List" and "Auction" — link to listing/auction creation flows (Phases 9, 10).

3. **Live updates:** subscribe to `prices:global` over WS. On message, re-render any displayed card whose ID is in the changed list. Total portfolio value should re-compute on each price update.

4. **Total return indicator:** sum of `(current_price - acquired_price)` across all owned cards, plus current wallet balance, vs the $1,000 starting bonus. Show as "Total: $X (+/-$Y)" at the top.

5. **Commit:** `phase 8: portfolio with live prices`.

## Verification

- After buying packs in Phases 5 and 7, navigate to `/collection`.
- All cards visible.
- Total value matches sum of card prices.
- Sort/filter work.
- Hard-refresh the page; state preserved.
- Trigger a price update (run the demo-mode script briefly, or update a price manually in Supabase) and confirm the value ticks in the UI.

## Exit criteria

- Portfolio renders correctly for users with 0, 1, and many cards.
- Live price updates reflect in the UI.
- Sorting and filtering work.

## What NOT to do

- Do not implement historical price charts. P2, deferred.
- Do not implement card detail page yet (small modal is fine for "view details" if you want, but not required).

---

# Phase 9 — Marketplace (Listings)

**Goal:** User A lists a card; User B browses and buys; transaction is atomic. Passes scenarios D.3 and D.8.

**Time budget:** 2.5 hours.

## Tasks

1. **`POST /api/listings`** — body `{ userCardId, priceCents }`. Inside a transaction:
   - Lock the `user_card` row, verify owner matches, verify state is OWNED.
   - Insert listing row with state ACTIVE.
   - Update user_card state to LISTED.
   - The partial unique index on `user_card_id WHERE state = 'ACTIVE'` will reject duplicate active listings at the DB layer.

2. **`POST /api/listings/:id/cancel`** — seller-only. Inside a transaction:
   - Lock the listing, verify state ACTIVE and seller matches.
   - Update listing state to CANCELLED.
   - Update user_card state back to OWNED.

3. **`POST /api/listings/:id/buy`** — implement **exactly** the transaction from ARCHITECTURE §6.2. Specifically:
   - Lock listing FOR UPDATE.
   - Atomic conditional debit on buyer wallet (`balance_available >= price`).
   - Compute fee using `calculateTradeFee` from the domain package.
   - Credit seller (price - fee).
   - Transfer card ownership.
   - Mark listing SOLD.
   - Three ledger entries: buyer debit, seller credit, platform fee.

4. **`GET /api/listings`** — browse with optional filters (rarity, price range, set). Order by created_at desc. Pagination (limit 20, cursor by `created_at`).

5. **UI:**
   - `/market` page — browse listings. Filter chips and price range.
   - `/market/[id]` page — listing detail with "Buy" button.
   - "List for Sale" button on portfolio cards opens a modal to enter price, then POSTs to `/api/listings`.

6. **Run scenarios D.3 (double-buy race) and D.8 (held funds can't be used for purchase).**

7. **Commit:** `phase 9: marketplace + concurrency tests`.

## Verification

D.3:
```
User A lists a card for $5.
Users B and C both have $10+ available.
Open the listing in two tabs (B and C). Click Buy in both at once.
Expected:
- One succeeds, gets the card.
- The other gets 409 LISTING_UNAVAILABLE.
- Seller A's balance increased by $4.85 ($5 - 3% fee).
- Platform ledger has $0.15 fee row.
```

D.8:
```
Set User D's wallet to balance_available=500, balance_held=1500.
Try to buy a $10 listing.
Expected: 402 INSUFFICIENT_FUNDS.
Actual balance debit: 0. Held funds untouched.
```

## Exit criteria

- D.3 passes.
- D.8 passes.
- Listings appear and disappear correctly across the marketplace browse view.

## Common pitfalls

- **Cancel race.** Seller cancels at the same moment as a buyer purchases. The FOR UPDATE on the listing serializes them. Whichever transaction commits first wins; the other gets a clean error.
- **Listing your own card.** Block sellers from buying their own listings (return 400). It's not a critical feature but it looks dumb if a user buys their own card and pays themselves a fee.

## What NOT to do

- Do not implement an offer/counter-offer system. P2, deferred.
- Do not implement listing edits. Cancel and re-create is fine.

---

# Phase 10 — Live Auctions

**Goal:** The headline feature. Real-time competitive bidding with anti-snipe, server-authoritative timer, hold/release lifecycle, watcher count. Passes scenarios D.4 through D.9.

**Time budget:** 5 hours. **This is the biggest phase. If anything slips, slip into this phase, not out of it.**

## Tasks

1. **`POST /api/auctions`** — body `{ userCardId, startingBidCents, durationMinutes }`. Validate duration is one of [5, 30, 120]. Lock user_card FOR UPDATE, verify OWNED, insert auction with `ends_at = now() + duration`, update user_card state to AUCTIONED.

2. **`POST /api/auctions/:id/bid`** — implement **exactly** the transaction from ARCHITECTURE §6.3. Specifically:
   - Lock auction FOR UPDATE.
   - Validate state OPEN, ends_at > now.
   - Compute min valid bid using domain function. Reject if too low.
   - Reject if bidder is seller.
   - Atomic conditional hold on bidder wallet (debit available, credit held).
   - If previous high bidder exists, release their hold (credit available, debit held).
   - Update auction with new bid + extended ends_at.
   - Insert bid row.
   - Publish `auction:{id}` bid event AND `user:{prevHighBidder}` outbid event.

3. **`POST /api/auctions/:id/cancel`** — only allowed if no bids placed yet. Releases the user_card back to OWNED.

4. **`GET /api/auctions`** — list active auctions with current bid, ends_at, card preview.

5. **`GET /api/auctions/:id`** — full auction detail including last 50 bids ordered by placed_at DESC, plus `endsAtIso`, `currentBidCents`, `currentBidUserDisplayName`, `minNextBidCents` (computed via domain function).

6. **Auction-closer cron in `apps/ws/src/jobs/auction-closer.ts`:** runs every 5 seconds. Implements **exactly** the transaction from ARCHITECTURE §6.4:
   - Find auctions where state = OPEN and ends_at <= now().
   - For each: lock FOR UPDATE, re-check (idempotency).
   - Settle: if bids exist, transfer card to winner, debit winner held, credit seller (less fee), record fees. If no bids, return card to seller.
   - Mark auction SETTLED. Publish closed event.

7. **UI — auction list page (`/auctions`):** grid of active auctions with countdown previews.

8. **UI — auction room (`/auctions/[id]`):**
   - Card image and metadata at top.
   - Current high bid prominently displayed.
   - Server-authoritative countdown component using `endsAt` from the API. Tick every second. On WS bid event, reset to new ends_at.
   - Watcher count (Phase 6 §7.4 implementation).
   - Bid history list (most recent first), bidder display names not anonymized.
   - "Place Bid" form: input pre-filled with `minNextBidCents`. Submit POSTs to bid endpoint. On success, the WS event will update the page; the form resets. On failure (BID_TOO_LOW, INSUFFICIENT_FUNDS, AUCTION_CLOSED), show inline error.
   - On `outbid` user-channel event (sent to the previous high bidder), show a toast: "You've been outbid on [card]."

9. **Run scenarios D.4 (simultaneous bids), D.5 (anti-snipe), D.6 (disconnect), D.7 (server crash settlement), D.9 (state machine prevents double-flow).**

10. **Commit:** `phase 10: live auctions + all auction concurrency tests`.

## Verification

Open three browser tabs as users A, B, C. C is the seller, A and B are bidders.

D.4:
```
A and B both bid $11 within the same 100ms.
Expected: one wins, the other gets BID_TOO_LOW (or both retry at higher amounts).
Bid history shows exactly one $11 bid.
Wallet holds: only the current high bidder has $11 held.
```

D.5:
```
Auction has 8 seconds remaining.
B places a bid 3 seconds before close.
Expected: countdown jumps to 30s in all three tabs within 200ms.
ends_at in DB has been extended.
```

D.6:
```
Tab A loses network for 15 seconds during an active auction.
On reconnect, page state re-syncs, ends_at and current bid match DB.
```

D.7:
```
Auction has 10 seconds remaining. Kill the WS process.
Wait 30 seconds. Restart the WS process.
Expected: auction-closer picks up the now-expired auction on next tick.
Settlement completes: winner has card, seller has money - fee, ledger has all entries.
```

D.9:
```
A starts an auction on a card. While it's running, A tries to list the same card.
Expected: 409 CARD_NOT_AVAILABLE. State machine prevents the second flow.
```

## Exit criteria

- All five scenarios pass.
- Anti-snipe extension is visible to all watchers within 200ms.
- Server-crash recovery works (D.7).

## Common pitfalls

- **Bidder is the seller.** Trivially blockable but easy to forget. Add the check.
- **Hold-then-release order.** ARCHITECTURE §6.3 is explicit: place new hold first, then release old. The reverse order opens a window where neither user has funds held.
- **Cron picks up settled auctions.** The auction-closer's `WHERE state = 'OPEN'` clause is the idempotency key. If two cron instances race, the second's UPDATE matches zero rows.
- **endsAt drift on the client.** The client countdown shows seconds-until-endsAt. Re-sync on every WS message; never trust the local timer beyond display.

## What NOT to do

- Do not implement proxy bidding (eBay-style "max bid"). P2, out of scope.
- Do not implement reserve prices. Out of scope.
- Do not show an aggregate "total bids per user" or any cross-auction analytics in the auction room.

---

# Phase 11 — Wire the Price Pipeline to Cron + Demo Mode

**Goal:** The price pipeline built in Phase 2 now runs on an hourly cron in the WS process. A separate optional demo-mode jitter job runs for video recordings.

**Time budget:** 1 hour. (Much shorter than earlier drafts because the heavy lifting was done in Phase 2.)

## Context

The pipeline function from Phase 2 already does everything needed: fetch from pokemontcg.io, upsert cards and prices, detect drift, broadcast via Redis. This phase is just wiring it to a schedule and adding the optional demo-mode toggle.

## Web searches to run first

1. **`pokemontcg.io API rate limit retry strategy 2026`** — confirm whether they return 429 with Retry-After. If so, honor it.
2. **`node-cron error handling unhandled rejection 2026`** — confirm best practice. If the pipeline throws inside a cron tick and we don't catch, Node may crash. Wrap every cron callback in a try/catch.

## Tasks

1. **Wire the pipeline to cron in `apps/ws/src/jobs/price-refresh.ts`:**
   ```ts
   import { runPipeline } from '@pullvault/db/price-pipeline';
   import cron from 'node-cron';
   
   // Cadence: every hour (configurable via PRICE_REFRESH_INTERVAL_HOURS)
   const intervalHours = Number(process.env.PRICE_REFRESH_INTERVAL_HOURS ?? 1);
   const schedule = `0 */${intervalHours} * * *`; // every N hours at minute 0
   
   cron.schedule(schedule, async () => {
     try {
       const result = await runPipeline();
       console.log('[price-refresh]', result);
     } catch (err) {
       console.error('[price-refresh] failed', err);
     }
   });
   ```
   This is ~15 lines because the pipeline function does all the work.

2. **Implement `apps/ws/src/jobs/price-demo-jitter.ts`** per ARCHITECTURE §9.4. Disabled by default; enabled via `PRICE_DEMO_MODE=true`. This is the only new logic in this phase. It picks 20 random cards, applies bounded Gaussian jitter, updates Postgres + Redis, broadcasts.

3. **Hook both into the WS server startup** in `apps/ws/src/server.ts`. The price-refresh always schedules; the demo-jitter only schedules if `PRICE_DEMO_MODE=true`.

4. **Add a manual trigger endpoint** at `POST /api/admin/price-refresh` (authed — for now, "admin" can mean any logged-in user since we're not implementing roles). The endpoint calls `runPipeline()` and returns the result. This is for the review call: Abhinav clicks the button, prices refresh, the audience sees the broadcast hit the portfolio.

5. **Commit:** `phase 11: cron schedule + demo mode toggle`.

## Verification

```bash
# In .env, set PRICE_DEMO_MODE=true
pnpm -F @pullvault/ws dev
# Watch the logs. Within 30 seconds you should see [price-demo-jitter] firing.

# Open the portfolio page in a browser. Watch a price tick.

# Now turn off demo mode in env, restart ws.
# Open the admin page (you'll build this in Phase 12; for now a curl works):
curl -X POST -b "session=alice_token" http://localhost:3000/api/admin/price-refresh
# Expected: real prices fetched from pokemontcg.io, broadcast event fires for any drift > 1%.
```

## Common pitfalls

- **Cron callbacks without try/catch.** If `runPipeline()` throws and you don't catch, you get an unhandled promise rejection that may crash the process.
- **Demo mode firing in production.** Default `PRICE_DEMO_MODE=false` in `.env.example`. Document it loudly.
- **Two cron schedulers fighting.** The price-refresh and price-demo-jitter must not both touch the same card in the same tick. They will — that's fine, last-write-wins is correct here. But make sure both broadcasts go through Redis, not direct Socket.io emits.

## What NOT to do

- Do not rewrite the pipeline logic here. It exists in `packages/db/src/price-pipeline/`. This phase only adds scheduling.
- Do not implement a price history table. P2, out of scope.

---

# Phase 12 — Platform Economics Dashboard

**Goal:** An admin page showing pack EVs, realized margins, fee revenue, and ledger reconciliation.

**Time budget:** 1.5 hours.

## Tasks

1. **`GET /api/admin/economics`** returns:
   - Per-tier pack EV (live, computed via `computeTierEV` from domain package using current avg prices per rarity bucket).
   - Per-tier realized margin: `SUM(pack.price_paid - pack.pack_ev_at_purchase)` over all packs sold, grouped by tier.
   - Trade fee revenue: `SUM(amount) FROM wallet_ledger WHERE type = 'LISTING_FEE'`. Lifetime and last-24h.
   - Auction fee revenue: same for `AUCTION_FEE`.
   - Daily revenue series: 14 days, grouped by `DATE_TRUNC('day', created_at)`. Used for the line chart.
   - Aggregate counters: total packs sold, total trades completed, total auctions settled.
   - Ledger reconciliation: `SELECT user_id, SUM(amount) FROM wallet_ledger GROUP BY user_id` joined to `wallets`. The result columns should match.

2. **`/admin/economics` page:**
   - Table of tiers with EV, sticker price, margin %.
   - Cards for total revenue (lifetime, 24h).
   - Line chart for daily revenue (use a simple SVG or [recharts](https://recharts.org) if installable).
   - Reconciliation panel showing a green check if ledger sums match wallet balances, red X with details otherwise.

3. **Commit:** `phase 12: platform economics dashboard`.

## Verification

- Buy a few packs across tiers.
- List and buy a card on the marketplace.
- Run an auction, place bids, settle it.
- Navigate to `/admin/economics`.
- Confirm: EVs match the documented values, fee revenue is non-zero, daily chart shows today's activity, reconciliation is green.

## What NOT to do

- Do not implement role-based access control. The brief doesn't ask for it. The "admin" page is just any authed user route for trial purposes.

---

# Phase 13 — Polish, Error States, README Finalization

**Goal:** No 500 errors, no blank screens, no broken empty states. README and ARCHITECTURE accurately describe what was built.

**Time budget:** 2 hours.

## Tasks

1. **Walk every user flow.** Sign up, browse drops, buy a pack, reveal it, view collection, list a card, buy from market, start an auction, place bids, watch it settle. Note every place where:
   - A loading spinner is missing.
   - An empty state shows raw text or nothing.
   - An error returns a 500 with no useful message.

2. **Fix each.** Tailwind makes this fast: `<div className="text-gray-500 text-center py-12">No drops yet — check back soon.</div>` is a fine empty state.

3. **Toast component.** Use a minimal toast library (`react-hot-toast` is 2KB and fine). Wire into all error responses from the api-handler wrapper.

4. **404 page.** Tailwind-styled, links back to /drops.

5. **Update README.md** if any feature ended up working differently than described. Update scope cuts list with any new deferred items. Update the "Live Demo" link with the deployed URL (placeholder for now).

6. **Update ARCHITECTURE.md** if any implementation diverged. Be honest about where you cut corners.

7. **Generate a CHANGELOG.md** of phases completed, with commit SHAs.

8. **Commit:** `phase 13: polish + docs`.

## Exit criteria

- Walking the full happy path produces zero console errors.
- Every empty state has copy.
- Every error displays a user-readable message.

## What NOT to do

- Do not add transitions or fancy animations now. The bar is "looks intentional, not broken."
- Do not refactor for refactoring's sake.

---

# Phase 14 — Deployment

**Goal:** Live URL the user (Abhinav) and reviewers can access.

**Time budget:** 1.5 hours.

## Web searches to run first

1. **`Vercel Next.js 14 monorepo pnpm deploy 2026`** — confirm the current `vercel.json` or build settings for monorepo deploys. Vercel's monorepo support has changed.
2. **`Railway Node service tsx production start command 2026`** — confirm the right way to run `tsx` in prod (or whether to compile to JS first; latter is more bulletproof).
3. **`Supabase pooler connection prod Drizzle 2026`** — confirm using `:6543` for prod.

## Tasks

1. **Build verification:**
   ```bash
   pnpm build
   pnpm -F @pullvault/ws build   # if you compile to JS for prod
   ```
   Both must succeed before deploying.

2. **Deploy web to Vercel:**
   - Connect GitHub repo.
   - Set root directory to `apps/web` OR use a Vercel monorepo config.
   - Set every env var from Appendix B.
   - Deploy.

3. **Deploy WS to Railway:**
   - Create a new service from the same GitHub repo.
   - Set the working directory to `apps/ws` and start command (`pnpm start` after compilation, or `tsx src/server.ts` if you want to keep dev simplicity).
   - Set every env var. Note: `WEB_PUBLIC_URL` must point to the Vercel URL.

4. **Smoke test prod:**
   - Sign up.
   - Buy a pack.
   - Reveal it.
   - Confirm WS updates work cross-domain (this is where CORS bites you).

5. **Run scenarios D.1, D.4, D.5 against the deployed app.** Concurrency must work in prod.

6. **Update README.md "Live Demo" link.**

7. **Commit and push:** `phase 14: deployed to vercel + railway`.

## Common pitfalls

- **Cross-domain cookies.** `SameSite=None; Secure` is required for the WS server to read the auth cookie if it's on a different domain than the web app. Set `COOKIE_DOMAIN` carefully.
- **Vercel monorepo.** If the build fails because Vercel can't find the workspace packages, ensure `transpilePackages` is set in `next.config.js` and that Vercel's "Install Command" is `pnpm install` from the repo root.
- **Railway start command.** If using `tsx`, it must be installed in prod dependencies, not dev. Or compile to JS with `tsc` and run `node dist/server.js`.

## What NOT to do

- Do not deploy to a custom domain. Use the platform-provided URLs (`*.vercel.app`, `*.up.railway.app`). One less thing to break.

---

# Phase 15 — Demo Recording Prep

**Goal:** Loom recording (8 min max: 4 demo + 4 technical) is recordable in one or two takes.

**Time budget:** 1 hour preparation + recording time.

## Tasks

1. **Prepare a clean demo state:**
   - Wipe and re-seed the prod DB (or use the staging URL).
   - Create three test users: alice, bob, charlie. Each has $1,000.
   - Schedule a Bronze drop with `inventory_total = 1` to start in 2 minutes (so you can race for it during the recording).
   - Create a SILVER auction with 5-minute duration, starting bid $5, on a card alice owns. This is what you'll bid on during the recording.

2. **Set `PRICE_DEMO_MODE=true`** in Railway env to make the portfolio feel alive during the recording.

3. **Demo script (4 minutes):**
   - 0:00–0:30 — Sign up as a new user, see balance.
   - 0:30–1:00 — View drops list, see countdown.
   - 1:00–2:00 — Open two tabs (alice, bob). Race for the last Bronze pack. Show one winning, one getting "Sold Out."
   - 2:00–3:00 — Reveal the pack. Highlight the EV vs price comparison.
   - 3:00–3:30 — View collection. Show portfolio total updating live (demo mode jitter).
   - 3:30–4:00 — Bid on the running auction. Show anti-snipe extension (place a bid in the final 30s).

4. **Technical script (4 minutes):**
   - 0:00–1:30 — Open ARCHITECTURE.md §6.3. Walk through the auction bid transaction code in `apps/web/app/api/auctions/[id]/bid/route.ts`. Explain hold-release ordering, FOR UPDATE, why bids cannot lose money.
   - 1:30–2:30 — Open §6.1. Walk through the pack purchase atomic update. Explain why the conditional UPDATE replaces SELECT FOR UPDATE.
   - 2:30–3:30 — Open §15. Walk through anti-snipe SQL one-liner. Show the GREATEST clause in code.
   - 3:30–4:00 — Reflect on what would break first at 10K users (§16).

5. **Practice the demo at least once.** Find the rough edges before recording.

6. **Record.** Don't over-edit.

## What NOT to do

- Do not record without a script. You will ramble.
- Do not exceed 8 minutes. Reviewers will not watch past it.
- Do not show code generated by AI without being able to explain every line. The brief is explicit.

---

# Phase 16 — Submission

**Final checklist:**

- [ ] **Deployed link** works for Abhinav and reviewers (test in incognito).
- [ ] **GitHub repo** is public or shared with reviewers. Final commit is on `main`.
- [ ] **README.md** is the front door — clear setup, link to demo, link to architecture.
- [ ] **ARCHITECTURE.md** is comprehensive and accurate to what shipped.
- [ ] **CHANGELOG.md** lists phases.
- [ ] **Loom video** is uploaded and link is in the README.
- [ ] **All 9 scenarios in Appendix D pass** in the deployed environment.
- [ ] **No `.env.local` is committed.**
- [ ] **No `console.log` debug noise** in the deployed code.

After submission, save the entire codebase as a tagged release: `git tag part-a-submitted && git push --tags`. Part B will be sent next; you don't want to lose the submitted state.

---

# Time Budget Summary

| Phase | Goal                                          | Hours | Cumulative |
| ----- | --------------------------------------------- | ----- | ---------- |
| 0     | Bootstrap                                     | 1.0   | 1.0        |
| 1     | Database schema                               | 2.0   | 3.0        |
| 2     | Price pipeline + initial run                  | 2.0   | 5.0        |
| 3     | Auth + wallet                                 | 2.0   | 7.0        |
| 4     | Domain package                                | 2.5   | 9.5        |
| 5     | Pack drops + atomic purchase ⭐               | 3.0   | 12.5       |
| 6     | WS + Pub/Sub                                  | 2.5   | 15.0       |
| 7     | Pack reveal                                   | 2.0   | 17.0       |
| 8     | Portfolio                                     | 2.0   | 19.0       |
| 9     | Marketplace                                   | 2.5   | 21.5       |
| 10    | Auctions ⭐                                   | 5.0   | 26.5       |
| 11    | Cron schedule + demo mode                     | 1.0   | 27.5       |
| 12    | Economics dashboard                           | 1.5   | 29.0       |
| 13    | Polish + docs                                 | 2.0   | 31.0       |
| 14    | Deploy                                        | 1.5   | 32.5       |
| 15    | Demo recording                                | 1.0   | 33.5       |

**Target: 33.5 hours for Part A. Headroom: 6.5 hours.** If a phase overruns, that headroom is your buffer. Use it on Phase 5 or Phase 10 — never on polish.

---

# Stop-and-Ask Triggers

You (Claude Code) must stop and ask Abhinav before proceeding if:

1. A web search reveals a library version or platform behavior that contradicts this plan.
2. Any scenario in Appendix D fails after 30 minutes of investigation.
3. A phase is at 150% of its time budget without exit criteria met.
4. You discover an inconsistency between README.md, ARCHITECTURE.md, and this BUILD_PLAN.md.
5. You encounter an environmental issue (DB connection refused, deploy failure) that doesn't resolve in 15 minutes of standard troubleshooting.
6. You're tempted to skip a phase or merge two phases. Always ask first.

When asking, present the situation, your two or three options, and your recommendation. Don't ask open-ended questions.

---

# Final Note

The brief's eval weights are: 30% concurrency, 20% real-time, 20% architecture, 15% economics, 15% code quality. The phase ordering of this plan mirrors that weighting. Phases 5, 6, and 10 are 30+25 = ~33% of the total time budget. That is correct. Do not let polish or scope creep eat into the time those phases need.

Build the parts that work first. Make them work right. Polish what's left.
