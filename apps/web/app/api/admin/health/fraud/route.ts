import { NextResponse } from 'next/server';
import { count, desc, gt, isNull, sql } from 'drizzle-orm';
import {
  accountClusters,
  auctionFlags,
  db,
  rateLimitAudit,
  users,
} from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const BOT_THRESHOLD = 80;

/**
 * /api/admin/health/fraud — Part B §13.
 *
 * Surfaces the bot-scoring + clustering + rate-limit telemetry written by
 * the B2 cron jobs and the wash-trade flag table from B3. None of this is a
 * blocking signal — production policy is detect-only — but the dashboard
 * lets an operator triage users and decide whether to act.
 */
export const GET = withErrors(async () => {
  await requireAuth();

  const [highRisk, highRiskCountRows, clusterCountRows, unreviewedFlagRows, blockCountRows, topClusters] =
    await Promise.all([
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          botScore: users.botScore,
          flagMultiAccount: users.flagMultiAccount,
          signupAt: users.createdAt,
        })
        .from(users)
        .where(gt(users.botScore, BOT_THRESHOLD))
        .orderBy(desc(users.botScore))
        .limit(20),
      db
        .select({ value: count() })
        .from(users)
        .where(gt(users.botScore, BOT_THRESHOLD)),
      db.select({ value: count() }).from(accountClusters),
      db
        .select({ value: count() })
        .from(auctionFlags)
        .where(isNull(auctionFlags.reviewedAt)),
      // Rate-limit blocks in the last 24h. Postgres-side filter keeps the
      // network payload tiny for a metric that only needs the count.
      db.execute<{ value: string } & Record<string, unknown>>(
        sql`SELECT count(*)::text AS value FROM rate_limit_audit WHERE blocked_at > now() - interval '24 hours'`,
      ),
      db
        .select({
          id: accountClusters.id,
          reason: accountClusters.reason,
          userIds: accountClusters.userIds,
          createdAt: accountClusters.createdAt,
        })
        .from(accountClusters)
        .orderBy(desc(accountClusters.createdAt))
        .limit(10),
    ]);

  return NextResponse.json({
    botThreshold: BOT_THRESHOLD,
    highRiskCount: Number(highRiskCountRows[0]?.value ?? 0),
    highRiskUsers: highRisk,
    clusterCount: Number(clusterCountRows[0]?.value ?? 0),
    unreviewedAuctionFlags: Number(unreviewedFlagRows[0]?.value ?? 0),
    rateLimitBlocks24h: Number(blockCountRows[0]?.value ?? 0),
    topClusters: topClusters.map((c) => ({
      id: c.id,
      reason: c.reason,
      userCount: c.userIds.length,
      createdAt: c.createdAt,
    })),
  });
});
