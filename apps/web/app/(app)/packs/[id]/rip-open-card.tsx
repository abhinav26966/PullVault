'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import toast from 'react-hot-toast';
import { TIER_CONFIG } from '@pullvault/domain';
import { PackTile } from '@/components/pack-tile';
import { openPack } from './actions';

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
        toast.success(`${TIER_CONFIG[tier].cardCount} cards added to your collection`);
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
      <PackTile tier={tier} size="lg" />
      <button
        onClick={rip}
        disabled={pending}
        className="bg-zinc-900 text-white rounded px-6 py-3 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center"
      >
        {pending ? (
          <>
            <span className="spinner" />
            Opening…
          </>
        ) : (
          'Rip Open'
        )}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
