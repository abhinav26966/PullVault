import { eq } from 'drizzle-orm';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  cardPrices,
  cards,
  db,
  listings,
  userCards,
  users,
} from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';
import ListingActions from './listing-actions';

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

export default async function ListingDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await requireAuth();

  const [row] = await db
    .select({
      id: listings.id,
      price: listings.price,
      state: listings.state,
      sellerId: listings.sellerId,
      sellerDisplayName: users.displayName,
      cardId: userCards.cardId,
      name: cards.name,
      setName: cards.setName,
      rarity: cards.rarity,
      imageUrl: cards.imageUrl,
      currentPrice: cardPrices.price,
    })
    .from(listings)
    .innerJoin(users, eq(users.id, listings.sellerId))
    .innerJoin(userCards, eq(userCards.id, listings.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, userCards.cardId))
    .where(eq(listings.id, params.id))
    .limit(1);
  if (!row) notFound();

  const isSeller = row.sellerId === user.id;
  const isActive = row.state === 'ACTIVE';

  return (
    <div className="space-y-6">
      <div>
        <Link href="/market" className="text-sm text-zinc-500 underline">
          ← All listings
        </Link>
      </div>
      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <div
          className={`border-2 rounded bg-white p-3 ${RARITY_BORDER[row.rarity] ?? 'border-zinc-300'}`}
        >
          <Image
            src={row.imageUrl}
            alt={row.name}
            width={490}
            height={684}
            className="w-full h-auto"
            unoptimized
          />
        </div>
        <div className="space-y-4">
          <div>
            <h1 className="text-2xl font-semibold">{row.name}</h1>
            <p className="text-sm text-zinc-500">
              {row.setName} · {row.rarity}
            </p>
            <p className="text-sm text-zinc-500">Listed by {row.sellerDisplayName}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-zinc-500">List price</p>
            <p className="text-3xl font-mono">{fmtUsd(row.price)}</p>
            <p className="text-xs text-zinc-500">
              Current market <span className="font-mono">{fmtUsd(row.currentPrice)}</span>
            </p>
          </div>
          <div className="text-sm">
            Status: <span className="font-mono">{row.state}</span>
          </div>
          {isActive ? (
            <ListingActions
              listingId={row.id}
              isSeller={isSeller}
              priceCents={row.price}
            />
          ) : (
            <p className="text-sm text-zinc-500">
              This listing is no longer active.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
