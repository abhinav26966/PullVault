import { NextResponse } from 'next/server';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  auctions,
  cards,
  db,
  listings,
  packs,
  userCards,
  walletLedger,
} from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

// User's full activity timeline that explains how their net worth got from
// $1,000 (signup bonus) to its current value. Source = wallet_ledger
// (authoritative audit trail per §5.2) plus a synthetic "pack_opened" event
// derived from packs.opened_at (no ledger row exists for the open itself —
// money already moved at purchase). Capped at the most-recent 100 events
// after merge; ledger fee rows for the platform user are naturally excluded
// because the WHERE filter is on the current user's id.

const auctionUserCard = alias(userCards, 'auction_user_card');
const auctionCard = alias(cards, 'auction_card');

type ActivityKind =
  | 'SIGNUP_BONUS'
  | 'PACK_PURCHASE'
  | 'PACK_OPENED'
  | 'LISTING_PURCHASE'
  | 'LISTING_SALE'
  | 'AUCTION_HOLD'
  | 'AUCTION_RELEASE'
  | 'AUCTION_SETTLE_BUYER'
  | 'AUCTION_SETTLE_SELLER';

interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  amountCents: number;
  createdAt: string;
  packTier?: 'BRONZE' | 'SILVER' | 'GOLD';
  cardName?: string;
  pricePaid?: number;
  listingPrice?: number;
  auctionFinalBid?: number;
  bidAmount?: number;
  packEvAtPurchase?: number;
  cardCount?: number;
}

const TIER_CARD_COUNT: Record<'BRONZE' | 'SILVER' | 'GOLD', number> = {
  BRONZE: 5,
  SILVER: 7,
  GOLD: 10,
};

export const GET = withErrors(async () => {
  const user = await requireAuth();

  const ledgerRows = await db
    .select({
      id: walletLedger.id,
      type: walletLedger.type,
      amount: walletLedger.amount,
      createdAt: walletLedger.createdAt,
      meta: walletLedger.meta,
      packTier: packs.tier,
      pricePaid: packs.pricePaid,
      listingPrice: listings.price,
      listingCardName: cards.name,
      auctionFinalBid: auctions.currentBidAmount,
      auctionCardName: auctionCard.name,
    })
    .from(walletLedger)
    .leftJoin(packs, eq(packs.id, walletLedger.packId))
    .leftJoin(listings, eq(listings.id, walletLedger.listingId))
    .leftJoin(userCards, eq(userCards.id, listings.userCardId))
    .leftJoin(cards, eq(cards.id, userCards.cardId))
    .leftJoin(auctions, eq(auctions.id, walletLedger.auctionId))
    .leftJoin(auctionUserCard, eq(auctionUserCard.id, auctions.userCardId))
    .leftJoin(auctionCard, eq(auctionCard.id, auctionUserCard.cardId))
    .where(eq(walletLedger.userId, user.id))
    .orderBy(desc(walletLedger.createdAt))
    .limit(200);

  const opens = await db
    .select({
      id: packs.id,
      tier: packs.tier,
      openedAt: packs.openedAt,
      packEvAtPurchase: packs.packEvAtPurchase,
    })
    .from(packs)
    .where(and(eq(packs.ownerId, user.id), isNotNull(packs.openedAt)))
    .orderBy(desc(packs.openedAt))
    .limit(200);

  const events: ActivityEvent[] = [];

  for (const r of ledgerRows) {
    // LISTING_FEE / AUCTION_FEE rows belong to the platform user and are
    // filtered out by the userId predicate; the type assertion just narrows
    // the union for the timeline shape.
    if (r.type === 'LISTING_FEE' || r.type === 'AUCTION_FEE') continue;

    const meta = r.meta as { newBidAmount?: number } | null;
    const cardName = r.listingCardName ?? r.auctionCardName ?? undefined;

    events.push({
      id: r.id,
      kind: r.type,
      amountCents: r.amount,
      createdAt: r.createdAt.toISOString(),
      packTier: r.packTier ?? undefined,
      cardName,
      pricePaid: r.pricePaid ?? undefined,
      listingPrice: r.listingPrice ?? undefined,
      auctionFinalBid: r.auctionFinalBid ?? undefined,
      bidAmount: meta?.newBidAmount,
    });
  }

  for (const o of opens) {
    if (!o.openedAt) continue;
    events.push({
      id: `pack-open-${o.id}`,
      kind: 'PACK_OPENED',
      amountCents: 0,
      createdAt: o.openedAt.toISOString(),
      packTier: o.tier,
      packEvAtPurchase: o.packEvAtPurchase,
      cardCount: TIER_CARD_COUNT[o.tier],
    });
  }

  events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json({ events: events.slice(0, 100) });
});
