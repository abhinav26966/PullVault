import { NextResponse } from 'next/server';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  auctions,
  bids,
  db,
  walletLedger,
  wallets,
} from '@pullvault/db';
import {
  ANTI_SNIPE_EXTENSION_SECONDS,
  validateBid,
} from '@pullvault/domain';
import { withErrors } from '@/lib/api-handler';
import {
  AuctionClosedError,
  AuctionNotFoundError,
  BidTooHighError,
  BidTooLowError,
  InsufficientFundsError,
  SellerCannotBidError,
} from '@/lib/errors';
import { withRateLimit } from '@/lib/rate-limit/middleware';
import { publish } from '@/lib/redis-publish';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  bidCents: z.number().int().positive(),
});

/**
 * Atomic bid — ARCHITECTURE §6.3 verbatim. The most concurrency-sensitive
 * transaction in the build. Hold-then-release order is critical: place the
 * new hold first so a short-funded new bidder fails before we touch the
 * previous bidder's wallet. There is never a window where neither party
 * has the funds held.
 *
 * Order of operations:
 *   1. Lock auction FOR UPDATE; abort if not OPEN or already past endsAt.
 *   2. Reject seller-self-bid.
 *   3. validateBid (TOO_LOW / TOO_HIGH) using shared domain function.
 *   4. Atomic conditional new hold on bidder (gte balance_available).
 *   5. AUCTION_HOLD ledger row.
 *   6. Release previous hold (UPDATE wallet + AUCTION_RELEASE ledger row).
 *   7. Compute anti-snipe extension via JS computeNewEndsAt.
 *   8. UPDATE auction with new high bid + endsAt.
 *   9. INSERT bid history row.
 *  10. After commit: publish auction:{id} bid event + user:{prev} outbid.
 *
 * D.4 (race for same bid value): step 1's FOR UPDATE serialises. Whichever
 * tx commits first becomes the new high. The second's validateBid runs
 * against the new currentBid and rejects with TOO_LOW.
 *
 * D.8 (held untouchable): step 4's `gte(balance_available, bid)` ignores
 * balance_held entirely.
 */
export const POST = withErrors<{ id: string }>(
  withRateLimit<{ id: string }>(
    {
      endpoint: 'bid_auction',
      // 5 bids / 30s per user — also enforces B3's rapid-fire detection.
      user: { limit: 5, windowMs: 30_000 },
    },
    async (req, ctx) => {
  const bidder = await requireAuth();
  const auctionId = ctx.params.id;
  const body = bodySchema.parse(await req.json());
  const newBidAmount = body.bidCents;

  const result = await db.transaction(async (tx) => {
    const [auction] = await tx
      .select({
        id: auctions.id,
        sellerId: auctions.sellerId,
        startingBid: auctions.startingBid,
        currentBidAmount: auctions.currentBidAmount,
        currentBidUserId: auctions.currentBidUserId,
        endsAt: auctions.endsAt,
        state: auctions.state,
      })
      .from(auctions)
      .where(eq(auctions.id, auctionId))
      .for('update');
    if (!auction) throw new AuctionNotFoundError();
    if (auction.state !== 'OPEN') throw new AuctionClosedError();

    const now = new Date();
    if (auction.endsAt <= now) throw new AuctionClosedError();
    if (auction.sellerId === bidder.id) throw new SellerCannotBidError();

    const validation = validateBid(
      auction.currentBidAmount,
      auction.startingBid,
      newBidAmount,
    );
    if (!validation.ok) {
      if (validation.reason === 'TOO_LOW') throw new BidTooLowError();
      throw new BidTooHighError();
    }

    const heldCheck = await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} - ${newBidAmount}`,
        balanceHeld: sql`${wallets.balanceHeld} + ${newBidAmount}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(wallets.userId, bidder.id),
          gte(wallets.balanceAvailable, newBidAmount),
        ),
      )
      .returning({ available: wallets.balanceAvailable });
    if (heldCheck.length === 0) throw new InsufficientFundsError();

    await tx.insert(walletLedger).values({
      userId: bidder.id,
      type: 'AUCTION_HOLD',
      amount: 0,
      auctionId,
      meta: { newBidAmount },
    });

    if (auction.currentBidUserId && auction.currentBidAmount) {
      await tx
        .update(wallets)
        .set({
          balanceAvailable: sql`${wallets.balanceAvailable} + ${auction.currentBidAmount}`,
          balanceHeld: sql`${wallets.balanceHeld} - ${auction.currentBidAmount}`,
          updatedAt: now,
        })
        .where(eq(wallets.userId, auction.currentBidUserId));

      await tx.insert(walletLedger).values({
        userId: auction.currentBidUserId,
        type: 'AUCTION_RELEASE',
        amount: 0,
        auctionId,
      });
    }

    // Anti-snipe via SQL-side GREATEST + clock_timestamp() — §6.3 spirit, fixed
    // semantics. The doc sketch uses `now()`, which in Postgres is an alias for
    // transaction_timestamp() and is FROZEN at tx start. With multiple
    // statements over the Supabase pooler, the bid tx routinely spans several
    // seconds; `now()` underestimates the actual write moment by that span,
    // making the effective extension <30s of real wall-clock time. The spec's
    // intent in §15 ("bidPlacedAt + 30s") is the wall-clock moment of the
    // write, so use clock_timestamp() which advances within the tx.
    // RETURNING hands back the actual stored value, not a JS-side echo.
    const [updated] = await tx
      .update(auctions)
      .set({
        currentBidAmount: newBidAmount,
        currentBidUserId: bidder.id,
        endsAt: sql`GREATEST(${auctions.endsAt}, clock_timestamp() + make_interval(secs => ${ANTI_SNIPE_EXTENSION_SECONDS}))`,
      })
      .where(and(eq(auctions.id, auctionId), eq(auctions.state, 'OPEN')))
      .returning({ endsAt: auctions.endsAt });
    if (!updated) throw new Error('auction update matched zero rows');

    await tx.insert(bids).values({
      auctionId,
      bidderId: bidder.id,
      amount: newBidAmount,
    });

    return {
      newBidAmount,
      newEndsAt: updated.endsAt,
      previousBidderId: auction.currentBidUserId,
    };
  });

  await publish(`auction:${auctionId}`, {
    event: 'bid',
    currentBid: result.newBidAmount,
    currentBidUserId: bidder.id,
    currentBidderDisplayName: bidder.displayName,
    endsAt: result.newEndsAt.toISOString(),
    placedAt: new Date().toISOString(),
  });

  if (result.previousBidderId && result.previousBidderId !== bidder.id) {
    await publish(`user:${result.previousBidderId}`, {
      event: 'outbid',
      auctionId,
    });
  }

  return NextResponse.json({
    currentBidCents: result.newBidAmount,
    endsAt: result.newEndsAt.toISOString(),
  });
    },
  ),
);
