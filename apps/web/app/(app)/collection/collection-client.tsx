'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useChannel } from '@/hooks/use-socket';

interface Item {
  userCardId: string;
  cardId: string;
  acquiredPrice: number;
  name: string;
  setName: string;
  rarity: 'C' | 'U' | 'R' | 'E' | 'L';
  imageUrl: string;
  currentPrice: number;
}

interface UnopenedPack {
  id: string;
  tier: 'BRONZE' | 'SILVER' | 'GOLD';
  pricePaid: number;
}

const RARITY_BORDER: Record<Item['rarity'], string> = {
  C: 'border-zinc-300',
  U: 'border-green-400',
  R: 'border-blue-400',
  E: 'border-purple-500',
  L: 'border-amber-500',
};

const TIER_BG: Record<UnopenedPack['tier'], string> = {
  BRONZE: 'bg-amber-700',
  SILVER: 'bg-zinc-400',
  GOLD: 'bg-yellow-500',
};

function fmtUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function fmtUsdSigned(cents: number): string {
  return `${cents > 0 ? '+' : ''}${fmtUsd(cents)}`;
}

interface PriceUpdate {
  cardId: string;
  price: number;
}

function isPriceUpdate(x: unknown): x is PriceUpdate {
  return (
    typeof x === 'object' &&
    x !== null &&
    'cardId' in x &&
    typeof (x as { cardId: unknown }).cardId === 'string' &&
    'price' in x &&
    typeof (x as { price: unknown }).price === 'number'
  );
}

function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const parts = trimmed.split('.');
  const whole = parts[0] ?? '0';
  const frac = (parts[1] ?? '').padEnd(2, '0').slice(0, 2);
  const cents = parseInt(whole, 10) * 100 + parseInt(frac || '0', 10);
  return cents > 0 ? cents : null;
}

interface ListModalState {
  userCardId: string;
  cardName: string;
  suggestedCents: number;
}

interface AuctionModalState {
  userCardId: string;
  cardName: string;
  suggestedCents: number;
}

const DURATION_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 300, label: '5 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 7200, label: '2 hours' },
];

export default function CollectionClient({
  items,
  unopened,
}: {
  items: Item[];
  unopened: UnopenedPack[];
}) {
  const router = useRouter();
  const [prices, setPrices] = useState<Map<string, number>>(
    () => new Map(items.map((i) => [i.cardId, i.currentPrice])),
  );

  const [modal, setModal] = useState<ListModalState | null>(null);
  const [priceInput, setPriceInput] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [auctionModal, setAuctionModal] = useState<AuctionModalState | null>(null);
  const [auctionStartInput, setAuctionStartInput] = useState('');
  const [auctionDuration, setAuctionDuration] = useState<number>(1800);
  const [auctionError, setAuctionError] = useState<string | null>(null);
  const [auctionSubmitting, setAuctionSubmitting] = useState(false);

  // Wire contract for `prices:global`: publisher sends
  // `{ prices: Array<{ cardId, price }> }`. The Phase 6 pubsub bridge
  // spreads the object envelope, so the client receives that shape with
  // `channel: 'prices:global'` attached. Phase 11's price-refresh cron
  // must conform to this contract.
  //
  // Trial-scale fan-out: every connected client receives every change and
  // filters locally. ARCHITECTURE §16 — production would push only the
  // cards each user owns (per-user channel or server-side filtering on
  // socket data).
  useChannel('prices:global', {
    onEvent: (payload) => {
      const incoming = (payload as { prices?: unknown }).prices;
      if (!Array.isArray(incoming)) return;
      setPrices((prev) => {
        const next = new Map(prev);
        for (const upd of incoming) {
          if (!isPriceUpdate(upd)) continue;
          if (next.has(upd.cardId)) next.set(upd.cardId, upd.price);
        }
        return next;
      });
    },
  });

  const totalValue = useMemo(() => {
    let sum = 0;
    for (const item of items) {
      sum += prices.get(item.cardId) ?? item.currentPrice;
    }
    return sum;
  }, [items, prices]);

  function openListModal(item: Item): void {
    const suggested = prices.get(item.cardId) ?? item.currentPrice;
    setModal({ userCardId: item.userCardId, cardName: item.name, suggestedCents: suggested });
    setPriceInput((suggested / 100).toFixed(2));
    setSubmitError(null);
  }

  function closeListModal(): void {
    setModal(null);
    setPriceInput('');
    setSubmitError(null);
    setSubmitting(false);
  }

  async function submitListing(): Promise<void> {
    if (!modal) return;
    const cents = parseDollarsToCents(priceInput);
    if (cents === null) {
      setSubmitError('Enter a positive amount like 5.00.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCardId: modal.userCardId, priceCents: cents }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        listingId?: string;
        message?: string;
      };
      if (!res.ok) {
        setSubmitError(j.message ?? `Failed (${res.status})`);
        return;
      }
      if (j.listingId) {
        toast.success(`Listed for ${fmtUsd(cents)}`);
        router.push(`/market/${j.listingId}`);
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  }

  function openAuctionModal(item: Item): void {
    const suggested = prices.get(item.cardId) ?? item.currentPrice;
    setAuctionModal({
      userCardId: item.userCardId,
      cardName: item.name,
      suggestedCents: suggested,
    });
    setAuctionStartInput((Math.max(1, Math.floor(suggested / 2)) / 100).toFixed(2));
    setAuctionDuration(1800);
    setAuctionError(null);
  }

  function closeAuctionModal(): void {
    setAuctionModal(null);
    setAuctionStartInput('');
    setAuctionError(null);
    setAuctionSubmitting(false);
  }

  async function submitAuction(): Promise<void> {
    if (!auctionModal) return;
    const cents = parseDollarsToCents(auctionStartInput);
    if (cents === null) {
      setAuctionError('Enter a positive starting bid like 5.00.');
      return;
    }
    setAuctionSubmitting(true);
    setAuctionError(null);
    try {
      const res = await fetch('/api/auctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userCardId: auctionModal.userCardId,
          startPriceCents: cents,
          durationSec: auctionDuration,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        auctionId?: string;
        message?: string;
      };
      if (!res.ok) {
        setAuctionError(j.message ?? `Failed (${res.status})`);
        return;
      }
      if (j.auctionId) {
        const minutes = Math.round(auctionDuration / 60);
        toast.success(`Auction live — runs for ${minutes}m`);
        router.push(`/auctions/${j.auctionId}`);
        router.refresh();
      }
    } finally {
      setAuctionSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Collection</h1>
        <p className="text-sm text-zinc-500">
          {items.length} {items.length === 1 ? 'card' : 'cards'} · Total value{' '}
          <span className="font-mono text-zinc-900">{fmtUsd(totalValue)}</span>
        </p>
      </div>

      {unopened.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Unopened packs</h2>
          <ul className="flex flex-wrap gap-3">
            {unopened.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/packs/${p.id}`}
                  className={`${TIER_BG[p.tier]} text-white rounded px-4 py-2 inline-flex items-center gap-2 hover:opacity-90`}
                >
                  <span className="font-medium">{p.tier}</span>
                  <span className="text-xs opacity-80">{fmtUsd(p.pricePaid)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">
          📦 No cards yet — open a pack to start collecting.{' '}
          <Link href="/drops" className="underline hover:text-zinc-900">
            Browse drops →
          </Link>
        </p>
      ) : (
        <ul className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
          {items.map((c) => {
            const current = prices.get(c.cardId) ?? c.currentPrice;
            const pnl = current - c.acquiredPrice;
            const pnlClass =
              pnl > 0
                ? 'text-green-700'
                : pnl < 0
                  ? 'text-red-700'
                  : 'text-zinc-500';
            return (
              <li
                key={c.userCardId}
                className={`border-2 rounded bg-white p-2 transition-colors duration-150 hover:border-zinc-400 ${RARITY_BORDER[c.rarity] ?? 'border-zinc-300'}`}
              >
                <Image
                  src={c.imageUrl}
                  alt={c.name}
                  width={245}
                  height={342}
                  className="w-full h-auto"
                  unoptimized
                />
                <p className="mt-2 text-xs font-medium">{c.name}</p>
                <p className="text-xs text-zinc-500">{c.setName}</p>
                <p className="text-xs text-zinc-500">
                  {c.rarity} · <span className="font-mono">{fmtUsd(current)}</span>
                </p>
                <p className={`text-xs font-mono ${pnlClass}`}>{fmtUsdSigned(pnl)}</p>
                <div className="mt-2 flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => openListModal(c)}
                    className="flex-1 border border-zinc-300 rounded px-2 py-1 hover:bg-zinc-50"
                  >
                    List
                  </button>
                  <button
                    type="button"
                    onClick={() => openAuctionModal(c)}
                    className="flex-1 border border-zinc-300 rounded px-2 py-1 hover:bg-zinc-50"
                  >
                    Auction
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {auctionModal ? (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={closeAuctionModal}
        >
          <div
            className="bg-white rounded shadow-lg max-w-sm w-full p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Auction &ldquo;{auctionModal.cardName}&rdquo;</h2>
            <p className="text-sm text-zinc-500">
              Market price{' '}
              <span className="font-mono">{fmtUsd(auctionModal.suggestedCents)}</span>
            </p>
            <div className="space-y-1">
              <label className="text-sm">Starting bid (USD)</label>
              <input
                type="text"
                inputMode="decimal"
                value={auctionStartInput}
                onChange={(e) => setAuctionStartInput(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="w-full border border-zinc-300 rounded px-3 py-2 font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm">Duration</label>
              <select
                value={auctionDuration}
                onChange={(e) => setAuctionDuration(Number(e.target.value))}
                className="w-full border border-zinc-300 rounded px-3 py-2"
              >
                {DURATION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            {auctionError ? <p className="text-sm text-red-600">{auctionError}</p> : null}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={closeAuctionModal}
                disabled={auctionSubmitting}
                className="px-4 py-2 rounded text-sm border border-zinc-300 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAuction}
                disabled={auctionSubmitting}
                className="px-4 py-2 rounded text-sm bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {auctionSubmitting ? 'Starting…' : 'Start auction'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal ? (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={closeListModal}
        >
          <div
            className="bg-white rounded shadow-lg max-w-sm w-full p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">List &ldquo;{modal.cardName}&rdquo;</h2>
            <p className="text-sm text-zinc-500">
              Market price{' '}
              <span className="font-mono">{fmtUsd(modal.suggestedCents)}</span>
            </p>
            <div className="space-y-1">
              <label className="text-sm">Price (USD)</label>
              <input
                type="text"
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="w-full border border-zinc-300 rounded px-3 py-2 font-mono"
              />
            </div>
            {submitError ? <p className="text-sm text-red-600">{submitError}</p> : null}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={closeListModal}
                disabled={submitting}
                className="px-4 py-2 rounded text-sm border border-zinc-300 hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitListing}
                disabled={submitting}
                className="px-4 py-2 rounded text-sm bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {submitting ? 'Listing…' : 'Create listing'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
