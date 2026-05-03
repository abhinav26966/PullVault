import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { db, wallets } from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const NAV_TILES: ReadonlyArray<{
  href: string;
  title: string;
  subtitle: string;
}> = [
  { href: '/drops', title: 'Drops', subtitle: 'Compete for limited pack inventory' },
  { href: '/collection', title: 'Collection', subtitle: 'Owned cards and unopened packs' },
  { href: '/market', title: 'Market', subtitle: 'Fixed-price listings' },
  { href: '/auctions', title: 'Auctions', subtitle: 'Live bidding with anti-snipe' },
];

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
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {NAV_TILES.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="rounded-lg border border-zinc-200 p-4 hover:bg-zinc-50"
          >
            <p className="font-medium">{tile.title}</p>
            <p className="text-sm text-zinc-500">{tile.subtitle}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
