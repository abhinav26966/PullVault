import Link from 'next/link';
import { requireAuth } from '@/lib/require-auth';
import EconomicsTab from './economics-tab';
import FairnessTab from './fairness-tab';
import FraudTab from './fraud-tab';
import UsersTab from './users-tab';

export const dynamic = 'force-dynamic';

type TabKey = 'economics' | 'fraud' | 'fairness' | 'users';

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'economics', label: 'Economics' },
  { key: 'fraud', label: 'Fraud' },
  { key: 'fairness', label: 'Fairness' },
  { key: 'users', label: 'Users' },
];

/**
 * /admin/health — Part B §13.
 *
 * Sibling to the Part A /admin/economics page (which stays unmodified). This
 * is the operational dashboard with four tabs surfacing data the B1–B4 work
 * already wrote: pack_economics_snapshots, wallet_ledger, bot_score on users,
 * pack_audit_aggregates, account_clusters, rate_limit_audit, etc.
 *
 * Tab content is fetched client-side via SWR with a 30s refresh interval —
 * the build-plan budget didn't fit a WS push channel for live metrics, but
 * 30s polling is the documented "near-realtime" SLA.
 */
export default async function HealthPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  await requireAuth();

  const requested = searchParams.tab as TabKey | undefined;
  const active: TabKey =
    requested && TABS.some((t) => t.key === requested) ? requested : 'economics';

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Health dashboard</h1>
        <p className="text-sm text-zinc-500">
          Operational metrics for economics, anti-fraud, fairness, and user
          retention. Auto-refreshes every 30s.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-zinc-200">
        {TABS.map((tab) => {
          const isActive = active === tab.key;
          return (
            <Link
              key={tab.key}
              href={`/admin/health?tab=${tab.key}`}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-zinc-900 text-zinc-900'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div>
        {active === 'economics' && <EconomicsTab />}
        {active === 'fraud' && <FraudTab />}
        {active === 'fairness' && <FairnessTab />}
        {active === 'users' && <UsersTab />}
      </div>
    </div>
  );
}
