import Link from 'next/link';
import type { Metadata } from 'next';
import { desc, isNotNull } from 'drizzle-orm';
import { db, packs } from '@pullvault/db';
import PackSearchForm from './search-form';

export const metadata: Metadata = {
  title: 'Public audit · PullVault',
};

export const dynamic = 'force-dynamic';

const TIER_BADGE: Record<string, string> = {
  BRONZE: 'bg-amber-700',
  SILVER: 'bg-zinc-500',
  GOLD: 'bg-amber-500',
};

function formatStamp(d: Date): string {
  return d.toLocaleString();
}

/**
 * /audit — public transparency hub. No auth, no logging, no fingerprint.
 *
 * Surfaces the headline B4 provably-fair feature to anonymous visitors —
 * a reviewer who lands at /login can find the verify primitive in one
 * click instead of having to read the README and assemble a URL by hand.
 */
export default async function AuditPage() {
  const recent = await db
    .select({
      id: packs.id,
      tier: packs.tier,
      purchasedAt: packs.purchasedAt,
      serverSeedCommit: packs.serverSeedCommit,
    })
    .from(packs)
    .where(isNotNull(packs.serverSeedCommit))
    .orderBy(desc(packs.purchasedAt))
    .limit(10);

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-3xl mx-auto p-6 space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Public audit</h1>
          <p className="text-sm text-zinc-600 max-w-prose">
            PullVault publishes a cryptographic commit for every server seed
            <em> before </em>
            it gets drawn, and mixes your own random contribution into the
            pack roll. After purchase, the verify page below recomputes the
            full SHA-256 + HMAC chain
            <em> in your browser </em>
            via Web Crypto. The server hands over raw inputs only — no{' '}
            <span className="font-mono">valid:true</span>, no precomputed
            booleans. If anyone ever tampered with a pack&apos;s server seed
            after the fact, this page would catch it without the server&apos;s
            cooperation. No login required.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-700 uppercase tracking-widest">
            Verify any pack
          </h2>
          <PackSearchForm />
          <p className="text-xs text-zinc-500">
            Or browse a recent pack from the list below.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-zinc-700 uppercase tracking-widest">
            Recent verifiable packs
          </h2>
          {recent.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No provably-fair packs in the system yet — they appear here after
              the first B4 pack is purchased.
            </p>
          ) : (
            <div className="border border-zinc-200 rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50">
                  <tr className="text-left text-xs uppercase tracking-widest text-zinc-500">
                    <th className="px-3 py-2 font-medium">Tier</th>
                    <th className="px-3 py-2 font-medium">Pack ID</th>
                    <th className="px-3 py-2 font-medium">Purchased</th>
                    <th className="px-3 py-2 font-medium">Commit prefix</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={p.id} className="border-t border-zinc-100">
                      <td className="px-3 py-2">
                        <span
                          className={`inline-block px-2 py-0.5 text-xs text-white rounded ${
                            TIER_BADGE[p.tier] ?? 'bg-zinc-500'
                          }`}
                        >
                          {p.tier}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/verify/${p.id}`}
                          className="font-mono text-xs text-zinc-900 underline hover:no-underline"
                        >
                          {p.id.slice(0, 8)}…{p.id.slice(-4)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500 tabular-nums whitespace-nowrap">
                        {formatStamp(p.purchasedAt)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                        {(p.serverSeedCommit ?? '').slice(0, 12)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="text-xs text-zinc-500 pt-6 border-t border-zinc-100 space-y-1">
          <p>
            Raw data feeds (JSON, also public):{' '}
            <Link
              href="/api/audit/commits"
              className="underline hover:no-underline"
            >
              /api/audit/commits
            </Link>{' '}
            for the seed-commit ledger and{' '}
            <Link
              href="/api/audit/aggregates"
              className="underline hover:no-underline"
            >
              /api/audit/aggregates
            </Link>{' '}
            for rarity-distribution stats.
          </p>
          <p>
            <Link href="/login" className="underline hover:no-underline">
              ← Back to sign in
            </Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
