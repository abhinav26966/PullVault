import { NextResponse } from 'next/server';
import { asc, desc, eq } from 'drizzle-orm';
import { db, seedPool } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';

export const dynamic = 'force-dynamic';

/**
 * /api/audit/commits — Part B §12.
 *
 * Public, no auth. Lists pre-published seed commits so any user can confirm
 * their own pack's commit was already in this set *before* their purchase
 * (i.e. the server could not have crafted the seed for their specific
 * cards). Two views:
 *
 *   ?status=unused (default) — currently-unused commits, oldest first.
 *   ?status=used             — recently-used commits, with the pack id.
 *   ?status=all              — both, unused interleaved with used.
 *
 * `server_seed` is intentionally NOT exposed for unused entries — revealing
 * it would let an observer pre-compute outcomes for the next pack draw.
 * Used entries' server_seed is fetched via the verify-data endpoint per pack
 * (where it's already public post-purchase).
 */
export const GET = withErrors(async (req) => {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'unused';
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));

  if (status === 'unused') {
    const commits = await db
      .select({
        commit: seedPool.commit,
        createdAt: seedPool.createdAt,
      })
      .from(seedPool)
      .where(eq(seedPool.used, false))
      .orderBy(asc(seedPool.createdAt))
      .limit(limit);
    return NextResponse.json({ status: 'unused', count: commits.length, commits });
  }

  if (status === 'used') {
    const commits = await db
      .select({
        commit: seedPool.commit,
        createdAt: seedPool.createdAt,
        usedAt: seedPool.usedAt,
        usedForPackId: seedPool.usedForPackId,
      })
      .from(seedPool)
      .where(eq(seedPool.used, true))
      .orderBy(desc(seedPool.usedAt))
      .limit(limit);
    return NextResponse.json({ status: 'used', count: commits.length, commits });
  }

  // status=all — return both, unused first (oldest), then used (newest used).
  const unused = await db
    .select({ commit: seedPool.commit, createdAt: seedPool.createdAt })
    .from(seedPool)
    .where(eq(seedPool.used, false))
    .orderBy(asc(seedPool.createdAt))
    .limit(limit);
  const used = await db
    .select({
      commit: seedPool.commit,
      createdAt: seedPool.createdAt,
      usedAt: seedPool.usedAt,
      usedForPackId: seedPool.usedForPackId,
    })
    .from(seedPool)
    .where(eq(seedPool.used, true))
    .orderBy(desc(seedPool.usedAt))
    .limit(limit);
  return NextResponse.json({ status: 'all', unused, used });
});
