'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import toast from 'react-hot-toast';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface Props {
  listingId: string;
  isSeller: boolean;
  priceCents: number;
}

export default function ListingActions({ listingId, isSeller, priceCents }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(
    path: string,
    redirectOnSuccess: string,
    successToast: string | null,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method: 'POST' });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(j.message ?? `Request failed (${res.status})`);
        return;
      }
      if (successToast) toast.success(successToast);
      router.replace(redirectOnSuccess);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (isSeller) {
    return (
      <div className="space-y-2">
        <button
          onClick={() =>
            call(
              `/api/listings/${listingId}/cancel`,
              '/collection',
              'Listing cancelled',
            )
          }
          disabled={busy}
          className="bg-zinc-200 text-zinc-900 rounded px-6 py-3 hover:bg-zinc-300 disabled:opacity-50"
        >
          {busy ? 'Cancelling…' : 'Cancel listing'}
        </button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() =>
          call(
            `/api/listings/${listingId}/buy`,
            '/collection',
            `Card acquired for ${fmtUsd(priceCents)}`,
          )
        }
        disabled={busy}
        className="bg-zinc-900 text-white rounded px-6 py-3 hover:bg-zinc-800 disabled:opacity-50"
      >
        {busy ? 'Buying…' : `Buy for ${fmtUsd(priceCents)}`}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
