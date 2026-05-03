'use server';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  cardPrices,
  db,
  packCards,
  packs,
  userCards,
} from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';

/**
 * Mark a pack as opened and materialise its slots into user_cards.
 *
 * The conditional UPDATE on `opened_at IS NULL` is the gate: if it returns
 * zero rows (already opened, or not the owner) the transaction returns
 * before any user_cards are inserted. Two simultaneous "Rip Open" clicks
 * race the same way Phase 5's inventory race does — first wins, second
 * sees the new committed `opened_at` and matches zero rows.
 *
 * acquired_price snapshots `card_prices.price` at open time. If a price
 * row is missing it falls through to 0, matching the Phase 5 buy route's
 * EV-snapshot convention.
 */
export async function openPack(packId: string): Promise<void> {
  const user = await requireAuth();

  await db.transaction(async (tx) => {
    const opened = await tx
      .update(packs)
      .set({ openedAt: new Date() })
      .where(
        and(
          eq(packs.id, packId),
          eq(packs.ownerId, user.id),
          isNull(packs.openedAt),
        ),
      )
      .returning({ id: packs.id });
    if (opened.length === 0) return;

    const slots = await tx
      .select({ cardId: packCards.cardId })
      .from(packCards)
      .where(eq(packCards.packId, packId));
    if (slots.length === 0) return;

    const priceRows = await tx
      .select({ id: cardPrices.cardId, price: cardPrices.price })
      .from(cardPrices)
      .where(
        inArray(
          cardPrices.cardId,
          slots.map((s) => s.cardId),
        ),
      );
    const priceMap = new Map(priceRows.map((p) => [p.id, p.price]));

    await tx.insert(userCards).values(
      slots.map((s) => ({
        ownerId: user.id,
        cardId: s.cardId,
        acquiredPrice: priceMap.get(s.cardId) ?? 0,
        acquiredVia: 'PACK' as const,
      })),
    );
  });
}
