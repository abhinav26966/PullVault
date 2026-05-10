import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@pullvault/db';
import {
  RARITY_ORDER,
  chiSquared,
  kolmogorovSmirnov,
  type Rarity,
  type Tier,
} from '@pullvault/domain';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const TIERS: readonly Tier[] = ['BRONZE', 'SILVER', 'GOLD'];

type AggregateRow = {
  tier: Tier;
  rarity: Rarity;
  observed_count: number;
  expected_weight: string;
  computed_at: string;
} & Record<string, unknown>;

/**
 * /api/admin/health/fairness — Part B §13.
 *
 * Reads the *latest per (tier, rarity)* row from `pack_audit_aggregates`
 * (DISTINCT ON pattern), assembles bucket vectors in the canonical
 * C → U → R → E → L order, and runs both chi-squared and K-S server-side.
 * Both p-values + raw inputs ship to the client so a reviewer can plug the
 * numbers into scipy and reproduce — the test logic is purely deterministic
 * pure code from `@pullvault/domain/stats`.
 *
 * Verdict per tier:
 *   • both p > 0.05         → 'green'  (no evidence of unfairness)
 *   • either p < 0.05       → 'red'    (significant deviation)
 *   • disagreement          → 'yellow' (one says fail, the other says pass)
 *
 * "Two tests agreeing is more informative than one; two disagreeing is itself
 * a signal." (Build plan §B5.)
 */
export const GET = withErrors(async () => {
  await requireAuth();

  const rows = await db.execute<AggregateRow>(sql`
    SELECT DISTINCT ON (tier, rarity)
      tier, rarity, observed_count, expected_weight, computed_at
    FROM pack_audit_aggregates
    ORDER BY tier, rarity, computed_at DESC
  `);

  const ALPHA = 0.05;

  const perTier = TIERS.map((tier) => {
    const tierRows = rows.filter((r) => r.tier === tier);
    if (tierRows.length === 0) {
      return {
        tier,
        rarities: [] as Array<{ rarity: Rarity; observedCount: number; expectedWeight: number }>,
        chiSquared: null,
        ks: null,
        verdict: 'unknown' as const,
        reason: 'no aggregate rows yet for this tier',
      };
    }

    // Assemble C→U→R→E→L vectors. Buckets with no observation get 0 obs and
    // their expected weight comes from the aggregator (pre-computed).
    const observed: number[] = [];
    const expectedWeights: number[] = [];
    const rarities: Array<{ rarity: Rarity; observedCount: number; expectedWeight: number }> = [];
    for (const r of RARITY_ORDER) {
      const row = tierRows.find((x) => x.rarity === r);
      const obs = row ? Number(row.observed_count) : 0;
      const exp = row ? Number(row.expected_weight) : 0;
      observed.push(obs);
      expectedWeights.push(exp);
      rarities.push({ rarity: r, observedCount: obs, expectedWeight: exp });
    }
    const totalN = observed.reduce((a, b) => a + b, 0);

    // For chi-squared we need expected COUNTS (= total * weight). Skip
    // buckets where expected weight is 0 — their expected count would be 0
    // and chiSquared would throw.
    const filteredObserved: number[] = [];
    const filteredExpectedCounts: number[] = [];
    for (let i = 0; i < observed.length; i++) {
      const w = expectedWeights[i]!;
      if (w > 0) {
        filteredObserved.push(observed[i]!);
        filteredExpectedCounts.push(totalN * w);
      }
    }

    let chi: ReturnType<typeof chiSquared> | null = null;
    if (filteredObserved.length >= 2 && totalN > 0) {
      chi = chiSquared({
        observed: filteredObserved,
        expected: filteredExpectedCounts,
      });
    }

    let ks: ReturnType<typeof kolmogorovSmirnov> | null = null;
    if (totalN > 0) {
      // K-S handles 0-weight buckets fine (the cumulative just doesn't move).
      ks = kolmogorovSmirnov({ observed, expectedWeights });
    }

    let verdict: 'green' | 'red' | 'yellow' | 'unknown' = 'unknown';
    if (chi && ks) {
      const chiFail = chi.pValue < ALPHA;
      const ksFail = ks.pValue < ALPHA;
      if (chiFail && ksFail) verdict = 'red';
      else if (!chiFail && !ksFail) verdict = 'green';
      else verdict = 'yellow';
    }

    return {
      tier,
      totalN,
      rarities,
      chiSquared: chi
        ? {
            chiSq: chi.chiSq,
            df: chi.df,
            pValue: chi.pValue,
            contributions: chi.contributions,
          }
        : null,
      ks: ks
        ? {
            d: ks.d,
            lambda: ks.lambda,
            n: ks.n,
            pValue: ks.pValue,
            cumulativeGaps: ks.cumulativeGaps,
          }
        : null,
      verdict,
    };
  });

  return NextResponse.json({ alpha: ALPHA, perTier });
});
