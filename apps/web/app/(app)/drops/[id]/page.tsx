import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, packDrops } from '@pullvault/db';
import {
  TIER_CONFIG,
  computeTierEV,
  type SlotType,
  type Tier,
} from '@pullvault/domain';
import { PackTile } from '@/components/pack-tile';
import DropBuyClient from '@/components/drop-buy-client';

export const dynamic = 'force-dynamic';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function describeSlot(type: SlotType): string {
  switch (type) {
    case 'FILLER':
      return 'Filler — mostly commons + uncommons';
    case 'RARE_FLOOR':
      return 'Rare floor — guaranteed rare or better';
    case 'HIT':
      return 'Hit slot — rare to legendary';
    case 'JACKPOT':
      return 'Jackpot — biased toward legendary';
  }
}

export default async function DropDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [drop] = await db
    .select()
    .from(packDrops)
    .where(eq(packDrops.id, params.id))
    .limit(1);
  if (!drop) notFound();

  const tier = drop.tier as Tier;
  const config = TIER_CONFIG[tier];
  const ev = computeTierEV(tier);

  const initial = {
    id: drop.id,
    tier,
    priceCents: drop.priceCents,
    inventoryTotal: drop.inventoryTotal,
    inventoryRemaining: drop.inventoryRemaining,
    startsAt: drop.startsAt.toISOString(),
    state: drop.state as 'SCHEDULED' | 'OPEN' | 'SOLD_OUT' | 'CLOSED',
  };

  return (
    <div className="space-y-6">
      <Link
        href="/drops"
        className="text-sm text-zinc-500 underline hover:text-zinc-900"
      >
        ← All drops
      </Link>
      <div className="grid gap-8 md:grid-cols-[240px_1fr]">
        <div className="flex justify-center md:justify-start">
          <PackTile tier={tier} size="lg" />
        </div>
        <div className="space-y-6 max-w-xl">
          <div>
            <h1 className="text-3xl font-semibold">{tier} pack</h1>
            <p className="text-sm text-zinc-500 mt-1">
              {config.cardCount} cards · {fmtUsd(config.priceCents)} per pack
            </p>
          </div>

          <div className="bg-white border border-zinc-200 rounded-lg p-6 space-y-4">
            <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest">
              What&rsquo;s inside
            </h2>
            <ul className="space-y-2 text-sm">
              {config.slots.map((slot, i) => (
                <li key={i} className="flex items-baseline justify-between gap-4">
                  <span className="text-zinc-700">{describeSlot(slot.type)}</span>
                  <span className="font-mono text-zinc-500 shrink-0">
                    × {slot.count}
                  </span>
                </li>
              ))}
            </ul>
            <div className="pt-3 border-t border-zinc-100 flex items-baseline justify-between text-sm">
              <span className="text-zinc-500">Expected pack value</span>
              <span className="font-mono text-zinc-900">{fmtUsd(ev.evCents)}</span>
            </div>
            <p className="text-xs text-zinc-400">
              EV is computed from the documented rarity weights × bucket means.
              Realized value per opened pack varies — that&rsquo;s the dopamine.
            </p>
          </div>

          <DropBuyClient initial={initial} />
        </div>
      </div>
    </div>
  );
}
