'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { openPack } from './actions';

const TIER_BG: Record<'BRONZE' | 'SILVER' | 'GOLD', string> = {
  BRONZE: 'bg-amber-700',
  SILVER: 'bg-zinc-400',
  GOLD: 'bg-yellow-500',
};

interface Props {
  packId: string;
  tier: 'BRONZE' | 'SILVER' | 'GOLD';
  pricePaid: number;
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function RipOpenCard({ packId, tier, pricePaid }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function rip(): void {
    setError(null);
    startTransition(async () => {
      try {
        await openPack(packId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open pack');
      }
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{tier} pack</h1>
        <p className="text-sm text-zinc-500">Paid {fmtUsd(pricePaid)}</p>
      </div>
      <div
        className={`${TIER_BG[tier]} aspect-[3/4] max-w-[240px] rounded-lg flex items-center justify-center shadow-md`}
      >
        <span className="text-white text-2xl font-bold tracking-wide">{tier}</span>
      </div>
      <button
        onClick={rip}
        disabled={pending}
        className="bg-zinc-900 text-white rounded px-6 py-3 hover:bg-zinc-800 disabled:opacity-50"
      >
        {pending ? 'Opening…' : 'Rip Open'}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
