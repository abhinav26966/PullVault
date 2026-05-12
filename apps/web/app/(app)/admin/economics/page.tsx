import type { Metadata } from 'next';
import { and, avg, count, eq, inArray, isNotNull, sql, sum } from 'drizzle-orm';
import {
  PLATFORM_USER_ID,
  db,
  packs,
  walletLedger,
  wallets,
} from '@pullvault/db';
import { TIER_CONFIG, computeTierEV, type Tier } from '@pullvault/domain';
import { requireAuth } from '@/lib/require-auth';

export const metadata: Metadata = {
  title: 'Economics · PullVault',
};

export const dynamic = 'force-dynamic';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const TIER_ORDER: readonly Tier[] = ['BRONZE', 'SILVER', 'GOLD'];

export default async function EconomicsPage() {
  // Trial scope: any logged-in user can view. Production would gate by an
  // admin role; the trial is intentionally permissive for reviewer convenience.
  await requireAuth();

  // Run all four reads in parallel — they're independent, and the page
  // previously serialized them which doubled the load time over the pooler.
  const [tierRows, [feeRow], [ledgerSumRow], [walletSumRow]] = await Promise.all([
    db
      .select({
        tier: packs.tier,
        packsOpened: count(packs.id),
        avgRealizedEv: avg(packs.packEvAtPurchase),
      })
      .from(packs)
      .where(isNotNull(packs.openedAt))
      .groupBy(packs.tier),
    db
      .select({ total: sum(walletLedger.amount) })
      .from(walletLedger)
      .where(
        and(
          eq(walletLedger.userId, PLATFORM_USER_ID),
          inArray(walletLedger.type, ['LISTING_FEE', 'AUCTION_FEE']),
        ),
      ),
    db.select({ total: sum(walletLedger.amount) }).from(walletLedger),
    db
      .select({
        total: sql<string>`COALESCE(SUM(${wallets.balanceAvailable} + ${wallets.balanceHeld}), 0)`,
      })
      .from(wallets),
  ]);

  const byTier = new Map(tierRows.map((r) => [r.tier, r]));
  const totalFeesCents = Number(feeRow?.total ?? 0);

  // §5.2 reconciliation invariant: SUM(wallet_ledger.amount) over all users
  // must equal SUM(wallets.balance_available + balance_held). Surface it as
  // a green/red badge so a reviewer can verify the audit trail without
  // running ad-hoc SQL.
  const ledgerTotalCents = Number(ledgerSumRow?.total ?? 0);
  const walletTotalCents = Number(walletSumRow?.total ?? 0);
  const reconciliationDeltaCents = walletTotalCents - ledgerTotalCents;
  const reconciliationBalanced = reconciliationDeltaCents === 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Economics</h1>
        <p className="text-sm text-zinc-500">
          Per-tier pack economics + cumulative platform fee revenue.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-medium mb-3">Pack EV by tier</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm bg-white border border-zinc-200 rounded">
            <thead className="bg-zinc-50 text-zinc-600">
              <tr>
                <th className="px-3 py-2 text-left">Tier</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Packs opened</th>
                <th className="px-3 py-2 text-right">Expected EV</th>
                <th className="px-3 py-2 text-right">Realized EV</th>
                <th className="px-3 py-2 text-right">Realized margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 font-mono">
              {TIER_ORDER.map((tier) => {
                const config = TIER_CONFIG[tier];
                const expected = computeTierEV(tier);
                const row = byTier.get(tier);
                const packsOpened = row ? Number(row.packsOpened) : 0;
                const realizedEvCents =
                  packsOpened > 0 && row?.avgRealizedEv != null
                    ? Math.round(Number(row.avgRealizedEv))
                    : null;
                const realizedMarginPct =
                  realizedEvCents !== null
                    ? ((config.priceCents - realizedEvCents) / config.priceCents) * 100
                    : null;
                return (
                  <tr key={tier}>
                    <td className="px-3 py-2 font-sans font-medium">{tier}</td>
                    <td className="px-3 py-2 text-right">{fmtUsd(config.priceCents)}</td>
                    <td className="px-3 py-2 text-right">{packsOpened}</td>
                    <td className="px-3 py-2 text-right">{fmtUsd(expected.evCents)}</td>
                    <td className="px-3 py-2 text-right">
                      {realizedEvCents !== null ? fmtUsd(realizedEvCents) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {realizedMarginPct !== null
                        ? `${realizedMarginPct.toFixed(1)}%`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white border border-zinc-200 rounded p-6">
        <p className="text-sm text-zinc-500">Cumulative platform fees</p>
        <p className="text-4xl font-mono mt-1">{fmtUsd(totalFeesCents)}</p>
        <p className="text-xs text-zinc-500 mt-2">
          Sum of LISTING_FEE + AUCTION_FEE ledger entries against the platform user.
        </p>
      </section>

      <section
        className={`border rounded p-6 ${
          reconciliationBalanced
            ? 'bg-green-50 border-green-300'
            : 'bg-red-50 border-red-300'
        }`}
      >
        <p className="text-sm text-zinc-600">Ledger reconciliation (§5.2)</p>
        {reconciliationBalanced ? (
          <p className="text-2xl font-mono mt-1 text-green-800">
            ✓ Balanced — {fmtUsd(ledgerTotalCents)}
          </p>
        ) : (
          <p className="text-2xl font-mono mt-1 text-red-800">
            ✗ Imbalanced — Δ {fmtUsd(reconciliationDeltaCents)}
          </p>
        )}
        <p className="text-xs text-zinc-500 mt-2">
          SUM(wallet_ledger.amount) ={' '}
          <span className="font-mono">{fmtUsd(ledgerTotalCents)}</span>; SUM(wallets.balance_available
          + balance_held) ={' '}
          <span className="font-mono">{fmtUsd(walletTotalCents)}</span>. Equal ⇒ every
          wallet&rsquo;s net change matches its ledger entries across the system, including
          the platform user.
        </p>
      </section>
    </div>
  );
}
