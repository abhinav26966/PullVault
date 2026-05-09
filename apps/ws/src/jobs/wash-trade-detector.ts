import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import {
  accountClusters,
  auctionFlags,
  auctions,
  bids,
  cardPrices,
  cards,
  db,
  listings,
  userCards,
  users,
} from '@pullvault/db';

/**
 * Wash-trade detector cron — Part B §11.
 *
 * Every 5 minutes, scans recently-settled auctions and scores each against a
 * weighted signal panel. Score ≥ 55 inserts an auction_flags row; the admin
 * /admin/auctions queue surfaces them for review. Detection only — no
 * auto-cancellation.
 *
 * Signals shipped (8 of the 9 in BUILD_PLAN_PART_B §11):
 *   1. +30 seller and winner share signup_ip
 *   2. +25 ≥ 2 prior P2P trades between the two users
 *   3. +20 both belong to the same account_clusters row
 *   4. +20 final bid < 50% of card market value at close
 *   5. +20 single distinct bidder on the auction
 *   6. +15 account-age delta < 7 days
 *   7. +20 ≥ 2 prior shared-IP auctions between same IP in last 30 days
 *   9. +10 winning bid is exactly the minimum increment over starting bid
 *
 * Signal 8 (time-of-day activity clustering) is deferred — needs an
 * activity-histogram correlation that is more expensive than the rest.
 * Threshold 55 still gates "two strong signals" (e.g. 30+25, 20+20+20).
 *
 * Idempotency: LEFT JOIN auction_flags filter ensures each auction is
 * scored at most once per row. Re-flagging after admin clears would need
 * a separate "rescore" trigger, deferred.
 */

const WASH_TRADE_THRESHOLD = 55;
const PRIOR_TRADE_THRESHOLD = 2;
const PRIOR_SHARED_IP_AUCTIONS_THRESHOLD = 2;
const ACCOUNT_AGE_DELTA_MS = 7 * 24 * 3_600 * 1_000;
const BELOW_MARKET_RATIO = 0.5;
const RECENT_AUCTION_WINDOW = sql`now() - interval '1 hour'`;
const PRIOR_AUCTION_WINDOW = sql`now() - interval '30 days'`;

interface Reason {
  readonly code: string;
  readonly weight: number;
}

interface ScoreResult {
  readonly score: number;
  readonly reasons: readonly Reason[];
}

function bump(reasons: Reason[], code: string, weight: number): number {
  reasons.push({ code, weight });
  return weight;
}

function asNumber(row: unknown): number {
  if (!row) return 0;
  // postgres-js returns rows as plain objects; some fields come back as
  // strings (bigint count). Coerce safely.
  const r = row as Record<string, unknown>;
  const v = r.count ?? r.n ?? Object.values(r)[0];
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function scoreOne(auctionId: string): Promise<ScoreResult | null> {
  const [auction] = await db
    .select({
      id: auctions.id,
      sellerId: auctions.sellerId,
      winnerId: auctions.currentBidUserId,
      finalBid: auctions.currentBidAmount,
      startingBid: auctions.startingBid,
      cardId: cards.id,
      marketCents: cardPrices.price,
    })
    .from(auctions)
    .innerJoin(userCards, eq(userCards.id, auctions.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, cards.id))
    .where(eq(auctions.id, auctionId))
    .limit(1);
  if (!auction || !auction.winnerId || !auction.finalBid) return null;

  const partyRows = await db
    .select({
      id: users.id,
      signupIp: users.signupIp,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(or(eq(users.id, auction.sellerId), eq(users.id, auction.winnerId)));
  const seller = partyRows.find((u) => u.id === auction.sellerId);
  const winner = partyRows.find((u) => u.id === auction.winnerId);
  if (!seller || !winner) return null;

  const reasons: Reason[] = [];
  let score = 0;
  const sharedIp =
    seller.signupIp && winner.signupIp && seller.signupIp === winner.signupIp;

  if (sharedIp) score += bump(reasons, 'shared_signup_ip', 30);

  const ageDelta = Math.abs(seller.createdAt.getTime() - winner.createdAt.getTime());
  if (ageDelta < ACCOUNT_AGE_DELTA_MS) {
    score += bump(reasons, 'account_age_delta_lt_7d', 15);
  }

  const distinctBiddersResult = await db.execute(sql`
    SELECT COUNT(DISTINCT ${bids.bidderId}) AS count
    FROM ${bids}
    WHERE ${bids.auctionId} = ${auctionId}
  `);
  const distinctBidders = asNumber(
    (distinctBiddersResult as unknown as { rows?: unknown[] }).rows?.[0] ??
      (distinctBiddersResult as unknown as unknown[])[0],
  );
  if (distinctBidders === 1) score += bump(reasons, 'single_bidder', 20);

  if (auction.marketCents > 0 && auction.finalBid < auction.marketCents * BELOW_MARKET_RATIO) {
    score += bump(reasons, 'price_below_50pct_market', 20);
  }

  const minOverStart =
    auction.startingBid + Math.max(50, Math.ceil(auction.startingBid * 0.05));
  if (auction.finalBid === minOverStart) {
    score += bump(reasons, 'min_increment_only', 10);
  }

  // Signal 2 — prior P2P trades (listings settled + auctions previously won).
  const priorRes = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM ${listings}
        WHERE ${listings.state} = 'SOLD'
          AND ((${listings.sellerId} = ${seller.id} AND ${listings.buyerId} = ${winner.id})
            OR (${listings.sellerId} = ${winner.id} AND ${listings.buyerId} = ${seller.id})))
      +
      (SELECT COUNT(*) FROM ${auctions}
        WHERE ${auctions.state} = 'SETTLED' AND ${auctions.id} <> ${auctionId}
          AND ((${auctions.sellerId} = ${seller.id} AND ${auctions.currentBidUserId} = ${winner.id})
            OR (${auctions.sellerId} = ${winner.id} AND ${auctions.currentBidUserId} = ${seller.id})))
      AS count
  `);
  const priorTrades = asNumber(
    (priorRes as unknown as { rows?: unknown[] }).rows?.[0] ??
      (priorRes as unknown as unknown[])[0],
  );
  if (priorTrades >= PRIOR_TRADE_THRESHOLD) {
    score += bump(reasons, 'prior_p2p_trades', 25);
  }

  // Signal 7 — prior shared-IP auctions in last 30 days (only if shared_ip).
  if (sharedIp) {
    const ipPriorRes = await db.execute(sql`
      SELECT COUNT(*) AS count FROM ${auctions} a
      JOIN ${users} s ON s.id = a.seller_id
      JOIN ${users} w ON w.id = a.current_bid_user_id
      WHERE a.state = 'SETTLED' AND a.id <> ${auctionId}
        AND a.settled_at > ${PRIOR_AUCTION_WINDOW}
        AND s.signup_ip = w.signup_ip AND s.signup_ip = ${seller.signupIp}
    `);
    const ipPriorCount = asNumber(
      (ipPriorRes as unknown as { rows?: unknown[] }).rows?.[0] ??
        (ipPriorRes as unknown as unknown[])[0],
    );
    if (ipPriorCount >= PRIOR_SHARED_IP_AUCTIONS_THRESHOLD) {
      score += bump(reasons, 'prior_shared_ip_auctions', 20);
    }
  }

  // Signal 3 — same account_clusters row.
  const clusters = await db
    .select({ userIds: accountClusters.userIds })
    .from(accountClusters);
  for (const c of clusters) {
    if (c.userIds.includes(seller.id) && c.userIds.includes(winner.id)) {
      score += bump(reasons, 'account_cluster_overlap', 20);
      break;
    }
  }

  return { score, reasons };
}

async function runOnce(): Promise<void> {
  // Find recently-settled auctions that are NOT yet flagged.
  const recent = await db
    .select({ id: auctions.id })
    .from(auctions)
    .leftJoin(auctionFlags, eq(auctionFlags.auctionId, auctions.id))
    .where(
      and(
        eq(auctions.state, 'SETTLED'),
        gt(auctions.settledAt, RECENT_AUCTION_WINDOW),
        isNull(auctionFlags.id),
      ),
    );

  if (recent.length === 0) return;

  let flagged = 0;
  for (const row of recent) {
    try {
      const r = await scoreOne(row.id);
      if (!r) continue;
      if (r.score < WASH_TRADE_THRESHOLD) continue;
      await db.insert(auctionFlags).values({
        auctionId: row.id,
        score: r.score,
        reasons: r.reasons as unknown as Record<string, unknown>,
      });
      flagged++;
      console.log(
        `[wash-trade] flagged ${row.id} score=${r.score} reasons=${r.reasons.map((x) => x.code).join(',')}`,
      );
    } catch (err) {
      console.error(`[wash-trade] failed ${row.id}`, err);
    }
  }
  if (flagged > 0) console.log(`[wash-trade] ${flagged} new flag(s) this tick`);
}

export function scheduleWashTradeDetector(): ScheduledTask {
  return cron.schedule('*/5 * * * *', async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[wash-trade] tick failed', err);
    }
  });
}

export async function runWashTradeDetectorNow(): Promise<void> {
  await runOnce();
}
