import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auctions, db, userCards } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import {
  AuctionClosedError,
  AuctionHasBidsError,
  AuctionNotFoundError,
  NotAuctionOwnerError,
} from '@/lib/errors';
import { publish } from '@/lib/redis-publish';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export const POST = withErrors<{ id: string }>(async (_req, ctx) => {
  const user = await requireAuth();
  const auctionId = ctx.params.id;

  await db.transaction(async (tx) => {
    const [auction] = await tx
      .select({
        id: auctions.id,
        sellerId: auctions.sellerId,
        state: auctions.state,
        userCardId: auctions.userCardId,
        currentBidUserId: auctions.currentBidUserId,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .for('update');
    if (!auction) throw new AuctionNotFoundError();
    if (auction.sellerId !== user.id) throw new NotAuctionOwnerError();
    if (auction.state !== 'OPEN') throw new AuctionClosedError();
    if (auction.currentBidUserId !== null) throw new AuctionHasBidsError();

    await tx
      .update(auctions)
      .set({ state: 'CLOSED', settledAt: new Date() })
      .where(eq(auctions.id, auctionId));
    await tx
      .update(userCards)
      .set({ state: 'OWNED' })
      .where(eq(userCards.id, auction.userCardId));
  });

  await publish(`auction:${auctionId}`, {
    event: 'closed',
    state: 'CLOSED',
    winnerId: null,
    finalBid: null,
  });
  return NextResponse.json({ ok: true });
});
