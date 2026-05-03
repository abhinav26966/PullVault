import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  cardPrices,
  cards,
  db,
  listings,
  userCards,
  users,
} from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { ListingNotFoundError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export const GET = withErrors<{ id: string }>(async (_req, ctx) => {
  const [row] = await db
    .select({
      id: listings.id,
      price: listings.price,
      state: listings.state,
      createdAt: listings.createdAt,
      soldAt: listings.soldAt,
      sellerId: listings.sellerId,
      sellerDisplayName: users.displayName,
      userCardId: listings.userCardId,
      cardId: userCards.cardId,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrl,
      imageUrlSmall: cards.imageUrlSmall,
      currentPrice: cardPrices.price,
    })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .innerJoin(userCards, eq(userCards.id, listings.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(eq(listings.id, ctx.params.id))
    .limit(1);
  if (!row) throw new ListingNotFoundError();

  return NextResponse.json({
    ...row,
    createdAt: row.createdAt.toISOString(),
    soldAt: row.soldAt ? row.soldAt.toISOString() : null,
  });
});
