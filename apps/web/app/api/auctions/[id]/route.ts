import { NextResponse } from 'next/server';
import { aliasedTable, desc, eq } from 'drizzle-orm';
import {
  auctions,
  bids,
  cardPrices,
  cards,
  db,
  userCards,
  users,
} from '@pullvault/db';
import { computeMinValidBid } from '@pullvault/domain';
import { withErrors } from '@/lib/api-handler';
import { AuctionNotFoundError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export const GET = withErrors<{ id: string }>(async (_req, ctx) => {
  const auctionId = ctx.params.id;
  const bidder = aliasedTable(users, 'bidder');

  const [a] = await db
    .select({
      id: auctions.id,
      startingBid: auctions.startingBid,
      currentBidAmount: auctions.currentBidAmount,
      currentBidUserId: auctions.currentBidUserId,
      endsAt: auctions.endsAt,
      state: auctions.state,
      sellerId: auctions.sellerId,
      sellerDisplayName: users.displayName,
      userCardId: auctions.userCardId,
      cardId: userCards.cardId,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrl,
      currentMarketPrice: cardPrices.price,
    })
    .from(auctions)
    .innerJoin(users, eq(users.id, auctions.sellerId))
    .innerJoin(userCards, eq(userCards.id, auctions.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(eq(auctions.id, auctionId))
    .limit(1);
  if (!a) throw new AuctionNotFoundError();

  const recentBids = await db
    .select({
      id: bids.id,
      amount: bids.amount,
      placedAt: bids.placedAt,
      bidderId: bids.bidderId,
      bidderDisplayName: bidder.displayName,
    })
    .from(bids)
    .innerJoin(bidder, eq(bidder.id, bids.bidderId))
    .where(eq(bids.auctionId, auctionId))
    .orderBy(desc(bids.placedAt))
    .limit(50);

  return NextResponse.json({
    ...a,
    endsAt: a.endsAt.toISOString(),
    minNextBidCents: computeMinValidBid(a.currentBidAmount, a.startingBid),
    bids: recentBids.map((b) => ({ ...b, placedAt: b.placedAt.toISOString() })),
  });
});
