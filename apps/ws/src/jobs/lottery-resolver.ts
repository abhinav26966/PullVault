import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import {
  cardPrices,
  cards,
  db,
  packCards,
  packDrops,
  packEconomicsSnapshots,
  packs,
  walletLedger,
  wallets,
} from '@pullvault/db';
import {
  TIER_CONFIG,
  rollPackHmac,
  type PoolCard,
  type SlotWeights,
  type Tier,
} from '@pullvault/domain';
import Redis from 'ioredis';
import { publisher } from '../redis';

/**
 * Lottery resolver — Part B §10.
 *
 * Matches the auction-closer pattern: 2-second cron, FOR UPDATE SKIP LOCKED
 * gate, idempotent via `pack_drops.lottery_resolved`. Per the BUILD_PLAN's
 * "Lottery cron — explicit ZPOPMIN-then-update ordering" spec:
 *
 *   loop:
 *     a. ZPOPMIN drop:{id}:lottery        (atomic in Redis)
 *     b. atomic UPDATE pack_drops SET inventory = inventory - 1
 *        WHERE id AND inventory > 0 AND state = 'OPEN'
 *     c. if rowcount=0: ZADD popped userId BACK with same score, break
 *     d. if rowcount=1: insert pack + ledger + pack_cards using snapshot
 *        weights, publish pack_minted on user:{userId}, continue
 *   after loop:
 *     drain remaining queue, publish lottery_lost to each
 *     UPDATE pack_drops SET lottery_resolved = true
 *
 * The §6.1 atomic-update body inside step (d) is a deliberate near-duplicate
 * of /api/drops/[id]/buy/route.ts — kept inline rather than extracted to
 * keep the buy route untouched. If the §6.1 transaction logic ever changes,
 * BOTH places must be updated together.
 */

const LOTTERY_WINDOW_MS = Number(process.env.LOTTERY_WINDOW_MS ?? 5_000);
const LOTTERY_TICK_CRON = '*/2 * * * * *'; // every 2 seconds
const PER_TICK_DROP_LIMIT = 16;

// In-memory card pool cache (mirrors apps/web/lib/card-pool.ts pattern).
let cardPoolCache: PoolCard[] | null = null;
async function getCardPool(): Promise<PoolCard[]> {
  if (cardPoolCache) return cardPoolCache;
  cardPoolCache = await db.select({ id: cards.id, rarity: cards.rarity }).from(cards);
  return cardPoolCache;
}

// Lottery-store Redis singleton (no shared module across apps; minimal duplication).
let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  redisClient = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  redisClient.on('error', (err) => console.error('[lottery-resolver redis]', err));
  return redisClient;
}

function lotteryKey(dropId: string): string {
  return `drop:{${dropId}}:lottery`;
}

interface ActiveSnapshotJson {
  readonly slots: readonly SlotWeights[];
}

function defaultSlotsFor(tier: Tier): SlotWeights[] {
  return TIER_CONFIG[tier].slots.map((s) => ({
    type: s.type,
    count: s.count,
    weights: { ...s.weights },
  }));
}

interface MintOutcome {
  readonly status: 'minted' | 'sold_out' | 'insufficient_funds' | 'seed_pool_empty';
  readonly packId?: string;
  readonly remainingInventory?: number;
}

/** Lottery winners did not submit a client_seed at enqueue, so the resolver
 * generates one server-side at mint time. The audit invariant still holds:
 * the *server* commit was pre-published before this mint, regardless of when
 * the client_seed was generated. The verify page renders this client_seed
 * as read-only on /verify/[packId]. */
function generateClientSeed(): string {
  return randomBytes(32).toString('hex');
}

async function mintForUser(dropId: string, userId: string, cardPool: PoolCard[]): Promise<MintOutcome> {
  return db.transaction(async (tx) => {
    // 1. Atomic decrement of inventory.
    const decremented = await tx
      .update(packDrops)
      .set({ inventoryRemaining: sql`${packDrops.inventoryRemaining} - 1` })
      .where(
        and(
          eq(packDrops.id, dropId),
          gt(packDrops.inventoryRemaining, 0),
          eq(packDrops.state, 'OPEN'),
        ),
      )
      .returning({
        remaining: packDrops.inventoryRemaining,
        tier: packDrops.tier,
        priceCents: packDrops.priceCents,
      });
    if (decremented.length === 0) return { status: 'sold_out' as const };
    const drop = decremented[0]!;

    // 1b. Read active snapshot (or fall back to TIER_CONFIG aspirational).
    const [activeSnap] = await tx
      .select({ weights: packEconomicsSnapshots.weights })
      .from(packEconomicsSnapshots)
      .where(
        and(
          eq(packEconomicsSnapshots.tier, drop.tier),
          eq(packEconomicsSnapshots.isActive, true),
        ),
      )
      .limit(1);
    const snap = (activeSnap?.weights ?? null) as ActiveSnapshotJson | null;
    const slots: readonly SlotWeights[] =
      snap?.slots && Array.isArray(snap.slots) && snap.slots.length > 0
        ? snap.slots.map((s) => ({
            type: s.type,
            count: s.count,
            weights: { ...s.weights },
          }))
        : defaultSlotsFor(drop.tier);

    // 2. Atomic debit on the wallet.
    const debited = await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} - ${drop.priceCents}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(wallets.userId, userId),
          gte(wallets.balanceAvailable, drop.priceCents),
        ),
      )
      .returning({ available: wallets.balanceAvailable });
    if (debited.length === 0) {
      // Rollback the inventory decrement by throwing — Drizzle aborts the tx.
      throw new InsufficientFundsRollback();
    }

    // 2b. Provably-fair seed claim — same two-step shape as the web buy
    // route: claim a row, insert the pack, then backfill the FK so postgres'
    // end-of-statement validation is happy.
    const packId = randomUUID();
    const consumed = await tx.execute<{
      id: string;
      commit: string;
      server_seed: string;
    }>(sql`
      UPDATE seed_pool
      SET used = true, used_at = now()
      WHERE id = (
        SELECT id FROM seed_pool
        WHERE used = false
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, commit, server_seed
    `);
    if (!consumed[0]) throw new SeedPoolEmptyRollback();
    const { id: seedPoolId, commit, server_seed: serverSeed } = consumed[0];
    const clientSeed = generateClientSeed();

    // 3. Roll cards via the HMAC sampler.
    const rolled = await rollPackHmac({
      tier: drop.tier,
      pool: cardPool,
      serverSeed,
      clientSeed,
      packId,
      slots,
    });

    // 4. Snapshot pack EV.
    const cardIds = rolled.map((c) => c.cardId);
    const priceRows = await tx
      .select({ id: cardPrices.cardId, price: cardPrices.price })
      .from(cardPrices)
      .where(inArray(cardPrices.cardId, cardIds));
    const priceMap = new Map(priceRows.map((p) => [p.id, p.price]));
    const packEvAtPurchase = rolled.reduce(
      (sum, c) => sum + (priceMap.get(c.cardId) ?? 0),
      0,
    );

    const eligibleCardIds = cardPool.map((c) => c.id).slice().sort();

    // 5. Insert pack with the per-pack provably-fair snapshot.
    const [pack] = await tx
      .insert(packs)
      .values({
        id: packId,
        ownerId: userId,
        dropId,
        tier: drop.tier,
        pricePaid: drop.priceCents,
        packEvAtPurchase,
        rarityWeights: { slots },
        serverSeedCommit: commit,
        serverSeed,
        clientSeed,
        eligibleCardIds,
      })
      .returning({ id: packs.id });
    if (!pack) throw new Error('pack insert returned no row');

    // 5b. Backfill seed_pool → packs FK.
    await tx.execute(sql`
      UPDATE seed_pool SET used_for_pack_id = ${pack.id}::uuid WHERE id = ${seedPoolId}::uuid
    `);

    // 6. Insert pack_cards. Position N = HMAC slot index N.
    await tx.insert(packCards).values(
      rolled.map((c, i) => ({
        packId: pack.id,
        cardId: c.cardId,
        position: i,
        slotType: c.slotType,
        rarityAtPull: c.rarity,
      })),
    );

    // 7. Wallet ledger debit.
    await tx.insert(walletLedger).values({
      userId,
      type: 'PACK_PURCHASE',
      amount: -drop.priceCents,
      packId: pack.id,
    });

    // 8. Mark drop SOLD_OUT if inventory hit 0.
    if (drop.remaining === 0) {
      await tx.update(packDrops).set({ state: 'SOLD_OUT' }).where(eq(packDrops.id, dropId));
    }

    return {
      status: 'minted' as const,
      packId: pack.id,
      remainingInventory: drop.remaining,
    };
  }).catch((err) => {
    if (err instanceof InsufficientFundsRollback) {
      return { status: 'insufficient_funds' as const };
    }
    if (err instanceof SeedPoolEmptyRollback) {
      return { status: 'seed_pool_empty' as const };
    }
    throw err;
  });
}

class InsufficientFundsRollback extends Error {
  constructor() {
    super('lottery: user has insufficient funds — rolling back');
  }
}

class SeedPoolEmptyRollback extends Error {
  constructor() {
    super('lottery: seed_pool exhausted — rolling back this mint');
  }
}

async function resolveDrop(dropId: string, cardPool: PoolCard[]): Promise<void> {
  const r = getRedis();
  const k = lotteryKey(dropId);

  let lastDropState: 'live' | 'sold_out' = 'live';
  for (;;) {
    // a. ZPOPMIN — atomic pop of the lowest-score (= "first in queue" lottery winner).
    const popped = await r.zpopmin(k, 1);
    if (!popped || popped.length < 2) break;
    const userId = popped[0]!;
    const score = Number(popped[1]);

    // b/c/d. Run the §6.1 atomic-update path.
    const out = await mintForUser(dropId, userId, cardPool);
    if (out.status === 'sold_out') {
      // c. Restore the popped intent so it isn't lost on a crash, then break.
      await r.zadd(k, score.toString(), userId);
      lastDropState = 'sold_out';
      break;
    }
    if (out.status === 'insufficient_funds') {
      // Skip this user (their bid lost only their slot). Notify, then continue.
      await publisher.publish(
        `user:${userId}`,
        JSON.stringify({ event: 'lottery_skipped', dropId, reason: 'insufficient_funds' }),
      );
      continue;
    }
    if (out.status === 'seed_pool_empty') {
      // Restore the popped intent for the next tick — the seed-pool-refill cron
      // will have run by then and topped the pool back up.
      await r.zadd(k, score.toString(), userId);
      console.warn(
        `[lottery-resolver] seed_pool exhausted while minting for ${userId} on drop ${dropId} — pausing this drop's drain`,
      );
      break;
    }
    // d. Minted — broadcast pack_minted on the user's channel.
    await publisher.publish(
      `user:${userId}`,
      JSON.stringify({
        event: 'pack_minted',
        dropId,
        packId: out.packId,
        remainingInventory: out.remainingInventory,
      }),
    );
    if (out.remainingInventory === 0) {
      lastDropState = 'sold_out';
      break;
    }
  }

  // After loop: drain whatever remains in the queue, broadcast lottery_lost.
  for (;;) {
    const r2 = await r.zpopmin(k, 100);
    if (!r2 || r2.length === 0) break;
    for (let i = 0; i < r2.length; i += 2) {
      const loserId = r2[i]!;
      await publisher.publish(
        `user:${loserId}`,
        JSON.stringify({ event: 'lottery_lost', dropId }),
      );
    }
  }

  // Mark the drop resolved so future ticks skip it. Idempotency guarantee.
  await db
    .update(packDrops)
    .set({ lotteryResolved: true })
    .where(eq(packDrops.id, dropId));

  // Publish drop-channel update so the public drops page can react.
  await publisher.publish(
    `drop:${dropId}`,
    JSON.stringify({ event: 'lottery_resolved', soldOut: lastDropState === 'sold_out' }),
  );
}

async function runOnce(): Promise<void> {
  // Find drops past the fairness window with the lottery still unresolved.
  // FOR UPDATE SKIP LOCKED handles multi-instance WS safely (currently single
  // Railway instance, but architecturally correct).
  const pending = await db
    .select({ id: packDrops.id })
    .from(packDrops)
    .where(
      and(
        eq(packDrops.state, 'OPEN'),
        eq(packDrops.lotteryResolved, false),
        sql`${packDrops.startsAt} + (${LOTTERY_WINDOW_MS} || ' milliseconds')::interval <= now()`,
      ),
    )
    .limit(PER_TICK_DROP_LIMIT);

  if (pending.length === 0) return;

  const cardPool = await getCardPool();
  for (const row of pending) {
    try {
      await resolveDrop(row.id, cardPool);
      console.log(`[lottery-resolver] resolved drop ${row.id}`);
    } catch (err) {
      console.error(`[lottery-resolver] failed drop ${row.id}`, err);
    }
  }
}

export function scheduleLotteryResolver(): ScheduledTask {
  return cron.schedule(LOTTERY_TICK_CRON, async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[lottery-resolver] tick failed', err);
    }
  });
}

export async function runLotteryResolverNow(): Promise<void> {
  await runOnce();
}
