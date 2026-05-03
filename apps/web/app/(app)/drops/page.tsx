import { asc, inArray } from 'drizzle-orm';
import { db, packDrops } from '@pullvault/db';
import DropCard from './drop-card';

export const dynamic = 'force-dynamic';

export default async function DropsPage() {
  // Show every drop that's still buyable. State is the only correct gate —
  // SOLD_OUT and CLOSED are filtered out by the IN clause; OPEN drops with
  // remaining inventory should appear regardless of how long ago they
  // activated. Live inventory + state-flip updates come through DropCard's
  // useChannel subscription per ARCHITECTURE.md §7.1.
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
          {drops.map((d) => (
            <DropCard
              key={d.id}
              id={d.id}
              tier={d.tier as 'BRONZE' | 'SILVER' | 'GOLD'}
              priceCents={d.priceCents}
              initialState={
                d.state as 'SCHEDULED' | 'OPEN' | 'SOLD_OUT' | 'CLOSED'
              }
              initialInventoryRemaining={d.inventoryRemaining}
              inventoryTotal={d.inventoryTotal}
              startsAtIso={d.startsAt.toISOString()}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
