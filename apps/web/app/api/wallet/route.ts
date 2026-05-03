import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, wallets } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const GET = withErrors(async () => {
  const user = await requireAuth();
  const [w] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.userId, user.id))
    .limit(1);
  return NextResponse.json({
    available: w?.balanceAvailable ?? 0,
    held: w?.balanceHeld ?? 0,
  });
});
