import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  cardPrices,
  cards,
  db,
  packs,
  userCards,
} from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';
import CollectionClient from './collection-client';

export const dynamic = 'force-dynamic';

export default async function CollectionPage() {
  const user = await requireAuth();

  const items = await db
    .select({
      userCardId: userCards.id,
      cardId: userCards.cardId,
      acquiredPrice: userCards.acquiredPrice,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrlSmall,
      currentPrice: cardPrices.price,
    })
    .from(userCards)
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(and(eq(userCards.ownerId, user.id), eq(userCards.state, 'OWNED')))
    .orderBy(asc(userCards.acquiredAt));

  const unopened = await db
    .select({
      id: packs.id,
      tier: packs.tier,
      pricePaid: packs.pricePaid,
    })
    .from(packs)
    .where(and(eq(packs.ownerId, user.id), isNull(packs.openedAt)))
    .orderBy(asc(packs.purchasedAt));

  return <CollectionClient items={items} unopened={unopened} />;
}
