import { aliasedTable, desc, eq } from 'drizzle-orm';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  auctions,
  bids,
  cardPrices,
  cards,
  db,
  userCards,
  users,
} from '@pullvault/db';
import { computeMinValidBid } from '@pullvault/domain';
import { requireAuth } from '@/lib/require-auth';
import AuctionRoom from './auction-room';

export const dynamic = 'force-dynamic';

const RARITY_BORDER: Record<string, string> = {
  C: 'border-zinc-300',
  U: 'border-green-400',
  R: 'border-blue-400',
  E: 'border-purple-500',
  L: 'border-amber-500',
};

export default async function AuctionDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await requireAuth();

  const [a] = await db
    .select({
      id: auctions.id,
      startingBid: auctions.startingBid,
      currentBidAmount: auctions.currentBidAmount,
      currentBidUserId: auctions.currentBidUserId,
      endsAt: auctions.endsAt,
      state: auctions.state,
      settledAt: auctions.settledAt,
      sellerId: auctions.sellerId,
      sellerDisplayName: users.displayName,
      cardId: userCards.cardId,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrl,
      currentMarketPrice: cardPrices.price,
    })
    .from(auctions)
    .innerJoin(users, eq(users.id, auctions.sellerId))
    .innerJoin(userCards, eq(userCards.id, auctions.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(eq(auctions.id, params.id))
    .limit(1);
  if (!a) notFound();

  const bidder = aliasedTable(users, 'bidder');
  const recentBids = await db
    .select({
      id: bids.id,
      amount: bids.amount,
      placedAt: bids.placedAt,
      bidderId: bids.bidderId,
      bidderDisplayName: bidder.displayName,
      isSealed: bids.isSealed,
    })
    .from(bids)
    .innerJoin(bidder, eq(bidder.id, bids.bidderId))
    .where(eq(bids.auctionId, params.id))
    .orderBy(desc(bids.placedAt))
    .limit(50);

  const currentHighDisplayName =
    a.currentBidUserId != null
      ? recentBids.find((b) => b.bidderId === a.currentBidUserId)?.bidderDisplayName ?? null
      : null;

  // Part B §11 — server-side redaction during the sealed window.
  // - currentBid amount + bidder are hidden from everyone (the public auction
  //   high-bid is the thing late snipers would race to beat).
  // - Each sealed bid's amount is masked unless the viewer placed it. The
  //   bidder always sees their own bids so they know what they committed.
  // - Settlement (state → SETTLED) lifts redaction; the bid history is
  //   public from that point.
  const isSealed = a.state === 'SEALED';
  const sealedBidCount = recentBids.filter((b) => b.isSealed).length;
  const initialCurrentBid = isSealed ? null : a.currentBidAmount;
  const initialCurrentBidUserId = isSealed ? null : a.currentBidUserId;
  const initialCurrentBidDisplayName = isSealed ? null : currentHighDisplayName;
  const initialBids = recentBids.map((b) => ({
    id: b.id,
    amount: b.isSealed && b.bidderId !== user.id ? null : b.amount,
    placedAt: b.placedAt.toISOString(),
    bidderId: b.bidderId,
    bidderDisplayName: b.bidderDisplayName,
    isSealed: b.isSealed,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/auctions" className="text-sm text-zinc-500 underline">
          ← All auctions
        </Link>
      </div>
      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <div
          className={`border-2 rounded bg-white p-3 ${RARITY_BORDER[a.rarity] ?? 'border-zinc-300'}`}
        >
          <Image
            src={a.imageUrl}
            alt={a.name}
            width={490}
            height={684}
            className="w-full h-auto"
            unoptimized
          />
        </div>
        <AuctionRoom
          auctionId={a.id}
          isSeller={a.sellerId === user.id}
          card={{
            name: a.name,
            setName: a.setName,
            rarity: a.rarity,
            currentMarketPrice: a.currentMarketPrice,
          }}
          sellerDisplayName={a.sellerDisplayName}
          initialState={{
            state: a.state,
            startingBid: a.startingBid,
            currentBid: initialCurrentBid,
            currentBidUserId: initialCurrentBidUserId,
            currentBidDisplayName: initialCurrentBidDisplayName,
            endsAt: a.endsAt.toISOString(),
            // minNextBid uses the unredacted current bid even during sealed —
            // the bid endpoint validates against the real amount, so the
            // bidder needs to know what to clear. (The public room displays
            // the suggested-min as a hint without revealing the actual high.)
            minNextBid: computeMinValidBid(a.currentBidAmount, a.startingBid),
            currentUserId: user.id,
            sealedBidCount,
            bids: initialBids,
          }}
        />
      </div>
    </div>
  );
}
