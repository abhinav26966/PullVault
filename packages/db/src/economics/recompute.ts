import { and, desc, eq, sql } from 'drizzle-orm';
import {
  FLOOR_WEIGHTS,
  TIER_CONFIG,
  simulate,
  solveWeights,
  type Rarity,
  type SlotWeights,
  type SolverResult,
  type Tier,
} from '@pullvault/domain';
import type { InferSelectModel } from 'drizzle-orm';
import { db } from '../client';
import { cardPrices, cards, packEconomicsSnapshots } from '../schema';

type PackEconomicsSnapshot = InferSelectModel<typeof packEconomicsSnapshots>;

/**
 * Pack-economics recompute — Part B §9 / B5 dashboard surface.
 *
 * Reads card_prices grouped by rarity to build the rarity-mean-cents map,
 * solves per tier under both modes (lagrangian primary, single-tilt
 * self-test), runs a 10K-pack Monte Carlo against the lagrangian output,
 * and writes one append-only row per tier into pack_economics_snapshots.
 *
 * Activation rule (the B1 self-test invariant):
 *   - solver status = 'infeasible'        → is_active=false, notes='infeasible: …'
 *   - |lag.evCents - tilt.evCents|/lag > 0.5%
 *                                         → is_active=false, notes='self-test failed: …'
 *   - otherwise                           → is_active=true, notes='ok'
 *
 * The dashboard reads the latest row per tier and renders the failure case
 * with a red banner so solver disagreement is loud, not hidden.
 *
 * The partial unique index pack_economics_snapshots_active_tier_uq enforces
 * "at most one is_active=true per tier" at the DB level. Recompute runs
 * inside a transaction that flips the previous active row(s) for the tier
 * to is_active=false before inserting the new active row.
 *
 * Lives in @pullvault/db (not apps/web/lib) so apps/ws can call it from
 * the price-refresh cron without crossing app boundaries. Same neighbourhood
 * as the existing price-pipeline runner.
 */

const TIERS: readonly Tier[] = ['BRONZE', 'SILVER', 'GOLD'] as const;

const SELF_TEST_TOLERANCE = 0.005; // 0.5%
const DEFAULT_TARGET_MARGIN = 0.3; // 30%
const SIM_N = 10_000;
const SIM_SEED = 0xb1_5e_ed; // pinned so recomputes are reproducible audit-side

export interface RecomputeOptions {
  readonly targetMargin?: number;
  readonly trigger?: string; // 'manual' | 'cron' | 'startup'
}

export interface TierRecomputeOutcome {
  readonly tier: Tier;
  readonly snapshotId: string;
  readonly isActive: boolean;
  readonly evCents: number;
  readonly winRate: number;
  readonly notes: string;
  readonly lagrangianEvCents: number;
  readonly tiltEvCents: number;
  readonly delta: number;
  readonly status: 'activated' | 'self_test_failed' | 'infeasible';
}

export interface RecomputeResult {
  readonly targetMargin: number;
  readonly rarityMeanCents: Readonly<Record<Rarity, number>>;
  readonly outcomes: readonly TierRecomputeOutcome[];
}

async function readRarityMeanCents(): Promise<Record<Rarity, number>> {
  const rows = await db
    .select({
      rarity: cards.rarity,
      meanPrice: sql<string>`AVG(${cardPrices.price})`,
    })
    .from(cards)
    .innerJoin(cardPrices, eq(cardPrices.cardId, cards.id))
    .groupBy(cards.rarity);

  const out: Record<Rarity, number> = { C: 0, U: 0, R: 0, E: 0, L: 0 };
  for (const row of rows) {
    const v = Number(row.meanPrice ?? 0);
    if (Number.isFinite(v)) out[row.rarity as Rarity] = v;
  }
  return out;
}

function buildFloor(tier: Tier): SlotWeights[] {
  return TIER_CONFIG[tier].slots.map((s) => ({
    type: s.type,
    count: s.count,
    weights: { ...FLOOR_WEIGHTS[s.type] },
  }));
}

function buildAspirational(tier: Tier): SlotWeights[] {
  return TIER_CONFIG[tier].slots.map((s) => ({
    type: s.type,
    count: s.count,
    weights: { ...s.weights },
  }));
}

function classify(
  lag: SolverResult,
  tilt: SolverResult,
): { isActive: boolean; notes: string; status: TierRecomputeOutcome['status']; delta: number } {
  if (lag.status === 'infeasible') {
    return {
      isActive: false,
      notes: `infeasible: ${lag.reason ?? 'no reason'}`,
      status: 'infeasible',
      delta: 0,
    };
  }
  if (tilt.status === 'infeasible') {
    return {
      isActive: false,
      notes: `infeasible (tilt-mode): ${tilt.reason ?? 'no reason'}`,
      status: 'infeasible',
      delta: 0,
    };
  }
  const denom = Math.max(lag.evCents, 1);
  const delta = Math.abs(lag.evCents - tilt.evCents) / denom;
  if (delta > SELF_TEST_TOLERANCE) {
    const pct = (delta * 100).toFixed(2);
    return {
      isActive: false,
      notes: `self-test failed: lagrangian=${lag.evCents}, tilt=${tilt.evCents}, delta=${pct}%`,
      status: 'self_test_failed',
      delta,
    };
  }
  return { isActive: true, notes: 'ok', status: 'activated', delta };
}

export async function recomputeAllTiers(
  opts: RecomputeOptions = {},
): Promise<RecomputeResult> {
  const targetMargin = opts.targetMargin ?? DEFAULT_TARGET_MARGIN;
  const rarityMeanCents = await readRarityMeanCents();
  const trigger = opts.trigger ?? 'manual';

  const outcomes: TierRecomputeOutcome[] = [];

  for (const tier of TIERS) {
    const aspirational = buildAspirational(tier);
    const floor = buildFloor(tier);
    const priceCents = TIER_CONFIG[tier].priceCents;

    const lag = solveWeights({
      aspirational,
      floor,
      priceCents,
      rarityMeanCents,
      targetMargin,
      mode: 'lagrangian',
    });
    const tilt = solveWeights({
      aspirational,
      floor,
      priceCents,
      rarityMeanCents,
      targetMargin,
      mode: 'tilt',
    });

    const verdict = classify(lag, tilt);

    const sim = simulate({
      slots: lag.slots,
      priceCents,
      rarityMeanCents,
      n: SIM_N,
      seed: SIM_SEED,
    });

    const inserted = await db.transaction(async (tx) => {
      if (verdict.isActive) {
        await tx
          .update(packEconomicsSnapshots)
          .set({ isActive: false })
          .where(
            and(
              eq(packEconomicsSnapshots.tier, tier),
              eq(packEconomicsSnapshots.isActive, true),
            ),
          );
      }
      const [row] = await tx
        .insert(packEconomicsSnapshots)
        .values({
          tier,
          weights: { slots: lag.slots, trigger },
          targetMargin: targetMargin.toFixed(4),
          evCents: lag.evCents,
          winRate: sim.winRate.toFixed(4),
          isActive: verdict.isActive,
          notes: verdict.notes,
        })
        .returning();
      if (!row) throw new Error('recompute: insert returned no row');
      return row;
    });

    outcomes.push({
      tier,
      snapshotId: inserted.id,
      isActive: inserted.isActive,
      evCents: lag.evCents,
      winRate: sim.winRate,
      notes: verdict.notes,
      lagrangianEvCents: lag.evCents,
      tiltEvCents: tilt.evCents,
      delta: verdict.delta,
      status: verdict.status,
    });
  }

  return { targetMargin, rarityMeanCents, outcomes };
}

/**
 * Read the active snapshot for a tier. Used by the drop-buy path to attach
 * the correct rarity_weights to a freshly-minted pack.
 *
 * Returns null when no snapshot exists yet (pre-Part-B installs); callers
 * fall back to TIER_CONFIG so existing flows keep working.
 */
export async function getActiveSnapshot(tier: Tier): Promise<PackEconomicsSnapshot | null> {
  const [row] = await db
    .select()
    .from(packEconomicsSnapshots)
    .where(
      and(eq(packEconomicsSnapshots.tier, tier), eq(packEconomicsSnapshots.isActive, true)),
    )
    .orderBy(desc(packEconomicsSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

interface ActiveWeightsJson {
  readonly slots: readonly SlotWeights[];
}

/**
 * Read the active snapshot's slot weights for a tier, falling back to
 * TIER_CONFIG when no snapshot exists.
 */
export async function getActiveSlots(tier: Tier): Promise<readonly SlotWeights[]> {
  const snap = await getActiveSnapshot(tier);
  if (!snap) return buildAspirational(tier);
  const parsed = snap.weights as unknown as ActiveWeightsJson;
  if (!parsed?.slots || !Array.isArray(parsed.slots)) {
    return buildAspirational(tier);
  }
  return parsed.slots.map((s) => ({
    type: s.type,
    count: s.count,
    weights: { ...s.weights },
  }));
}
