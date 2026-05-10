'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useChannel } from '@/hooks/use-socket';

function generateClientSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface InitialDrop {
  id: string;
  tier: 'BRONZE' | 'SILVER' | 'GOLD';
  priceCents: number;
  inventoryTotal: number;
  inventoryRemaining: number;
  startsAt: string;
  state: 'SCHEDULED' | 'OPEN' | 'SOLD_OUT' | 'CLOSED';
}

const TIER_BAR: Record<InitialDrop['tier'], string> = {
  BRONZE: 'bg-amber-700',
  SILVER: 'bg-zinc-500',
  GOLD: 'bg-amber-500',
};

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function DropBuyClient({ initial }: { initial: InitialDrop }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inventoryRemaining, setInventoryRemaining] = useState(
    initial.inventoryRemaining,
  );
  const [serverState, setServerState] = useState<InitialDrop['state']>(
    initial.state,
  );
  // Provably-fair client seed (Part B §12). Default = 32 random bytes (64 hex
  // chars). Mutable so a power user can pin their own seed; the server
  // accepts any 32–128 hex string. Generated on mount so SSR doesn't hydrate
  // a stale value.
  const [clientSeed, setClientSeed] = useState<string>('');
  const [seedExpanded, setSeedExpanded] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientSeed) setClientSeed(generateClientSeed());
  }, [clientSeed]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const seedPreview = useMemo(
    () => (clientSeed ? `${clientSeed.slice(0, 8)}…${clientSeed.slice(-4)}` : '—'),
    [clientSeed],
  );

  useChannel(`drop:${initial.id}`, {
    onEvent: (payload) => {
      if (typeof payload.inventoryRemaining === 'number') {
        setInventoryRemaining(payload.inventoryRemaining);
      }
      if (payload.soldOut === true) setServerState('SOLD_OUT');
      if (payload.state === 'OPEN') setServerState('OPEN');
    },
    onReconnect: () => router.refresh(),
  });

  const startsAtMs = new Date(initial.startsAt).getTime();
  const secondsUntil = Math.max(0, Math.ceil((startsAtMs - now) / 1000));
  const reachedStart = now >= startsAtMs;

  const isOpen =
    serverState === 'OPEN' || (serverState === 'SCHEDULED' && reachedStart);
  const soldOut = serverState === 'SOLD_OUT' || inventoryRemaining === 0;

  async function buy(): Promise<void> {
    if (!/^[0-9a-fA-F]{32,128}$/.test(clientSeed)) {
      setSeedError('Client seed must be 32–128 hex chars.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/drops/${initial.id}/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_seed: clientSeed }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        packId?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(j.message ?? `Buy failed (${res.status})`);
        return;
      }
      if (j.packId) {
        toast.success('Pack acquired — opening…');
        router.replace(`/packs/${j.packId}`);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  let buttonContent: React.ReactNode = `Buy for ${fmtUsd(initial.priceCents)}`;
  if (busy) {
    buttonContent = (
      <>
        <span className="spinner" />
        Buying…
      </>
    );
  } else if (soldOut) buttonContent = 'Sold out';
  else if (!isOpen) buttonContent = `Opens in ${secondsUntil}s`;

  const fillPercent =
    initial.inventoryTotal > 0
      ? Math.round((inventoryRemaining / initial.inventoryTotal) * 100)
      : 0;

  let statusLabel = '—';
  let statusClass = 'text-zinc-500';
  if (soldOut) {
    statusLabel = 'SOLD OUT';
    statusClass = 'text-red-600';
  } else if (isOpen) {
    statusLabel = 'LIVE';
    statusClass = 'text-green-600';
  } else {
    statusLabel = `Opens in ${secondsUntil}s`;
    statusClass = 'text-zinc-700';
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-zinc-200 rounded-lg p-6 space-y-5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs uppercase tracking-widest text-zinc-500">
            Status
          </span>
          <span
            className={`text-sm font-mono font-medium tabular-nums ${statusClass}`}
            suppressHydrationWarning
          >
            {statusLabel}
          </span>
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-zinc-500">Inventory</span>
            <span className="font-mono tabular-nums text-zinc-900">
              {inventoryRemaining} / {initial.inventoryTotal} packs
            </span>
          </div>
          <div className="h-2 bg-zinc-200 rounded-full overflow-hidden">
            <div
              className={`h-full ${TIER_BAR[initial.tier]} transition-all duration-300`}
              style={{ width: soldOut ? '0%' : `${fillPercent}%` }}
            />
          </div>
        </div>
      </div>
      <button
        onClick={buy}
        disabled={!isOpen || soldOut || busy}
        className="w-full bg-zinc-900 text-white rounded-md py-3 font-medium hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center justify-center transition-colors"
      >
        {buttonContent}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="text-xs text-zinc-500 space-y-2">
        <button
          type="button"
          onClick={() => setSeedExpanded((v) => !v)}
          className="hover:text-zinc-700 underline-offset-2 hover:underline"
        >
          Provably-fair seed: <span className="font-mono">{seedPreview}</span>{' '}
          ({seedExpanded ? 'hide' : 'change'})
        </button>
        {seedExpanded ? (
          <div className="space-y-1">
            <input
              type="text"
              value={clientSeed}
              onChange={(e) => {
                setClientSeed(e.target.value.trim());
                setSeedError(null);
              }}
              spellCheck={false}
              className="w-full font-mono text-xs px-2 py-1 border border-zinc-200 rounded"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setClientSeed(generateClientSeed());
                  setSeedError(null);
                }}
                className="text-xs text-zinc-600 hover:text-zinc-900"
              >
                Generate new
              </button>
              <span className="text-xs text-zinc-400">
                After buying, verify on /verify/&lt;packId&gt;.
              </span>
            </div>
            {seedError ? (
              <p className="text-xs text-red-600">{seedError}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
