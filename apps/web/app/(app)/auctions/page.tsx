import { and, asc, eq, gt } from 'drizzle-orm';
import Image from 'next/image';
import Link from 'next/link';
import {
  auctions,
  cardPrices,
  cards,
  db,
  userCards,
  users,
} from '@pullvault/db';
import NavLink from '@/components/nav-link';
import { requireAuth } from '@/lib/require-auth';
import AuctionsCountdown from './countdown';

export const dynamic = 'force-dynamic';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const RARITY_BORDER: Record<string, string> = {
  C: 'border-zinc-300',
  U: 'border-green-400',
  R: 'border-blue-400',
  E: 'border-purple-500',
  L: 'border-amber-500',
};

export default async function AuctionsPage() {
  await requireAuth();

  const now = new Date();
  const items = await db
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
    .where(and(eq(auctions.state, 'OPEN'), gt(auctions.endsAt, now)))
    .orderBy(asc(auctions.endsAt))
    .limit(60);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Auctions</h1>
          <p className="text-sm text-zinc-500">
            {items.length} live {items.length === 1 ? 'auction' : 'auctions'}
          </p>
        </div>
        <Link
          href="/collection?action=auction"
          className="inline-flex items-center gap-2 px-3 py-1.5 bg-zinc-900 text-white text-sm font-medium rounded-md hover:bg-zinc-800 transition-colors"
        >
          + Create Auction
        </Link>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">
          🔨 No live auctions right now — check back later.
        </p>
      ) : (
        <ul className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
          {items.map((a) => {
            const high = a.currentBidAmount ?? a.startingBid;
            const isFirstBid = a.currentBidAmount === null;
            return (
              <li
                key={a.id}
                className={`border-2 rounded bg-white p-2 transition-colors duration-150 hover:border-zinc-400 ${RARITY_BORDER[a.rarity] ?? 'border-zinc-300'}`}
              >
                <NavLink href={`/auctions/${a.id}`} className="block">
                  <Image
                    src={a.imageUrl}
                    alt={a.name}
                    width={245}
                    height={342}
                    className="w-full h-auto"
                    unoptimized
                  />
                  <p className="mt-2 text-xs font-medium">{a.name}</p>
                  <p className="text-xs text-zinc-500">{a.setName}</p>
                  <p className="text-xs text-zinc-500">
                    {a.rarity} · market{' '}
                    <span className="font-mono">{fmtUsd(a.currentMarketPrice)}</span>
                  </p>
                  <p className="mt-1 text-sm font-mono">
                    {isFirstBid ? 'starting at ' : 'high bid '}
                    {fmtUsd(high)}
                  </p>
                  <p className="text-xs text-zinc-500">by {a.sellerDisplayName}</p>
                  <AuctionsCountdown endsAtIso={a.endsAt.toISOString()} />
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
