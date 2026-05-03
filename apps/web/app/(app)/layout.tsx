import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Toaster } from 'react-hot-toast';
import { eq } from 'drizzle-orm';
import { db, wallets } from '@pullvault/db';
import { getSessionUser } from '@/lib/auth';
import LogoutButton from '@/components/logout-button';
import NavProgress from '@/components/nav-progress';
import UserMenu from '@/components/user-menu';
import UserToastSubscriber from '@/components/user-toast-subscriber';

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
    <div className="min-h-screen bg-zinc-100">
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
            <UserMenu
              displayName={user.displayName}
              email={user.email}
              createdAtIso={user.createdAt.toISOString()}
              balanceAvailable={available}
              balanceHeld={held}
            />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      <NavProgress />
      <UserToastSubscriber userId={user.id} />
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: '#18181b',
            color: '#fafafa',
            fontSize: '14px',
            borderRadius: '6px',
            padding: '10px 14px',
          },
          success: { iconTheme: { primary: '#22c55e', secondary: '#fafafa' } },
          error: { iconTheme: { primary: '#ef4444', secondary: '#fafafa' } },
        }}
      />
    </div>
  );
}
