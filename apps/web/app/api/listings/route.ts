import { NextResponse } from 'next/server';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import {
  cardPrices,
  cards,
  db,
  listings,
  userCards,
  users,
} from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import {
  CardNotAvailableError,
  CardNotOwnedError,
  InvalidPriceError,
} from '@/lib/errors';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  userCardId: z.string().uuid(),
  priceCents: z.number().int().positive(),
});

export const POST = withErrors(async (req) => {
  const user = await requireAuth();
  const body = createSchema.parse(await req.json());
  if (body.priceCents <= 0) throw new InvalidPriceError();

  const result = await db.transaction(async (tx) => {
    const [card] = await tx
      .select({
        id: userCards.id,
        ownerId: userCards.ownerId,
        state: userCards.state,
      })
      .from(userCards)
      .where(eq(userCards.id, body.userCardId))
      .for('update');
    if (!card || card.ownerId !== user.id) throw new CardNotOwnedError();
    if (card.state !== 'OWNED') throw new CardNotAvailableError();

    const [created] = await tx
      .insert(listings)
      .values({
        sellerId: user.id,
        userCardId: body.userCardId,
        price: body.priceCents,
      })
      .returning({ id: listings.id });
    if (!created) throw new Error('listing insert returned no row');

    await tx
      .update(userCards)
      .set({ state: 'LISTED' })
      .where(eq(userCards.id, body.userCardId));

    return created;
  });

  return NextResponse.json({ listingId: result.id }, { status: 201 });
});

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

export const GET = withErrors(async (req) => {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));
  const cursor = url.searchParams.get('cursor');

  const cursorDate = cursor ? new Date(cursor) : null;
  const where =
    cursorDate && !Number.isNaN(cursorDate.valueOf())
      ? and(eq(listings.state, 'ACTIVE'), lt(listings.createdAt, cursorDate))
      : eq(listings.state, 'ACTIVE');

  const rows = await db
    .select({
      id: listings.id,
      price: listings.price,
      createdAt: listings.createdAt,
      sellerDisplayName: users.displayName,
      cardId: userCards.cardId,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrlSmall,
      currentPrice: cardPrices.price,
    })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .innerJoin(userCards, eq(userCards.id, listings.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(where)
    .orderBy(desc(listings.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt : null;
  return NextResponse.json({ items, nextCursor });
});
