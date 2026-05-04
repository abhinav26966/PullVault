import { desc, eq } from 'drizzle-orm';
import Image from 'next/image';
import Link from 'next/link';
import {
  cardPrices,
  cards,
  db,
  listings,
  userCards,
  users,
} from '@pullvault/db';
import NavLink from '@/components/nav-link';
import { requireAuth } from '@/lib/require-auth';

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

export default async function MarketPage() {
  await requireAuth();

  const items = await db
    .select({
      id: listings.id,
      price: listings.price,
      sellerDisplayName: users.displayName,
      cardId: userCards.cardId,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrlSmall,
      currentPrice: cardPrices.price,
    })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .innerJoin(userCards, eq(userCards.id, listings.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(eq(listings.state, 'ACTIVE'))
    .orderBy(desc(listings.createdAt))
    .limit(60);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Marketplace</h1>
        <p className="text-sm text-zinc-500">
          {items.length} active {items.length === 1 ? 'listing' : 'listings'}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-16 px-4 space-y-4">
          <p className="text-base text-zinc-700">No listings right now</p>
          <p className="text-sm text-zinc-500 max-w-md">
            When users put cards up for sale, they&rsquo;ll appear here. Be the first
            to list one of yours.
          </p>
          <Link
            href="/collection"
            className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-md hover:bg-zinc-800 transition-colors"
          >
            Browse your collection
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
          {items.map((c) => (
            <li
              key={c.id}
              className={`border-2 rounded bg-white p-2 transition-colors duration-150 hover:border-zinc-400 ${RARITY_BORDER[c.rarity] ?? 'border-zinc-300'}`}
            >
              <NavLink href={`/market/${c.id}`} className="block">
                <Image
                  src={c.imageUrl}
                  alt={c.name}
                  width={245}
                  height={342}
                  className="w-full h-auto"
                  unoptimized
                />
                <p className="mt-2 text-xs font-medium">{c.name}</p>
                <p className="text-xs text-zinc-500">{c.setName}</p>
                <p className="text-xs text-zinc-500">
                  {c.rarity} · market{' '}
                  <span className="font-mono">{fmtUsd(c.currentPrice)}</span>
                </p>
                <p className="mt-1 text-sm font-mono">{fmtUsd(c.price)}</p>
                <p className="text-xs text-zinc-500">by {c.sellerDisplayName}</p>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
