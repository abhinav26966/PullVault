import { redirect } from 'next/navigation';
import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { db, wallets } from '@pullvault/db';
import { getSessionUser } from '@/lib/auth';
import LogoutButton from '@/components/logout-button';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const [wallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.userId, user.id))
    .limit(1);

  const available = wallet?.balanceAvailable ?? 0;
  const held = wallet?.balanceHeld ?? 0;

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-3 flex items-center justify-between">
          <div className="flex items-baseline gap-4">
            <Link href="/dashboard" className="text-lg font-semibold">
              PullVault
            </Link>
            <Link
              href="/admin/economics"
              className="text-xs text-zinc-500 hover:text-zinc-900"
            >
              Economics →
            </Link>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-zinc-700">
              {user.displayName} · <span className="font-mono">{fmtUsd(available)}</span>
              {held > 0 ? (
                <span className="text-zinc-500"> · in auctions {fmtUsd(held)}</span>
              ) : null}
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
