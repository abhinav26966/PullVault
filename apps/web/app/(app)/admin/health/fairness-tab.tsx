'use client';

import useSWR from 'swr';

const REFRESH_MS = 30_000;

type Rarity = 'C' | 'U' | 'R' | 'E' | 'L';
type Tier = 'BRONZE' | 'SILVER' | 'GOLD';
type Verdict = 'green' | 'red' | 'yellow' | 'unknown';

interface TierFairness {
  tier: Tier;
  totalN?: number;
  rarities: Array<{ rarity: Rarity; observedCount: number; expectedWeight: number }>;
  chiSquared: {
    chiSq: number;
    df: number;
    pValue: number;
    contributions: number[];
  } | null;
  ks: {
    d: number;
    lambda: number;
    n: number;
    pValue: number;
    cumulativeGaps: number[];
  } | null;
  verdict: Verdict;
  reason?: string;
}

interface FairnessResponse {
  alpha: number;
  perTier: TierFairness[];
}

const fetcher = async (url: string): Promise<FairnessResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
};

const fmtP = (p: number): string => (p < 0.001 ? p.toExponential(2) : p.toFixed(3));

export default function FairnessTab() {
  const { data, error, isLoading } = useSWR<FairnessResponse>(
    '/api/admin/health/fairness',
    fetcher,
    { refreshInterval: REFRESH_MS },
  );
  if (isLoading) return <p className="text-sm text-zinc-500">Loading fairness tests…</p>;
  if (error) return <p className="text-sm text-red-600">Failed to load: {String(error)}</p>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-medium">Distributional fairness — chi-squared + K-S</h2>
        <p className="text-xs text-zinc-500 mt-1">
          Two tests, run server-side over the latest{' '}
          <span className="font-mono">pack_audit_aggregates</span> snapshot per tier.
          Significance threshold α = {data.alpha}. Both pass → green. Either fails → red.
          Tests disagree → yellow chip.
        </p>
      </header>
      <div className="space-y-6">
        {data.perTier.map((t) => (
          <TierCard key={t.tier} t={t} alpha={data.alpha} />
        ))}
      </div>
    </div>
  );
}

function VerdictBadge({ verdict, alpha }: { verdict: Verdict; alpha: number }) {
  const styles: Record<Verdict, string> = {
    green: 'bg-green-100 text-green-800 border-green-300',
    red: 'bg-red-100 text-red-800 border-red-300',
    yellow: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    unknown: 'bg-zinc-100 text-zinc-600 border-zinc-300',
  };
  const labels: Record<Verdict, string> = {
    green: `Both p ≥ ${alpha} — distributions agree, no evidence of unfairness`,
    red: `Either p < ${alpha} — significant deviation from published weights`,
    yellow: `Tests disagree — investigate (chi² and K-S landed on different sides of α)`,
    unknown: 'No data yet',
  };
  return (
    <span
      className={`px-2 py-0.5 text-xs font-medium border rounded ${styles[verdict]}`}
    >
      {labels[verdict]}
    </span>
  );
}

function TierCard({ t, alpha }: { t: TierFairness; alpha: number }) {
  return (
    <section className="bg-white border border-zinc-200 rounded p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">{t.tier}</h3>
        <VerdictBadge verdict={t.verdict} alpha={alpha} />
      </div>
      {t.reason ? (
        <p className="text-sm text-zinc-500">{t.reason}</p>
      ) : (
        <>
          <ResultsLine t={t} alpha={alpha} />
          <RaritiesTable t={t} />
        </>
      )}
    </section>
  );
}

function ResultsLine({ t, alpha }: { t: TierFairness; alpha: number }) {
  const chi = t.chiSquared;
  const ks = t.ks;
  if (!chi || !ks) return <p className="text-sm text-zinc-500">Insufficient data.</p>;
  const chiOk = chi.pValue >= alpha;
  const ksOk = ks.pValue >= alpha;
  return (
    <div className="font-mono text-sm flex flex-wrap gap-x-6 gap-y-1">
      <span className={chiOk ? 'text-green-700' : 'text-red-700'}>
        χ² p = {fmtP(chi.pValue)} {chiOk ? '✓' : '✗'}
      </span>
      <span className="text-zinc-500">χ²={chi.chiSq.toFixed(2)}, df={chi.df}</span>
      <span className={ksOk ? 'text-green-700' : 'text-red-700'}>
        K-S p = {fmtP(ks.pValue)} {ksOk ? '✓' : '✗'}
      </span>
      <span className="text-zinc-500">
        D={ks.d.toFixed(4)}, λ={ks.lambda.toFixed(3)}, n={ks.n}
      </span>
    </div>
  );
}

function RaritiesTable({ t }: { t: TierFairness }) {
  const totalN = t.rarities.reduce((s, r) => s + r.observedCount, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead className="text-zinc-500">
          <tr className="border-b border-zinc-200">
            <th className="px-2 py-1 text-left">rarity</th>
            <th className="px-2 py-1 text-right">observed</th>
            <th className="px-2 py-1 text-right">obs proportion</th>
            <th className="px-2 py-1 text-right">expected weight</th>
            <th className="px-2 py-1 text-right">expected count</th>
            <th className="px-2 py-1 text-right">χ² contribution</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {t.rarities.map((r, i) => {
            const expectedCount = totalN * r.expectedWeight;
            const obsProp = totalN > 0 ? r.observedCount / totalN : 0;
            const contribution =
              expectedCount > 0
                ? Math.pow(r.observedCount - expectedCount, 2) / expectedCount
                : null;
            return (
              <tr key={r.rarity}>
                <td className="px-2 py-1">{r.rarity}</td>
                <td className="px-2 py-1 text-right">{r.observedCount}</td>
                <td className="px-2 py-1 text-right">{obsProp.toFixed(4)}</td>
                <td className="px-2 py-1 text-right">{r.expectedWeight.toFixed(4)}</td>
                <td className="px-2 py-1 text-right">{expectedCount.toFixed(2)}</td>
                <td className="px-2 py-1 text-right">
                  {contribution !== null ? contribution.toFixed(3) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
