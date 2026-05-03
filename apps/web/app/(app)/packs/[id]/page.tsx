import { asc, eq } from 'drizzle-orm';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { cardPrices, cards, db, packCards, packs } from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const RARITY_BG: Record<string, string> = {
  C: 'border-zinc-300',
  U: 'border-green-400',
  R: 'border-blue-400',
  E: 'border-purple-500',
  L: 'border-amber-500',
};

/**
 * Phase 5 placeholder. Lists the cards in the purchased pack so the buy flow
 * has a destination. Phase 7 replaces this with the real reveal experience
 * (stream cards one at a time, summary screen, etc.).
 */
export default async function PackPage({ params }: { params: { id: string } }) {
  const user = await requireAuth();
  const [pack] = await db.select().from(packs).where(eq(packs.id, params.id)).limit(1);
  if (!pack || pack.ownerId !== user.id) notFound();

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
      <div>
        <h1 className="text-2xl font-semibold">{pack.tier} pack</h1>
        <p className="text-sm text-zinc-500">
          Phase 7 will replace this view with the proper reveal experience.
        </p>
      </div>
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
            className={`border-2 rounded bg-white p-2 ${RARITY_BG[c.rarity] ?? 'border-zinc-300'}`}
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
            <p className="text-xs text-zinc-500">
              {c.rarity} · {fmtUsd(c.price)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
