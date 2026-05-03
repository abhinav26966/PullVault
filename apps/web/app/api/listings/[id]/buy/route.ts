import { NextResponse } from 'next/server';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  PLATFORM_USER_ID,
  db,
  listings,
  userCards,
  walletLedger,
  wallets,
} from '@pullvault/db';
import { calculateTradeFee } from '@pullvault/domain';
import { withErrors } from '@/lib/api-handler';
import {
  InsufficientFundsError,
  ListingUnavailableError,
  SellerCannotBuyOwnError,
} from '@/lib/errors';
import { publish } from '@/lib/redis-publish';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

/**
 * Atomic listing purchase — ARCHITECTURE §6.2, with two deliberate deviations
 * called out below.
 *
 * Order of operations (matters):
 *   1. Lock listing FOR UPDATE; abort if no longer ACTIVE.
 *   2. Reject self-buy before touching wallets.
 *   3. Atomic conditional debit on buyer (gte balance_available).
 *   4. Compute fee via @pullvault/domain calculateTradeFee.
 *   5. Credit seller (price - fee) AND platform (+fee).
 *   6. Transfer card ownership; reset cost basis to the buyer's purchase.
 *   7. Mark listing SOLD.
 *   8. Three ledger entries: buyer debit, seller credit, platform fee.
 *   9. After commit: publish listing:{id}, user:{seller}, user:{buyer}.
 *
 * Deviation #1 — platform wallet is updated alongside the LISTING_FEE ledger
 * row. The §6.2 sketch shows only the seller credit, but §5.2's reconciliation
 * invariant ("SUM(wallet_ledger) = wallets.balance_available + held for every
 * user, including platform") requires both sides to move together.
 *
 * Deviation #2 — on transfer, user_cards.acquired_via/_price/_at are reset to
 * the buyer's purchase (LISTING, listing.price, now). §6.2 only updates
 * owner_id + state, which leaves the new owner's cost basis pointing at the
 * seller's pull-time price and breaks portfolio P&L. Same pattern will apply
 * to auction settlement in Phase 10.
 *
 * D.3 (double-buy race): step 1's FOR UPDATE plus the WHERE on state='ACTIVE'
 * mean only one transaction can claim the listing. The second sees zero rows
 * and throws.
 *
 * D.8 (held funds untouchable): step 3's `gte(balance_available, price)`
 * ignores balance_held entirely. A user with held > available cannot debit.
 */
export const POST = withErrors<{ id: string }>(async (_req, ctx) => {
  const buyer = await requireAuth();
  const listingId = ctx.params.id;

  const result = await db.transaction(async (tx) => {
    const [listing] = await tx
      .select({
        id: listings.id,
        sellerId: listings.sellerId,
        userCardId: listings.userCardId,
        price: listings.price,
      })
      .from(listings)
      .where(and(eq(listings.id, listingId), eq(listings.state, 'ACTIVE')))
      .for('update');
    if (!listing) throw new ListingUnavailableError();
    if (listing.sellerId === buyer.id) throw new SellerCannotBuyOwnError();

    const debited = await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} - ${listing.price}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(wallets.userId, buyer.id),
          gte(wallets.balanceAvailable, listing.price),
        ),
      )
      .returning({ available: wallets.balanceAvailable });
    if (debited.length === 0) throw new InsufficientFundsError();

    const fee = calculateTradeFee(listing.price);
    const net = listing.price - fee;

    await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} + ${net}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.userId, listing.sellerId));

    await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} + ${fee}`,
        updatedAt: new Date(),
      })
      .where(eq(wallets.userId, PLATFORM_USER_ID));

    await tx
      .update(userCards)
      .set({
        ownerId: buyer.id,
        state: 'OWNED',
        acquiredVia: 'LISTING',
        acquiredPrice: listing.price,
        acquiredAt: new Date(),
      })
      .where(eq(userCards.id, listing.userCardId));

    await tx
      .update(listings)
      .set({ state: 'SOLD', soldAt: new Date(), buyerId: buyer.id })
      .where(eq(listings.id, listingId));

    await tx.insert(walletLedger).values([
      {
        userId: buyer.id,
        type: 'LISTING_PURCHASE',
        amount: -listing.price,
        listingId,
      },
      {
        userId: listing.sellerId,
        type: 'LISTING_SALE',
        amount: net,
        listingId,
      },
      {
        userId: PLATFORM_USER_ID,
        type: 'LISTING_FEE',
        amount: fee,
        listingId,
      },
    ]);

    return {
      sellerId: listing.sellerId,
      buyerId: buyer.id,
      userCardId: listing.userCardId,
      price: listing.price,
      fee,
      net,
    };
  });

  await publish(`listing:${listingId}`, {
    state: 'SOLD',
    buyerId: result.buyerId,
  });
  await publish(`user:${result.sellerId}`, {
    event: 'card_sold',
    listingId,
    userCardId: result.userCardId,
    netCents: result.net,
  });
  await publish(`user:${result.buyerId}`, {
    event: 'card_bought',
    listingId,
    userCardId: result.userCardId,
    priceCents: result.price,
  });

  return NextResponse.json({ listingId, userCardId: result.userCardId });
});
