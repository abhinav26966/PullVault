import { asc, inArray } from 'drizzle-orm';
import { db, packDrops } from '@pullvault/db';
import NavLink from '@/components/nav-link';
import { PackTile } from '@/components/pack-tile';

export const dynamic = 'force-dynamic';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const TIER_BAR: Record<'BRONZE' | 'SILVER' | 'GOLD', string> = {
  BRONZE: 'bg-amber-700',
  SILVER: 'bg-zinc-500',
  GOLD: 'bg-amber-500',
};

export default async function DropsPage() {
  // Show every drop that's still buyable. State is the only correct gate —
  // SOLD_OUT and CLOSED are filtered out by the IN clause; OPEN drops with
  // remaining inventory should appear regardless of how long ago they
  // activated.
  const drops = await db
    .select()
    .from(packDrops)
    .where(inArray(packDrops.state, ['SCHEDULED', 'OPEN']))
    .orderBy(asc(packDrops.startsAt));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Pack Drops</h1>
      {drops.length === 0 ? (
        <p className="text-sm text-zinc-500">
          📦 No drops scheduled right now — check back later.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {drops.map((d) => {
            const soldOut = d.state === 'OPEN' && d.inventoryRemaining === 0;
            const fillPercent =
              d.inventoryTotal > 0
                ? Math.round((d.inventoryRemaining / d.inventoryTotal) * 100)
                : 0;
            return (
              <li
                key={d.id}
                className="border border-zinc-200 bg-white rounded-lg transition-all duration-150 hover:border-zinc-400 hover:shadow-md"
              >
                <NavLink href={`/drops/${d.id}`} className="block p-4">
                  <div className="flex gap-4">
                    <PackTile tier={d.tier} size="md" />
                    <div className="flex-1 flex flex-col">
                      <div className="flex items-baseline justify-between">
                        <h2 className="text-xl font-semibold">{d.tier}</h2>
                        <span className="text-zinc-400 text-lg" aria-hidden>
                          →
                        </span>
                      </div>
                      <p className="font-mono text-lg mt-1">
                        {fmtUsd(d.priceCents)}
                      </p>
                      {d.state === 'OPEN' ? (
                        <p className="text-sm text-zinc-600 mt-2">
                          {soldOut ? (
                            <span className="text-zinc-400">Sold out</span>
                          ) : (
                            `${d.inventoryRemaining} of ${d.inventoryTotal} packs available`
                          )}
                        </p>
                      ) : (
                        <p className="text-sm text-zinc-600 mt-2">
                          Scheduled — opens{' '}
                          {new Date(d.startsAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                  {d.state === 'OPEN' && !soldOut ? (
                    <div className="mt-4 h-1.5 bg-zinc-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${TIER_BAR[d.tier]} transition-all`}
                        style={{ width: `${fillPercent}%` }}
                      />
                    </div>
                  ) : null}
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
