'use client';

import { useState } from 'react';
import useSWR from 'swr';
import toast from 'react-hot-toast';

const REFRESH_MS = 30_000;
type Tier = 'BRONZE' | 'SILVER' | 'GOLD';
const TIERS: readonly Tier[] = ['BRONZE', 'SILVER', 'GOLD'];

interface TierSummary {
  tier: Tier;
  priceCents: number;
  packsOpened: number;
  activeSnapshot: {
    targetMargin: number | null;
    evCents: number;
    winRate: number;
    createdAt: string;
  } | null;
  realizedEvCents: number | null;
  realizedMargin: number | null;
  marginDelta: number | null;
  marginAlert: boolean;
}

interface SelfTestFailure {
  tier: Tier;
  rawNotes: string | null;
  createdAt: string;
  lagrangian: number | null;
  tilt: number | null;
  delta: number | null;
}

interface EconomicsResponse {
  tiers: TierSummary[];
  totalFeesCents: number;
  selfTestFailure: SelfTestFailure | null;
}

interface SimulateResponse {
  tier: Tier;
  priceCents: number;
  n: number;
  result: {
    meanCents: number;
    p5Cents: number;
    p50Cents: number;
    p95Cents: number;
    marginActual: number;
    winRate: number;
    mode: string;
  };
}

const fmtUsd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const fmtPct = (frac: number): string => `${(frac * 100).toFixed(2)}%`;

const fetcher = async (url: string): Promise<EconomicsResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
};

export default function EconomicsTab() {
  const { data, error, isLoading, mutate } = useSWR<EconomicsResponse>(
    '/api/admin/health/economics',
    fetcher,
    { refreshInterval: REFRESH_MS },
  );

  if (isLoading) return <p className="text-sm text-zinc-500">Loading economics…</p>;
  if (error) return <p className="text-sm text-red-600">Failed to load: {String(error)}</p>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {data.selfTestFailure ? <SelfTestBanner failure={data.selfTestFailure} /> : null}
      <TierTable tiers={data.tiers} />
      <FeesPanel totalFeesCents={data.totalFeesCents} />
      <RecomputePanel onComplete={() => mutate()} />
      <SimulatePanel />
    </div>
  );
}

function SelfTestBanner({ failure }: { failure: SelfTestFailure }) {
  return (
    <div className="border-2 border-red-400 bg-red-50 rounded-lg p-4 space-y-1">
      <p className="text-red-900 font-semibold text-base">
        Solver self-test failed; weights NOT activated
      </p>
      <p className="text-sm text-red-800">
        Tier <span className="font-mono">{failure.tier}</span> at{' '}
        <span className="font-mono">{new Date(failure.createdAt).toISOString()}</span>
      </p>
      <div className="font-mono text-xs text-red-900 grid grid-cols-3 gap-x-6 max-w-md mt-2">
        <div>
          <div className="text-red-700">lagrangian</div>
          <div>{failure.lagrangian ?? '—'}</div>
        </div>
        <div>
          <div className="text-red-700">tilt</div>
          <div>{failure.tilt ?? '—'}</div>
        </div>
        <div>
          <div className="text-red-700">delta</div>
          <div>{failure.delta ?? '—'}</div>
        </div>
      </div>
      <p className="text-xs text-red-800 mt-2">
        Raw: <span className="font-mono">{failure.rawNotes}</span>
      </p>
    </div>
  );
}

function TierTable({ tiers }: { tiers: TierSummary[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Per-tier economics</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm bg-white border border-zinc-200 rounded">
          <thead className="bg-zinc-50 text-zinc-600">
            <tr>
              <th className="px-3 py-2 text-left">Tier</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Target margin</th>
              <th className="px-3 py-2 text-right">Realized margin</th>
              <th className="px-3 py-2 text-right">Δ</th>
              <th className="px-3 py-2 text-right">Win rate</th>
              <th className="px-3 py-2 text-right">Packs opened</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 font-mono">
            {tiers.map((t) => (
              <tr key={t.tier} className={t.marginAlert ? 'bg-red-50' : ''}>
                <td className="px-3 py-2 font-sans font-medium">{t.tier}</td>
                <td className="px-3 py-2 text-right">{fmtUsd(t.priceCents)}</td>
                <td className="px-3 py-2 text-right">
                  {t.activeSnapshot?.targetMargin != null
                    ? fmtPct(t.activeSnapshot.targetMargin)
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {t.realizedMargin != null ? fmtPct(t.realizedMargin) : '—'}
                </td>
                <td
                  className={`px-3 py-2 text-right ${
                    t.marginAlert ? 'text-red-700 font-bold' : ''
                  }`}
                >
                  {t.marginDelta != null
                    ? `${t.marginDelta >= 0 ? '+' : ''}${fmtPct(t.marginDelta)}`
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {t.activeSnapshot ? fmtPct(t.activeSnapshot.winRate) : '—'}
                </td>
                <td className="px-3 py-2 text-right">{t.packsOpened}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">
        Δ &gt; 2% triggers a red row — actual margin diverging from the active solver
        target by more than 2pp suggests the snapshot is stale or the pool composition
        shifted.
      </p>
    </section>
  );
}

function FeesPanel({ totalFeesCents }: { totalFeesCents: number }) {
  return (
    <section className="bg-white border border-zinc-200 rounded p-6">
      <p className="text-sm text-zinc-500">Cumulative platform fees</p>
      <p className="text-3xl font-mono mt-1">{fmtUsd(totalFeesCents)}</p>
      <p className="text-xs text-zinc-500 mt-2">
        Sum of LISTING_FEE + AUCTION_FEE ledger entries against the platform user.
        Same source as the Part A /admin/economics page.
      </p>
    </section>
  );
}

function RecomputePanel({ onComplete }: { onComplete: () => void }) {
  const [busy, setBusy] = useState(false);
  const [targetMargin, setTargetMargin] = useState('0.30');

  async function recompute(): Promise<void> {
    const tm = Number(targetMargin);
    if (!Number.isFinite(tm) || tm < 0 || tm > 0.95) {
      toast.error('targetMargin must be in [0, 0.95]');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/economics/recompute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetMargin: tm, trigger: 'health-tab' }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(j.message ?? `HTTP ${res.status}`);
      }
      toast.success('Recompute applied — refreshing dashboard');
      onComplete();
    } catch (e) {
      toast.error(`Recompute failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white border border-zinc-200 rounded p-6 space-y-3">
      <div>
        <h2 className="text-lg font-medium">Recompute solver weights</h2>
        <p className="text-xs text-zinc-500 mt-1">
          Runs the per-slot Lagrangian solver against current{' '}
          <span className="font-mono">card_prices</span> and writes a new active snapshot
          per tier. Existing in-flight packs stay on their per-pack snapshot.
        </p>
      </div>
      <div className="flex items-end gap-3">
        <label className="text-sm">
          <span className="block text-zinc-600 text-xs mb-1">target margin</span>
          <input
            type="text"
            value={targetMargin}
            onChange={(e) => setTargetMargin(e.target.value)}
            className="font-mono text-sm border border-zinc-300 rounded px-2 py-1 w-24"
          />
        </label>
        <button
          onClick={recompute}
          disabled={busy}
          className="bg-zinc-900 text-white px-4 py-2 rounded text-sm font-medium hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? 'Recomputing…' : 'Recompute now'}
        </button>
      </div>
    </section>
  );
}

function SimulatePanel() {
  const [tier, setTier] = useState<Tier>('BRONZE');
  const [n, setN] = useState('10000');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulateResponse | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    try {
      const url = `/api/admin/economics/simulate?tier=${tier}&n=${n}`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(j.message ?? `HTTP ${res.status}`);
      }
      setResult((await res.json()) as SimulateResponse);
    } catch (e) {
      toast.error(`Simulate failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-white border border-zinc-200 rounded p-6 space-y-3">
      <div>
        <h2 className="text-lg font-medium">Monte Carlo simulator</h2>
        <p className="text-xs text-zinc-500 mt-1">
          Runs N simulated pack openings under the active snapshot weights; reports
          mean realized value, percentile distribution, margin, and win rate.
        </p>
      </div>
      <div className="flex items-end gap-3">
        <label className="text-sm">
          <span className="block text-zinc-600 text-xs mb-1">tier</span>
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as Tier)}
            className="text-sm border border-zinc-300 rounded px-2 py-1"
          >
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-zinc-600 text-xs mb-1">n</span>
          <input
            type="text"
            value={n}
            onChange={(e) => setN(e.target.value)}
            className="font-mono text-sm border border-zinc-300 rounded px-2 py-1 w-24"
          />
        </label>
        <button
          onClick={run}
          disabled={busy}
          className="bg-zinc-900 text-white px-4 py-2 rounded text-sm font-medium hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? 'Simulating…' : 'Run simulation'}
        </button>
      </div>
      {result ? (
        <div className="border-t border-zinc-100 pt-3 mt-3 grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm font-mono">
          <Stat label="mean" value={fmtUsd(result.result.meanCents)} />
          <Stat label="margin" value={fmtPct(result.result.marginActual)} />
          <Stat label="win rate" value={fmtPct(result.result.winRate)} />
          <Stat label="p5" value={fmtUsd(result.result.p5Cents)} />
          <Stat label="p50" value={fmtUsd(result.result.p50Cents)} />
          <Stat label="p95" value={fmtUsd(result.result.p95Cents)} />
          <Stat label="mode" value={result.result.mode} />
          <Stat label="n" value={String(result.n)} />
          <Stat label="price" value={fmtUsd(result.priceCents)} />
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div>{value}</div>
    </div>
  );
}
