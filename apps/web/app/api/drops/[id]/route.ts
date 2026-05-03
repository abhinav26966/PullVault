import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, packDrops } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';

export const dynamic = 'force-dynamic';

export const GET = withErrors<{ id: string }>(async (_req, ctx) => {
  const id = ctx.params.id;
  const [drop] = await db.select().from(packDrops).where(eq(packDrops.id, id)).limit(1);
  if (!drop) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ drop });
});
