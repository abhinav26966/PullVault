import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db, packDrops } from '@pullvault/db';
import DropBuyClient from '@/components/drop-buy-client';

export const dynamic = 'force-dynamic';

export default async function DropDetailPage({ params }: { params: { id: string } }) {
  const [drop] = await db
    .select()
    .from(packDrops)
    .where(eq(packDrops.id, params.id))
    .limit(1);
  if (!drop) notFound();

  // Serialise to plain JSON so the client component receives stable shapes
  // (Date → string, etc.).
  const initial = {
    id: drop.id,
    tier: drop.tier as 'BRONZE' | 'SILVER' | 'GOLD',
    priceCents: drop.priceCents,
    inventoryTotal: drop.inventoryTotal,
    inventoryRemaining: drop.inventoryRemaining,
    startsAt: drop.startsAt.toISOString(),
    state: drop.state as 'SCHEDULED' | 'OPEN' | 'SOLD_OUT' | 'CLOSED',
  };

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">{drop.tier} pack</h1>
      <DropBuyClient initial={initial} />
    </div>
  );
}
