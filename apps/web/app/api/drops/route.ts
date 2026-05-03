import { NextResponse } from 'next/server';
import { and, asc, gt, inArray } from 'drizzle-orm';
import { db, packDrops } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';

export const dynamic = 'force-dynamic';

export const GET = withErrors(async () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const drops = await db
    .select()
    .from(packDrops)
    .where(
      and(
        inArray(packDrops.state, ['SCHEDULED', 'OPEN']),
        gt(packDrops.startsAt, oneHourAgo),
      ),
    )
    .orderBy(asc(packDrops.startsAt));
  return NextResponse.json({ drops });
});
