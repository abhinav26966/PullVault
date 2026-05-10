import { eq, sql } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import {
  db,
  packAuditAggregates,
  packCards,
  packs,
  type NewPackAuditAggregate,
} from '@pullvault/db';
import { RARITY_ORDER, type Rarity, type Tier } from '@pullvault/domain';

/**
 * Pack-audit aggregator — Part B §12.
 *
 * Every 10 minutes, recompute (tier, rarity) → observed_count and the
 * expected weight implied by `packs.rarity_weights` averaged across all
 * packs in that tier. The B5 fairness tab reads the latest snapshot per
 * tier and runs chi-squared + K-S against expected.
 *
 * Boot-time backfill: if `pack_audit_aggregates` is empty when the WS
 * process starts, run aggregateOnce() once before the first cron tick so
 * the dashboard has real data on day one rather than waiting 10 minutes.
 *
 * Why "average of per-pack expected weights" rather than "weight from the
 * active solver snapshot": packs purchased before a recompute carry their
 * own rarity_weights snapshot (Part B §9), so the population of in-flight
 * packs in a tier is heterogeneous. Averaging per-pack gives the population-
 * mean expectation, which is what the chi-squared null hypothesis needs.
 */

interface RarityWeightsJson {
  readonly slots?: ReadonlyArray<{
    readonly count: number;
    readonly weights: Readonly<Record<Rarity, number>>;
  }>;
}

const TICK_CRON = '*/10 * * * *'; // every 10 minutes
const TIERS: readonly Tier[] = ['BRONZE', 'SILVER', 'GOLD'];

interface ExpectedAccumulator {
  sum: Record<Rarity, number>;
  n: number;
}

function newAccumulator(): ExpectedAccumulator {
  return { sum: { C: 0, U: 0, R: 0, E: 0, L: 0 }, n: 0 };
}

export async function aggregateOnce(): Promise<void> {
  // 1) Observed: count of (tier, rarity_at_pull) over pack_cards joined with packs.
  const observed = await db
    .select({
      tier: packs.tier,
      rarity: packCards.rarityAtPull,
      count: sql<number>`count(*)::int`,
    })
    .from(packCards)
    .innerJoin(packs, eq(packs.id, packCards.packId))
    .groupBy(packs.tier, packCards.rarityAtPull);

  if (observed.length === 0) {
    console.log('[audit-aggregator] no pack_cards yet — skipping');
    return;
  }

  // 2) Expected: per-tier mean of per-pack expected weight per rarity.
  const tierPacks = await db
    .select({ tier: packs.tier, rarityWeights: packs.rarityWeights })
    .from(packs);

  const expectedByTier: Record<Tier, ExpectedAccumulator> = {
    BRONZE: newAccumulator(),
    SILVER: newAccumulator(),
    GOLD: newAccumulator(),
  };
  for (const row of tierPacks) {
    const json = row.rarityWeights as RarityWeightsJson | null;
    const slots = json?.slots;
    if (!slots || slots.length === 0) continue;
    const totalCards = slots.reduce((s, x) => s + x.count, 0);
    if (totalCards === 0) continue;
    const acc = expectedByTier[row.tier];
    for (const r of RARITY_ORDER) {
      const weighted = slots.reduce(
        (s, slot) => s + slot.count * (slot.weights[r] ?? 0),
        0,
      );
      acc.sum[r] += weighted / totalCards;
    }
    acc.n += 1;
  }

  const now = new Date();
  const rows: NewPackAuditAggregate[] = [];
  for (const o of observed) {
    const acc = expectedByTier[o.tier];
    if (acc.n === 0) continue;
    const expectedWeight = acc.sum[o.rarity] / acc.n;
    rows.push({
      tier: o.tier,
      rarity: o.rarity,
      observedCount: o.count,
      expectedWeight: expectedWeight.toFixed(6),
      computedAt: now,
    });
  }

  if (rows.length === 0) return;
  await db.insert(packAuditAggregates).values(rows);
  console.log(
    `[audit-aggregator] inserted ${rows.length} rows across tiers ${TIERS.filter((t) => expectedByTier[t].n > 0).join(',')}`,
  );
}

async function isEmpty(): Promise<boolean> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(packAuditAggregates);
  return Number(row?.value ?? 0) === 0;
}

export async function backfillOnceIfEmpty(): Promise<void> {
  if (!(await isEmpty())) {
    console.log('[audit-aggregator] table non-empty — skipping boot backfill');
    return;
  }
  console.log('[audit-aggregator] table empty — running one-shot backfill');
  await aggregateOnce();
}

export function scheduleAuditAggregator(): ScheduledTask {
  return cron.schedule(TICK_CRON, async () => {
    try {
      await aggregateOnce();
    } catch (err) {
      console.error('[audit-aggregator] tick failed', err);
    }
  });
}
