import { eq } from 'drizzle-orm';
import { db, wallets } from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function DashboardPage() {
  const user = await requireAuth();
  const [wallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.userId, user.id))
    .limit(1);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Welcome, {user.displayName}</h1>
      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <div className="bg-white border border-zinc-200 rounded p-6">
          <p className="text-sm text-zinc-500">Available</p>
          <p className="text-3xl font-mono mt-1">
            {fmtUsd(wallet?.balanceAvailable ?? 0)}
          </p>
        </div>
        <div className="bg-white border border-zinc-200 rounded p-6">
          <p className="text-sm text-zinc-500">In auctions</p>
          <p className="text-3xl font-mono mt-1">
            {fmtUsd(wallet?.balanceHeld ?? 0)}
          </p>
        </div>
      </div>
      <p className="text-sm text-zinc-500">
        Drops, marketplace, and auctions coming online in later phases.
      </p>
    </div>
  );
}
