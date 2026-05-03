import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, listings, userCards } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import {
  ListingNotFoundError,
  ListingUnavailableError,
  NotListingOwnerError,
} from '@/lib/errors';
import { publish } from '@/lib/redis-publish';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export const POST = withErrors<{ id: string }>(async (_req, ctx) => {
  const user = await requireAuth();
  const listingId = ctx.params.id;

  await db.transaction(async (tx) => {
    const [listing] = await tx
      .select({
        id: listings.id,
        sellerId: listings.sellerId,
        state: listings.state,
        userCardId: listings.userCardId,
      })
      .from(listings)
      .where(eq(listings.id, listingId))
      .for('update');
    if (!listing) throw new ListingNotFoundError();
    if (listing.sellerId !== user.id) throw new NotListingOwnerError();
    if (listing.state !== 'ACTIVE') throw new ListingUnavailableError();

    await tx
      .update(listings)
      .set({ state: 'CANCELLED' })
      .where(eq(listings.id, listingId));
    await tx
      .update(userCards)
      .set({ state: 'OWNED' })
      .where(eq(userCards.id, listing.userCardId));
  });

  await publish(`listing:${listingId}`, { state: 'CANCELLED' });
  return NextResponse.json({ ok: true });
});
