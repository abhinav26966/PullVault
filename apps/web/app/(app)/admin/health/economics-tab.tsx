'use client';

import useSWR from 'swr';

const REFRESH_MS = 30_000;

const fetcher = async (url: string): Promise<unknown> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
};

export default function EconomicsTab() {
  const { data, error, isLoading } = useSWR('/api/admin/health/economics', fetcher, {
    refreshInterval: REFRESH_MS,
  });
  if (isLoading) return <p className="text-sm text-zinc-500">Loading economics…</p>;
  if (error) return <p className="text-sm text-red-600">Failed to load: {String(error)}</p>;
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
}
