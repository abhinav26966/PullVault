import { asc, eq } from 'drizzle-orm';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cardPrices, cards, db, packCards, packs } from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';
import RipOpenCard from './rip-open-card';

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

export default async function PackPage({ params }: { params: { id: string } }) {
  const user = await requireAuth();
  const [pack] = await db.select().from(packs).where(eq(packs.id, params.id)).limit(1);
  if (!pack || pack.ownerId !== user.id) notFound();

  if (!pack.openedAt) {
    return (
      <RipOpenCard
        packId={pack.id}
        tier={pack.tier as 'BRONZE' | 'SILVER' | 'GOLD'}
        pricePaid={pack.pricePaid}
      />
    );
  }

  const items = await db
    .select({
      position: packCards.position,
      slotType: packCards.slotType,
      rarity: packCards.rarityAtPull,
      cardId: packCards.cardId,
      name: cards.name,
      setName: cards.setName,
      imageUrl: cards.imageUrlSmall,
      price: cardPrices.price,
    })
    .from(packCards)
    .innerJoin(cards, eq(cards.id, packCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, packCards.cardId))
    .where(eq(packCards.packId, params.id))
    .orderBy(asc(packCards.position));

  const totalValue = items.reduce((sum, c) => sum + c.price, 0);
  const pnl = totalValue - pack.pricePaid;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{pack.tier} pack — opened</h1>
      <div className="grid grid-cols-3 gap-4 max-w-md text-sm">
        <div>
          <p className="text-zinc-500">Paid</p>
          <p className="font-mono">{fmtUsd(pack.pricePaid)}</p>
        </div>
        <div>
          <p className="text-zinc-500">Total value</p>
          <p className="font-mono">{fmtUsd(totalValue)}</p>
        </div>
        <div>
          <p className="text-zinc-500">P&amp;L</p>
          <p className={`font-mono ${pnl >= 0 ? 'text-green-700' : 'text-red-700'}`}>
            {pnl >= 0 ? '+' : ''}
            {fmtUsd(pnl)}
          </p>
        </div>
      </div>
      <ul className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
        {items.map((c) => (
          <li
            key={c.position}
            className={`border-2 rounded bg-white p-2 ${RARITY_BORDER[c.rarity] ?? 'border-zinc-300'}`}
          >
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
              {c.rarity} · {fmtUsd(c.price)}
            </p>
            <div className="mt-2 flex gap-2 text-xs">
              <Link
                href={`/market/new?card=${c.cardId}`}
                className="flex-1 text-center border border-zinc-300 rounded px-2 py-1 hover:bg-zinc-50"
              >
                List
              </Link>
              <Link
                href={`/auctions/new?card=${c.cardId}`}
                className="flex-1 text-center border border-zinc-300 rounded px-2 py-1 hover:bg-zinc-50"
              >
                Auction
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
