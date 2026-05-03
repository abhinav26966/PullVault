import { and, eq, lte, sql } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import {
  PLATFORM_USER_ID,
  auctions,
  db,
  userCards,
  users,
  walletLedger,
  wallets,
} from '@pullvault/db';
import { calculateAuctionFee } from '@pullvault/domain';
import { publisher } from '../redis';

interface SettleResult {
  state: 'SETTLED' | 'CLOSED';
  winnerId: string | null;
  winnerDisplayName: string | null;
  finalBid: number | null;
}

/**
 * Auction settlement — ARCHITECTURE §6.4 with the same two deviations the
 * marketplace buy route established: platform wallet is credited alongside
 * the AUCTION_FEE ledger row, and the winner's user_cards row resets
 * acquired_via/_price/_at to the winning bid (so the new owner's portfolio
 * P&L starts from their actual purchase, not the seller's pull-time price).
 *
 * Idempotency: the FOR UPDATE inside `state='OPEN'` is the guard. If two
 * cron tickers run concurrently (or if the WS process restarted mid-tick),
 * whichever transaction commits first flips the state; the other's lock
 * returns and matches zero rows on the WHERE clause.
 */
async function settleOne(auctionId: string): Promise<SettleResult | null> {
  return db.transaction(async (tx) => {
    const [a] = await tx
      .select({
        id: auctions.id,
        sellerId: auctions.sellerId,
        userCardId: auctions.userCardId,
        currentBidAmount: auctions.currentBidAmount,
        currentBidUserId: auctions.currentBidUserId,
      })
      .from(auctions)
      .where(and(eq(auctions.id, auctionId), eq(auctions.state, 'OPEN')))
      .for('update');
    if (!a) return null;

    const now = new Date();

    if (!a.currentBidUserId || !a.currentBidAmount) {
      await tx
        .update(userCards)
        .set({ state: 'OWNED' })
        .where(eq(userCards.id, a.userCardId));
      await tx
        .update(auctions)
        .set({ state: 'CLOSED', settledAt: now })
        .where(eq(auctions.id, a.id));
      return {
        state: 'CLOSED',
        winnerId: null,
        winnerDisplayName: null,
        finalBid: null,
      };
    }

    const fee = calculateAuctionFee(a.currentBidAmount);
    const net = a.currentBidAmount - fee;

    await tx
      .update(wallets)
      .set({
        balanceHeld: sql`${wallets.balanceHeld} - ${a.currentBidAmount}`,
        updatedAt: now,
      })
      .where(eq(wallets.userId, a.currentBidUserId));

    await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} + ${net}`,
        updatedAt: now,
      })
      .where(eq(wallets.userId, a.sellerId));

    await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} + ${fee}`,
        updatedAt: now,
      })
      .where(eq(wallets.userId, PLATFORM_USER_ID));

    await tx
      .update(userCards)
      .set({
        ownerId: a.currentBidUserId,
        state: 'OWNED',
        acquiredVia: 'AUCTION',
        acquiredPrice: a.currentBidAmount,
        acquiredAt: now,
      })
      .where(eq(userCards.id, a.userCardId));

    await tx
      .update(auctions)
      .set({ state: 'SETTLED', settledAt: now })
      .where(eq(auctions.id, a.id));

    await tx.insert(walletLedger).values([
      {
        userId: a.currentBidUserId,
        type: 'AUCTION_SETTLE_BUYER',
        amount: -a.currentBidAmount,
        auctionId: a.id,
      },
      {
        userId: a.sellerId,
        type: 'AUCTION_SETTLE_SELLER',
        amount: net,
        auctionId: a.id,
      },
      {
        userId: PLATFORM_USER_ID,
        type: 'AUCTION_FEE',
        amount: fee,
        auctionId: a.id,
      },
    ]);

    const [winner] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, a.currentBidUserId))
      .limit(1);

    return {
      state: 'SETTLED',
      winnerId: a.currentBidUserId,
      winnerDisplayName: winner?.displayName ?? null,
      finalBid: a.currentBidAmount,
    };
  });
}

async function runOnce(): Promise<void> {
  const now = new Date();
  const expired = await db
    .select({ id: auctions.id })
    .from(auctions)
    .where(and(eq(auctions.state, 'OPEN'), lte(auctions.endsAt, now)));

  if (expired.length === 0) return;

  for (const row of expired) {
    try {
      const result = await settleOne(row.id);
      if (!result) continue;
      await publisher.publish(
        `auction:${row.id}`,
        JSON.stringify({
          event: 'closed',
          state: result.state,
          winnerId: result.winnerId,
          winnerDisplayName: result.winnerDisplayName,
          finalBid: result.finalBid,
        }),
      );
      console.log(`[auction-closer] ${result.state} ${row.id}`);
    } catch (err) {
      console.error(`[auction-closer] failed ${row.id}`, err);
    }
  }
}

export function scheduleAuctionCloser(): ScheduledTask {
  return cron.schedule('*/5 * * * * *', async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[auction-closer] tick failed', err);
    }
  });
}

export async function runAuctionCloserNow(): Promise<void> {
  await runOnce();
}
