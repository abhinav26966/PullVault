'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useChannel } from '@/hooks/use-socket';

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

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

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
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/drops/${initial.id}/buy`, { method: 'POST' });
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
    </div>
  );
}
