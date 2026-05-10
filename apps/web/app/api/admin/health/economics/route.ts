import { NextResponse } from 'next/server';
import {
  and,
  avg,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  sql,
  sum,
} from 'drizzle-orm';
import {
  PLATFORM_USER_ID,
  db,
  packEconomicsSnapshots,
  packs,
  walletLedger,
} from '@pullvault/db';
import { TIER_CONFIG, type Tier } from '@pullvault/domain';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const TIERS: readonly Tier[] = ['BRONZE', 'SILVER', 'GOLD'];

const SELF_TEST_FAILED_PREFIX = 'self-test failed:';

interface SelfTestParse {
  readonly lagrangian: number | null;
  readonly tilt: number | null;
  readonly delta: number | null;
}

/** Parse `notes='self-test failed: lagrangian=<EV>, tilt=<EV>, delta=<pct>'`
 *  into structured fields. Tolerant of formatting drift — missing fields
 *  return null and the dashboard still renders the raw notes. */
function parseSelfTestNotes(notes: string | null | undefined): SelfTestParse {
  const out: SelfTestParse = { lagrangian: null, tilt: null, delta: null };
  if (!notes) return out;
  const grab = (key: string): number | null => {
    const m = notes.match(new RegExp(`${key}=([\\-]?\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[1]) : null;
  };
  return {
    lagrangian: grab('lagrangian'),
    tilt: grab('tilt'),
    delta: grab('delta'),
  };
}

/**
 * /api/admin/health/economics — Part B §13.
 *
 * Aggregates everything the Economics tab needs in a single round-trip:
 * (1) the latest active snapshot per tier (from pack_economics_snapshots),
 * (2) realized margin per tier (from packs.pack_ev_at_purchase / price_paid),
 * (3) cumulative platform fee revenue, and (4) any solver self-test failure
 * loud-banner data. Self-test rows are surfaced even when is_active=false —
 * the build plan calls them "a debugging surface" and the user constraint
 * was: "don't hide solver disagreement."
 */
export const GET = withErrors(async () => {
  await requireAuth();

  const [activeSnapshots, realizedRows, [feeRow], selfTestRows] = await Promise.all([
    db
      .select({
        tier: packEconomicsSnapshots.tier,
        weights: packEconomicsSnapshots.weights,
        targetMargin: packEconomicsSnapshots.targetMargin,
        evCents: packEconomicsSnapshots.evCents,
        winRate: packEconomicsSnapshots.winRate,
        createdAt: packEconomicsSnapshots.createdAt,
        notes: packEconomicsSnapshots.notes,
      })
      .from(packEconomicsSnapshots)
      .where(eq(packEconomicsSnapshots.isActive, true)),
    db
      .select({
        tier: packs.tier,
        packsOpened: count(packs.id),
        avgRealizedEv: avg(packs.packEvAtPurchase),
      })
      .from(packs)
      .where(isNotNull(packs.openedAt))
      .groupBy(packs.tier),
    db
      .select({ total: sum(walletLedger.amount) })
      .from(walletLedger)
      .where(
        and(
          eq(walletLedger.userId, PLATFORM_USER_ID),
          inArray(walletLedger.type, ['LISTING_FEE', 'AUCTION_FEE']),
        ),
      ),
    // Most recent self-test-failed snapshot across all tiers. Surfaced in a
    // red banner regardless of which tier failed.
    db
      .select({
        tier: packEconomicsSnapshots.tier,
        notes: packEconomicsSnapshots.notes,
        createdAt: packEconomicsSnapshots.createdAt,
        targetMargin: packEconomicsSnapshots.targetMargin,
      })
      .from(packEconomicsSnapshots)
      .where(
        and(
          eq(packEconomicsSnapshots.isActive, false),
          like(packEconomicsSnapshots.notes, `${SELF_TEST_FAILED_PREFIX}%`),
        ),
      )
      .orderBy(desc(packEconomicsSnapshots.createdAt))
      .limit(1),
  ]);

  const realizedByTier = new Map(realizedRows.map((r) => [r.tier, r]));
  const tierSummary = TIERS.map((tier) => {
    const snap = activeSnapshots.find((s) => s.tier === tier) ?? null;
    const realized = realizedByTier.get(tier) ?? null;
    const config = TIER_CONFIG[tier];
    const realizedEvCents =
      realized?.avgRealizedEv != null ? Math.round(Number(realized.avgRealizedEv)) : null;
    const realizedMargin =
      realizedEvCents !== null
        ? (config.priceCents - realizedEvCents) / config.priceCents
        : null;
    const targetMargin = snap ? Number(snap.targetMargin) : null;
    const marginDelta =
      targetMargin !== null && realizedMargin !== null
        ? realizedMargin - targetMargin
        : null;
    return {
      tier,
      priceCents: config.priceCents,
      packsOpened: realized ? Number(realized.packsOpened) : 0,
      activeSnapshot: snap
        ? {
            targetMargin,
            evCents: snap.evCents,
            winRate: Number(snap.winRate),
            createdAt: snap.createdAt,
          }
        : null,
      realizedEvCents,
      realizedMargin,
      marginDelta,
      // Build-plan threshold: |actual - target| > 0.02 → red banner.
      marginAlert: marginDelta !== null && Math.abs(marginDelta) > 0.02,
    };
  });

  const totalFeesCents = Number(feeRow?.total ?? 0);

  const failedRow = selfTestRows[0] ?? null;
  const selfTestFailure = failedRow
    ? {
        tier: failedRow.tier as Tier,
        rawNotes: failedRow.notes,
        createdAt: failedRow.createdAt,
        ...parseSelfTestNotes(failedRow.notes),
      }
    : null;

  return NextResponse.json({
    tiers: tierSummary,
    totalFeesCents,
    selfTestFailure,
  });
});
