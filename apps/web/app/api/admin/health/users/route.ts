import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const RETENTION_THRESHOLD = 0.3;

/**
 * /api/admin/health/users — Part B §13.
 *
 * DAU = distinct users with a wallet_ledger row in the last 24 h. Retention =
 * fraction of users created ≥ 7 days ago who acted in the last 7 days. Pack
 * buyers = distinct users with a PACK_PURCHASE in the last 7 days.
 *
 * The query suite avoids loading entire user/ledger tables — every metric is
 * a count() with a WHERE filter so the dashboard refresh stays cheap.
 */
export const GET = withErrors(async () => {
  await requireAuth();

  const [counts] = await db.execute<
    {
      total_users: string;
      dau: string;
      retention_eligible: string;
      retention_acted: string;
      pack_buyers_7d: string;
    } & Record<string, unknown>
  >(sql`
    SELECT
      (SELECT count(*)::text FROM users) AS total_users,
      (SELECT count(DISTINCT user_id)::text
         FROM wallet_ledger
         WHERE created_at > now() - interval '24 hours') AS dau,
      (SELECT count(*)::text
         FROM users
         WHERE created_at < now() - interval '7 days') AS retention_eligible,
      (SELECT count(*)::text FROM users u
         WHERE u.created_at < now() - interval '7 days'
           AND EXISTS (
             SELECT 1 FROM wallet_ledger l
              WHERE l.user_id = u.id
                AND l.created_at > now() - interval '7 days'
           )) AS retention_acted,
      (SELECT count(DISTINCT user_id)::text
         FROM wallet_ledger
         WHERE type = 'PACK_PURCHASE'
           AND created_at > now() - interval '7 days') AS pack_buyers_7d
  `);

  const totalUsers = Number(counts?.total_users ?? 0);
  const dau = Number(counts?.dau ?? 0);
  const retentionEligible = Number(counts?.retention_eligible ?? 0);
  const retentionActed = Number(counts?.retention_acted ?? 0);
  const packBuyers7d = Number(counts?.pack_buyers_7d ?? 0);
  const retention7d = retentionEligible > 0 ? retentionActed / retentionEligible : null;

  return NextResponse.json({
    retentionThreshold: RETENTION_THRESHOLD,
    totalUsers,
    dau,
    retentionEligible,
    retentionActed,
    retention7d,
    retentionAlert: retention7d !== null && retention7d < RETENTION_THRESHOLD,
    packBuyers7d,
  });
});
