import { NextResponse } from 'next/server';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import {
  auctions,
  cardPrices,
  cards,
  db,
  userCards,
  users,
} from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import {
  CardNotAvailableError,
  CardNotOwnedError,
  InvalidAuctionDurationError,
  InvalidStartingBidError,
} from '@/lib/errors';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const VALID_DURATIONS = new Set([300, 1800, 7200]);

const createSchema = z.object({
  userCardId: z.string().uuid(),
  startPriceCents: z.number().int().positive(),
  durationSec: z.number().int().positive(),
});

export const POST = withErrors(async (req) => {
  const user = await requireAuth();
  const body = createSchema.parse(await req.json());
  if (!VALID_DURATIONS.has(body.durationSec)) throw new InvalidAuctionDurationError();
  if (body.startPriceCents <= 0) throw new InvalidStartingBidError();

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

    const now = new Date();
    const endsAt = new Date(now.getTime() + body.durationSec * 1000);

    const [created] = await tx
      .insert(auctions)
      .values({
        sellerId: user.id,
        userCardId: body.userCardId,
        startingBid: body.startPriceCents,
        startsAt: now,
        endsAt,
      })
      .returning({ id: auctions.id });
    if (!created) throw new Error('auction insert returned no row');

    await tx
      .update(userCards)
      .set({ state: 'AUCTIONED' })
      .where(eq(userCards.id, body.userCardId));

    return created;
  });

  return NextResponse.json({ auctionId: result.id }, { status: 201 });
});

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

export const GET = withErrors(async (req) => {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT));

  const now = new Date();
  const where = and(eq(auctions.state, 'OPEN'), gt(auctions.endsAt, now));

  const rows = await db
    .select({
      id: auctions.id,
      startingBid: auctions.startingBid,
      currentBidAmount: auctions.currentBidAmount,
      endsAt: auctions.endsAt,
      sellerDisplayName: users.displayName,
      cardId: userCards.cardId,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrlSmall,
      currentMarketPrice: cardPrices.price,
    })
    .from(auctions)
    .innerJoin(users, eq(users.id, auctions.sellerId))
    .innerJoin(userCards, eq(userCards.id, auctions.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(where)
    .orderBy(asc(auctions.endsAt))
    .limit(limit);

  return NextResponse.json({
    items: rows.map((r) => ({ ...r, endsAt: r.endsAt.toISOString() })),
  });
});
