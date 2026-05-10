import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, packAuditAggregates } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';

export const dynamic = 'force-dynamic';

/**
 * /api/audit/aggregates — Part B §12.
 *
 * Public, no auth. Returns the latest pack_audit_aggregates row per (tier,
 * rarity), where "latest" is the row with the most recent computed_at. The
 * B5 fairness tab feeds these into chi-squared and K-S tests; surfacing the
 * raw observed/expected pair publicly lets a third party reproduce both
 * tests with a calculator.
 *
 * SQL is a DISTINCT ON (tier, rarity) ordered by computed_at desc, which is
 * the canonical "latest per group" pattern in postgres. Cheap because of
 * the partial `pack_audit_aggregates_tier_at_idx` index.
 */
export const GET = withErrors(async () => {
  const rows = await db.execute<{
    tier: string;
    rarity: string;
    observed_count: number;
    expected_weight: string;
    computed_at: string;
  }>(sql`
    SELECT DISTINCT ON (tier, rarity)
      tier, rarity, observed_count, expected_weight, computed_at
    FROM pack_audit_aggregates
    ORDER BY tier, rarity, computed_at DESC
  `);
  return NextResponse.json({
    count: rows.length,
    rows: rows.map((r) => ({
      tier: r.tier,
      rarity: r.rarity,
      observedCount: Number(r.observed_count),
      expectedWeight: Number(r.expected_weight),
      computedAt: r.computed_at,
    })),
  });
});
