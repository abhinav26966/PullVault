import { and, avg, count, eq, inArray, isNotNull, sum } from 'drizzle-orm';
import {
  PLATFORM_USER_ID,
  db,
  packs,
  walletLedger,
} from '@pullvault/db';
import { TIER_CONFIG, computeTierEV, type Tier } from '@pullvault/domain';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const TIER_ORDER: readonly Tier[] = ['BRONZE', 'SILVER', 'GOLD'];

export default async function EconomicsPage() {
  // Trial scope: any logged-in user can view. Production would gate by an
  // admin role; the trial is intentionally permissive for reviewer convenience.
  await requireAuth();

  const tierRows = await db
    .select({
      tier: packs.tier,
      packsOpened: count(packs.id),
      avgRealizedEv: avg(packs.packEvAtPurchase),
    })
    .from(packs)
    .where(isNotNull(packs.openedAt))
    .groupBy(packs.tier);

  const byTier = new Map(tierRows.map((r) => [r.tier, r]));

  const [feeRow] = await db
    .select({ total: sum(walletLedger.amount) })
    .from(walletLedger)
    .where(
      and(
        eq(walletLedger.userId, PLATFORM_USER_ID),
        inArray(walletLedger.type, ['LISTING_FEE', 'AUCTION_FEE']),
      ),
    );
  const totalFeesCents = Number(feeRow?.total ?? 0);

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
    </div>
  );
}
