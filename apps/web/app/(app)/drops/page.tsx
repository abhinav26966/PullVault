import { and, asc, gt, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { db, packDrops } from '@pullvault/db';

export const dynamic = 'force-dynamic';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const TIER_STYLES: Record<string, string> = {
  BRONZE: 'border-amber-700/30 bg-amber-50',
  SILVER: 'border-zinc-400/40 bg-zinc-100',
  GOLD: 'border-yellow-500/40 bg-yellow-50',
};

export default async function DropsPage() {
  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const drops = await db
    .select()
    .from(packDrops)
    .where(
      and(
        inArray(packDrops.state, ['SCHEDULED', 'OPEN']),
        gt(packDrops.startsAt, oneHourAgo),
      ),
    )
    .orderBy(asc(packDrops.startsAt));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Pack Drops</h1>
      {drops.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No drops scheduled right now — check back later.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {drops.map((d) => (
            <li
              key={d.id}
              className={`border rounded p-4 ${TIER_STYLES[d.tier] ?? 'border-zinc-200 bg-white'}`}
            >
              <Link href={`/drops/${d.id}`} className="block hover:opacity-80">
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold">{d.tier}</span>
                  <span className="font-mono">{fmtUsd(d.priceCents)}</span>
                </div>
                <p className="text-sm text-zinc-700 mt-2">
                  {d.state === 'OPEN'
                    ? `${d.inventoryRemaining} of ${d.inventoryTotal} left`
                    : `Scheduled — opens ${new Date(d.startsAt).toLocaleString()}`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
