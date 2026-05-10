'use client';

import useSWR from 'swr';

const REFRESH_MS = 30_000;

interface FraudResponse {
  botThreshold: number;
  highRiskCount: number;
  highRiskUsers: Array<{
    id: string;
    displayName: string;
    botScore: number;
    flagMultiAccount: boolean;
    signupAt: string;
  }>;
  clusterCount: number;
  unreviewedAuctionFlags: number;
  rateLimitBlocks24h: number;
  topClusters: Array<{
    id: string;
    reason: string;
    userCount: number;
    createdAt: string;
  }>;
}

const fetcher = async (url: string): Promise<FraudResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
};

export default function FraudTab() {
  const { data, error, isLoading } = useSWR<FraudResponse>(
    '/api/admin/health/fraud',
    fetcher,
    { refreshInterval: REFRESH_MS },
  );
  if (isLoading) return <p className="text-sm text-zinc-500">Loading fraud signals…</p>;
  if (error) return <p className="text-sm text-red-600">Failed to load: {String(error)}</p>;
  if (!data) return null;

  const hasHighRisk = data.highRiskCount > 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={`bot_score > ${data.botThreshold}`} value={String(data.highRiskCount)}
              chip={hasHighRisk ? 'orange' : 'neutral'} />
        <Stat label="Account clusters" value={String(data.clusterCount)} chip="neutral" />
        <Stat
          label="Unreviewed auction flags"
          value={String(data.unreviewedAuctionFlags)}
          chip={data.unreviewedAuctionFlags > 0 ? 'orange' : 'neutral'}
        />
        <Stat label="Rate-limit blocks (24h)" value={String(data.rateLimitBlocks24h)} chip="neutral" />
      </div>

      <section className="bg-white border border-zinc-200 rounded p-4 space-y-2">
        <h3 className="text-base font-semibold">High-risk users</h3>
        {data.highRiskUsers.length === 0 ? (
          <p className="text-sm text-zinc-500">No users above threshold.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-zinc-600 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">Display name</th>
                  <th className="px-3 py-2 text-right">bot_score</th>
                  <th className="px-3 py-2 text-center">multi-acct</th>
                  <th className="px-3 py-2 text-left">signup</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 font-mono text-xs">
                {data.highRiskUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-1.5 font-sans">{u.displayName}</td>
                    <td className="px-3 py-1.5 text-right text-orange-700 font-bold">{u.botScore}</td>
                    <td className="px-3 py-1.5 text-center">{u.flagMultiAccount ? '⚠' : '—'}</td>
                    <td className="px-3 py-1.5 text-zinc-500">
                      {new Date(u.signupAt).toISOString().slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white border border-zinc-200 rounded p-4 space-y-2">
        <h3 className="text-base font-semibold">Recent account clusters</h3>
        {data.topClusters.length === 0 ? (
          <p className="text-sm text-zinc-500">No clusters detected yet.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {data.topClusters.map((c) => (
              <li key={c.id} className="font-mono text-xs">
                <span className="text-zinc-500">
                  {new Date(c.createdAt).toISOString().slice(0, 10)}
                </span>{' '}
                · <span>{c.reason}</span>{' '}
                <span className="text-zinc-500">({c.userCount} users)</span>
              </li>
            ))}
          </ul>
        )}
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
