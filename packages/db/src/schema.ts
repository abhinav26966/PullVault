import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ─── Enums ──────────────────────────────────────────────────────────────────
// Prefixed `pullvault_` to avoid colliding with anything else in the public schema.

export const ledgerTypeEnum = pgEnum('pullvault_ledger_type', [
  'SIGNUP_BONUS',
  'PACK_PURCHASE',
  'LISTING_PURCHASE',
  'LISTING_SALE',
  'LISTING_FEE',
  'AUCTION_HOLD',
  'AUCTION_RELEASE',
  'AUCTION_SETTLE_BUYER',
  'AUCTION_SETTLE_SELLER',
  'AUCTION_FEE',
]);

export const rarityEnum = pgEnum('pullvault_rarity', ['C', 'U', 'R', 'E', 'L']);

export const userCardStateEnum = pgEnum('pullvault_user_card_state', [
  'OWNED',
  'LISTED',
  'AUCTIONED',
  'TRANSFERRED',
]);

export const acquiredViaEnum = pgEnum('pullvault_acquired_via', [
  'PACK',
  'LISTING',
  'AUCTION',
]);

export const tierEnum = pgEnum('pullvault_tier', ['BRONZE', 'SILVER', 'GOLD']);

export const dropStateEnum = pgEnum('pullvault_drop_state', [
  'SCHEDULED',
  'OPEN',
  'SOLD_OUT',
  'CLOSED',
]);

export const slotTypeEnum = pgEnum('pullvault_slot_type', [
  'FILLER',
  'RARE_FLOOR',
  'HIT',
  'JACKPOT',
]);

export const listingStateEnum = pgEnum('pullvault_listing_state', [
  'ACTIVE',
  'SOLD',
  'CANCELLED',
]);

export const auctionStateEnum = pgEnum('pullvault_auction_state', [
  'OPEN',
  // Part B §11 — sealed-bid window. Closer cron flips OPEN → SEALED at
  // ends_at - 60s. Bids continue to be accepted but the auction:{id} WS
  // broadcast redacts amount/bidder so late watchers can't snipe based on
  // the current high. Settles via the existing OPEN→SETTLED path at ends_at.
  'SEALED',
  'CLOSED',
  'SETTLED',
]);

// ─── Tables ─────────────────────────────────────────────────────────────────
// Order: dependency-first so `drizzle-kit generate` produces a clean,
// readable migration. Foreign key targets are declared before their referrers.

// §5.1 — users
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Part B §10 — anti-bot signals captured at signup, scored async by cron.
    // Nullable for backfill; populated only on new signups going forward.
    signupIp: text('signup_ip'),
    signupUaHash: text('signup_ua_hash'),
    signupTzOffset: integer('signup_tz_offset'), // minutes from UTC, x-vercel-ip-timezone
    botScore: integer('bot_score').notNull().default(0),
    flagMultiAccount: boolean('flag_multi_account').notNull().default(false),
  },
  (t) => ({
    // "Find all users from this IP" — signup-cluster heuristic. Partial so
    // the index stays small (only populated for post-Part-B signups).
    signupIpIdx: index('users_signup_ip_idx')
      .on(t.signupIp)
      .where(sql`${t.signupIp} IS NOT NULL`),
    // Partial: only suspicious users land in the index. Tiny in steady state.
    botScoreIdx: index('users_bot_score_idx')
      .on(t.botScore.desc())
      .where(sql`${t.botScore} > 50`),
  }),
);

// §5.1 — wallets (one-to-one with users)
export const wallets = pgTable(
  'wallets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    balanceAvailable: bigint('balance_available', { mode: 'number' })
      .notNull()
      .default(0),
    balanceHeld: bigint('balance_held', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    availableNonNeg: check(
      'wallets_balance_available_nonneg',
      sql`${t.balanceAvailable} >= 0`,
    ),
    heldNonNeg: check('wallets_balance_held_nonneg', sql`${t.balanceHeld} >= 0`),
  }),
);

// §5.3 — cards (catalog)
export const cards = pgTable(
  'cards',
  {
    id: text('id').primaryKey(), // pokemontcg.io card id, e.g. "swsh1-1"
    name: text('name').notNull(),
    setId: text('set_id').notNull(),
    setName: text('set_name').notNull(),
    number: text('number').notNull(),
    rarityRaw: text('rarity_raw').notNull(),
    rarity: rarityEnum('rarity').notNull(),
    imageUrl: text('image_url').notNull(),
    imageUrlSmall: text('image_url_small').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    rarityIdx: index('cards_rarity_idx').on(t.rarity),
    setIdIdx: index('cards_set_id_idx').on(t.setId),
  }),
);

// §5.3 — card_prices (one-to-one with cards, mutated by the price engine)
export const cardPrices = pgTable('card_prices', {
  cardId: text('card_id')
    .primaryKey()
    .references(() => cards.id, { onDelete: 'cascade' }),
  price: bigint('price', { mode: 'number' }).notNull(),
  baseline: bigint('baseline', { mode: 'number' }).notNull(),
  lastRealPollAt: timestamp('last_real_poll_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// §5.5 — pack_drops
export const packDrops = pgTable(
  'pack_drops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tier: tierEnum('tier').notNull(),
    priceCents: bigint('price_cents', { mode: 'number' }).notNull(),
    inventoryTotal: integer('inventory_total').notNull(),
    inventoryRemaining: integer('inventory_remaining').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    state: dropStateEnum('state').notNull().default('SCHEDULED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Part B §10 — set true by lottery-resolver cron once it has drained the
    // fairness-window queue and notified winners/losers. Cron's idempotency
    // gate: the WHERE clause selects only rows with this still false.
    lotteryResolved: boolean('lottery_resolved').notNull().default(false),
  },
  (t) => ({
    inventoryNonNeg: check(
      'pack_drops_inventory_remaining_nonneg',
      sql`${t.inventoryRemaining} >= 0`,
    ),
    stateStartsAtIdx: index('pack_drops_state_starts_at_idx').on(t.state, t.startsAt),
    // Partial — exactly the lottery-resolver cron's WHERE clause.
    lotteryPendingIdx: index('pack_drops_lottery_pending_idx')
      .on(t.startsAt)
      .where(sql`${t.state} = 'OPEN' AND ${t.lotteryResolved} = false`),
  }),
);

// §5.4 — user_cards (ownership instances; same card_id may appear many times)
export const userCards = pgTable(
  'user_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    acquiredPrice: bigint('acquired_price', { mode: 'number' }).notNull(),
    acquiredVia: acquiredViaEnum('acquired_via').notNull(),
    state: userCardStateEnum('state').notNull().default('OWNED'),
  },
  (t) => ({
    ownerStateIdx: index('user_cards_owner_state_idx').on(t.ownerId, t.state),
    cardIdIdx: index('user_cards_card_id_idx').on(t.cardId),
  }),
);

// §5.6 — packs (a purchased pack)
export const packs = pgTable(
  'packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    dropId: uuid('drop_id')
      .notNull()
      .references(() => packDrops.id),
    tier: tierEnum('tier').notNull(),
    pricePaid: bigint('price_paid', { mode: 'number' }).notNull(),
    purchasedAt: timestamp('purchased_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    packEvAtPurchase: bigint('pack_ev_at_purchase', { mode: 'number' }).notNull(),
    // Part B §9 — snapshot of the rarity weights this pack was rolled with.
    // NOT NULL: apps/web/scripts/backfill-pack-rarity-weights.ts backfilled all
    // pre-Part-B packs before this constraint was applied (migration 0002).
    // Source of truth for "what weights produced this pack" — pack-roller reads
    // this at rip time, immune to any later recompute on pack_economics_snapshots.
    rarityWeights: jsonb('rarity_weights').notNull(),
    // Part B §12 — provably-fair fields, captured atomically at purchase.
    // Pre-Part-B packs carry NULLs and the verify page renders "pre-PF: not
    // verifiable" for them. From this migration forward every fresh pack has
    // commit + server_seed + client_seed + eligible_card_ids snapshots so the
    // browser can recompute every slot's HMAC and confirm tamper-freedom.
    serverSeedCommit: text('server_seed_commit'),
    serverSeed: text('server_seed'),
    clientSeed: text('client_seed'),
    eligibleCardIds: text('eligible_card_ids').array(),
  },
  (t) => ({
    ownerIdx: index('packs_owner_idx').on(t.ownerId),
    dropIdx: index('packs_drop_id_idx').on(t.dropId),
  }),
);

// §5.6 — pack_cards (slots inside a purchased pack, sorted by reveal position)
export const packCards = pgTable(
  'pack_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packId: uuid('pack_id')
      .notNull()
      .references(() => packs.id, { onDelete: 'cascade' }),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id),
    position: integer('position').notNull(),
    slotType: slotTypeEnum('slot_type').notNull(),
    rarityAtPull: rarityEnum('rarity_at_pull').notNull(),
    revealed: boolean('revealed').notNull().default(false),
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
  },
  (t) => ({
    packPositionIdx: index('pack_cards_pack_position_idx').on(t.packId, t.position),
  }),
);

// §5.7 — listings (fixed-price marketplace)
export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    userCardId: uuid('user_card_id')
      .notNull()
      .references(() => userCards.id),
    price: bigint('price', { mode: 'number' }).notNull(),
    state: listingStateEnum('state').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    soldAt: timestamp('sold_at', { withTimezone: true }),
    buyerId: uuid('buyer_id').references(() => users.id),
  },
  (t) => ({
    // Partial unique index: at most one ACTIVE listing per user_card.
    // Uses raw `sql` template to avoid the eq() parameterization bug in
    // drizzle-kit (issue #4790).
    activeUserCardUq: uniqueIndex('listings_active_user_card_uq')
      .on(t.userCardId)
      .where(sql`${t.state} = 'ACTIVE'`),
    stateCreatedIdx: index('listings_state_created_idx').on(t.state, t.createdAt),
    sellerIdx: index('listings_seller_idx').on(t.sellerId),
  }),
);

// §5.8 — auctions
export const auctions = pgTable(
  'auctions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    userCardId: uuid('user_card_id')
      .notNull()
      .references(() => userCards.id),
    startingBid: bigint('starting_bid', { mode: 'number' }).notNull(),
    currentBidAmount: bigint('current_bid_amount', { mode: 'number' }),
    currentBidUserId: uuid('current_bid_user_id').references(() => users.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    state: auctionStateEnum('state').notNull().default('OPEN'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    // Part B §11 — incremented in the bid endpoint's atomic UPDATE every time
    // anti-snipe fires (bid in last 30s extends ends_at). Surfaced by the
    // /admin/auctions analytics page as the snipe-rate metric.
    extensionCount: integer('extension_count').notNull().default(0),
  },
  (t) => ({
    // Partial unique index: at most one OPEN-or-SEALED auction per user_card
    // (sealed is logically still an open auction — bids still arrive). Without
    // sealed in the predicate, a SEALED auction would let a duplicate OPEN
    // listing slip through.
    openUserCardUq: uniqueIndex('auctions_open_user_card_uq')
      .on(t.userCardId)
      .where(sql`${t.state} IN ('OPEN', 'SEALED')`),
    stateEndsAtIdx: index('auctions_state_ends_at_idx').on(t.state, t.endsAt),
    sellerIdx: index('auctions_seller_idx').on(t.sellerId),
  }),
);

// §5.8 — bids (immutable history)
export const bids = pgTable(
  'bids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    auctionId: uuid('auction_id')
      .notNull()
      .references(() => auctions.id, { onDelete: 'cascade' }),
    bidderId: uuid('bidder_id')
      .notNull()
      .references(() => users.id),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    // Part B §11 — true when the bid was placed during the SEALED window.
    // Bid amounts are still stored normally; this flag is what the WS
    // broadcast layer reads to redact the amount/bidder from public events.
    isSealed: boolean('is_sealed').notNull().default(false),
  },
  (t) => ({
    // (auction_id, placed_at DESC) for "most recent first" bid history per
    // ARCHITECTURE §5.8.
    auctionPlacedIdx: index('bids_auction_placed_idx').on(
      t.auctionId,
      t.placedAt.desc(),
    ),
  }),
);

// §5.2 — wallet_ledger (append-only audit trail)
export const walletLedger = pgTable(
  'wallet_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: ledgerTypeEnum('type').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    packId: uuid('pack_id').references(() => packs.id),
    listingId: uuid('listing_id').references(() => listings.id),
    auctionId: uuid('auction_id').references(() => auctions.id),
    bidId: uuid('bid_id').references(() => bids.id),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('wallet_ledger_user_created_idx').on(t.userId, t.createdAt),
    typeCreatedIdx: index('wallet_ledger_type_created_idx').on(t.type, t.createdAt),
    auctionIdx: index('wallet_ledger_auction_idx').on(t.auctionId),
    listingIdx: index('wallet_ledger_listing_idx').on(t.listingId),
  }),
);

// Part B §11 — auction_flags (wash-trade detection output)
//
// Wash-trade-detector cron runs every 5 min, scores recent settled auctions
// against 9 weighted signals, and writes one row per flagged auction. Score
// >= 55 triggers the flag. Detection only — auctions are NOT auto-cancelled;
// admin reviews via /admin/auctions and either clears or confirms.
export const auctionFlags = pgTable(
  'auction_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    auctionId: uuid('auction_id')
      .notNull()
      .references(() => auctions.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    reasons: jsonb('reasons').notNull(), // [{ code: string, weight: number }]
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    resolution: text('resolution'), // 'cleared' | 'confirmed' | null
  },
  (t) => ({
    // "Show flags for this auction" lookup.
    auctionIdx: index('auction_flags_auction_idx').on(t.auctionId),
    // "Show all unreviewed flags" admin queue. Partial — index only the
    // pending review tail, which is small in steady state.
    unreviewedIdx: index('auction_flags_unreviewed_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.reviewedAt} IS NULL`),
  }),
);

// Part B §10 — account_clusters (anti-bot heuristic output)
//
// Daily cron groups users with shared signup_ip + signup-time clustering and
// writes one row per cluster. Surfaced in the B5 fraud tab. Detection only —
// no auto-blocking; flagged for human review.
export const accountClusters = pgTable(
  'account_clusters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reason: text('reason').notNull(), // e.g. 'shared-ip + 5min-signup-window'
    userIds: uuid('user_ids').array().notNull(),
    signalData: jsonb('signal_data'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // "Show recent clusters" — admin queue read path.
    createdIdx: index('account_clusters_created_idx').on(t.createdAt.desc()),
  }),
);

// Part B §10 — rate_limit_audit (forensic trail of blocked requests)
//
// Append-only log written by the rate-limit middleware whenever a request hits
// a 429. bigserial id + indexed (endpoint, blocked_at) so the dashboard can
// efficiently page through "recent blocks per endpoint" without scanning.
export const rateLimitAudit = pgTable(
  'rate_limit_audit',
  {
    id: bigint('id', { mode: 'bigint' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    scope: text('scope').notNull(), // 'user' | 'ip'
    scopeId: text('scope_id').notNull(),
    endpoint: text('endpoint').notNull(),
    blockedAt: timestamp('blocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    endpointAtIdx: index('rate_limit_audit_endpoint_at_idx').on(
      t.endpoint,
      t.blockedAt.desc(),
    ),
  }),
);

// Part B §9 — pack_economics_snapshots (append-only solver output)
//
// Every recompute writes a new row. `is_active=true` selects the snapshot the
// drop-buy path uses for fresh purchases. Existing in-flight packs read their
// own `packs.rarity_weights` snapshot, so a new active row never affects them.
//
// notes carries solver self-test output. When the per-slot Lagrangian and the
// single-tilt fallback disagree by >0.5% the row is written with
// `is_active=false` and notes='self-test failed: lagrangian=<EV>, tilt=<EV>,
// delta=<pct>' so the dashboard can render the failure loudly.
export const packEconomicsSnapshots = pgTable(
  'pack_economics_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tier: tierEnum('tier').notNull(),
    weights: jsonb('weights').notNull(),
    targetMargin: numeric('target_margin', { precision: 5, scale: 4 }).notNull(),
    evCents: integer('ev_cents').notNull(),
    winRate: numeric('win_rate', { precision: 5, scale: 4 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    notes: text('notes'),
  },
  (t) => ({
    // Partial index: "fetch latest active snapshot for tier" — the only hot
    // read path. Keeps the index small (≤ 3 rows in steady state).
    activeTierIdx: uniqueIndex('pack_economics_snapshots_active_tier_uq')
      .on(t.tier)
      .where(sql`${t.isActive} = true`),
    tierCreatedIdx: index('pack_economics_snapshots_tier_created_idx').on(
      t.tier,
      t.createdAt.desc(),
    ),
  }),
);

// Part B §12 — seed_pool (pre-committed server seeds for provably-fair).
//
// The WS process generates entries on boot and once an hour; the buy path
// consumes one inside the existing transaction with `SELECT ... FOR UPDATE
// SKIP LOCKED LIMIT 1`. Public audit endpoint `/api/audit/commits` exposes the
// `unused = true` subset so a user buying a pack can prove the commit they
// were assigned was already published *before* the purchase — server cannot
// have crafted a seed for their specific cards.
//
// `commit` is hex(SHA256(server_seed)) and is what the client compares its
// browser-side digest against on /verify/[packId].
export const seedPool = pgTable(
  'seed_pool',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commit: text('commit').notNull().unique(),
    serverSeed: text('server_seed').notNull(),
    used: boolean('used').notNull().default(false),
    usedForPackId: uuid('used_for_pack_id').references(() => packs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => ({
    // Partial index — exactly the consume path's WHERE clause. Stays small
    // because the steady-state pool is ≥ 100 unused entries.
    unusedIdx: index('seed_pool_unused_idx')
      .on(t.createdAt)
      .where(sql`${t.used} = false`),
    // Verify-page lookup: "find the commit row for this pack". Partial on
    // non-null because pre-PF packs have no entry here.
    usedPackIdx: index('seed_pool_used_pack_idx')
      .on(t.usedForPackId)
      .where(sql`${t.usedForPackId} IS NOT NULL`),
  }),
);

// Part B §12 — pack_audit_aggregates (rolling rarity-distribution snapshot).
//
// 10-min cron writes one row per (tier, rarity) with observed counts and
// expected-weight averages. The B5 fairness tab reads `latest per tier` and
// runs chi-squared + K-S against expected. Boot-time backfill seeds the table
// from existing pack_cards so the dashboard has real data day-one rather than
// having to wait 10 minutes after deploy.
export const packAuditAggregates = pgTable(
  'pack_audit_aggregates',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    tier: tierEnum('tier').notNull(),
    rarity: rarityEnum('rarity').notNull(),
    observedCount: bigint('observed_count', { mode: 'number' }).notNull(),
    expectedWeight: numeric('expected_weight', { precision: 10, scale: 6 }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // "Latest aggregates per tier" — the fairness tab's read pattern.
    tierAtIdx: index('pack_audit_aggregates_tier_at_idx').on(
      t.tier,
      t.computedAt.desc(),
    ),
  }),
);

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Fixed system user used as the counterparty for platform-revenue ledger entries
 * (LISTING_FEE, AUCTION_FEE). Inserted by the price-pipeline initial run.
 * House revenue is just "the platform user's ledger entries summed."
 */
export const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001' as const;
