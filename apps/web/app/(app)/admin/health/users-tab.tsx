'use client';

import useSWR from 'swr';

const REFRESH_MS = 30_000;

interface UsersResponse {
  retentionThreshold: number;
  totalUsers: number;
  dau: number;
  retentionEligible: number;
  retentionActed: number;
  retention7d: number | null;
  retentionAlert: boolean;
  packBuyers7d: number;
}

const fetcher = async (url: string): Promise<UsersResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
};

const fmtPct = (frac: number): string => `${(frac * 100).toFixed(1)}%`;

export default function UsersTab() {
  const { data, error, isLoading } = useSWR<UsersResponse>(
    '/api/admin/health/users',
    fetcher,
    { refreshInterval: REFRESH_MS },
  );
  if (isLoading) return <p className="text-sm text-zinc-500">Loading user metrics…</p>;
  if (error) return <p className="text-sm text-red-600">Failed to load: {String(error)}</p>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total users" value={String(data.totalUsers)} chip="neutral" />
        <Stat label="DAU (last 24h)" value={String(data.dau)} chip="neutral" />
        <Stat
          label="7-day retention"
          value={data.retention7d !== null ? fmtPct(data.retention7d) : '—'}
          chip={data.retentionAlert ? 'orange' : 'neutral'}
        />
        <Stat
          label="Pack buyers (7d)"
          value={String(data.packBuyers7d)}
          chip="neutral"
        />
      </div>

      <section className="bg-white border border-zinc-200 rounded p-4">
        <h3 className="text-base font-semibold mb-2">Retention detail</h3>
        <div className="text-sm text-zinc-700 space-y-1 font-mono">
          <div>
            <span className="text-zinc-500">eligible (created &gt; 7d ago) :</span>{' '}
            {data.retentionEligible}
          </div>
          <div>
            <span className="text-zinc-500">acted in last 7d&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;:</span>{' '}
            {data.retentionActed}
          </div>
          <div>
            <span className="text-zinc-500">retention&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;:</span>{' '}
            {data.retention7d !== null ? fmtPct(data.retention7d) : '—'}{' '}
            <span className="text-zinc-500">(threshold {fmtPct(data.retentionThreshold)})</span>
          </div>
        </div>
        {data.retentionAlert ? (
          <p className="text-sm text-orange-700 mt-3">
            ⚠ 7-day retention is below {fmtPct(data.retentionThreshold)} — investigate.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  chip,
}: {
  label: string;
  value: string;
  chip: 'orange' | 'neutral';
}) {
  const tone =
    chip === 'orange'
      ? 'bg-orange-50 border-orange-300 text-orange-900'
      : 'bg-white border-zinc-200 text-zinc-900';
  return (
    <div className={`border rounded p-3 ${tone}`}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-2xl font-mono mt-1">{value}</div>
    </div>
  );
}
