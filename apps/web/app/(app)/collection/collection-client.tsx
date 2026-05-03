'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { useChannel } from '@/hooks/use-socket';
import { PackTile } from '@/components/pack-tile';

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

type CardDetailState = Item;

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
  const searchParams = useSearchParams();
  const cardsSectionRef = useRef<HTMLDivElement | null>(null);
  // Portal mount guard: document.body doesn't exist during SSR.
  // We only render the portaled modals after the first client mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const [showAuctionPrompt, setShowAuctionPrompt] = useState(
    () => searchParams?.get('action') === 'auction',
  );
  // Deep-link from /auctions's "+ Create Auction" button drops the user here.
  // Scroll the cards grid into view once on mount so the prompt isn't off-screen.
  useEffect(() => {
    if (showAuctionPrompt && cardsSectionRef.current) {
      cardsSectionRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
    // intentionally one-shot on mount — no deps that should retrigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const [cardDetail, setCardDetail] = useState<CardDetailState | null>(null);
  function openCardDetail(item: Item): void {
    setCardDetail(item);
  }
  function closeCardDetail(): void {
    setCardDetail(null);
  }

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
          <ul className="flex flex-wrap gap-4">
            {unopened.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/packs/${p.id}`}
                  className="group inline-block transition-transform duration-150 hover:scale-105"
                >
                  <PackTile tier={p.tier} size="md" />
                  <p className="mt-2 text-xs text-zinc-500 text-center font-mono">
                    {fmtUsd(p.pricePaid)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div ref={cardsSectionRef} className="space-y-3">
        {showAuctionPrompt && items.length > 0 ? (
          <div className="bg-zinc-900 text-white rounded-md px-4 py-3 flex items-center justify-between">
            <span className="text-sm">Pick a card to auction</span>
            <button
              type="button"
              onClick={() => setShowAuctionPrompt(false)}
              aria-label="Dismiss"
              className="text-zinc-400 hover:text-white text-lg leading-none"
            >
              ×
            </button>
          </div>
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
              <li key={c.userCardId}>
                <button
                  type="button"
                  onClick={() => openCardDetail(c)}
                  className={`w-full text-left border-2 rounded bg-white p-2 transition-all duration-150 hover:border-zinc-400 hover:shadow-md cursor-pointer ${RARITY_BORDER[c.rarity] ?? 'border-zinc-300'}`}
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
                    {c.rarity} ·{' '}
                    <span className="font-mono">{fmtUsd(current)}</span>
                  </p>
                  <p className={`text-xs font-mono ${pnlClass}`}>
                    {fmtUsdSigned(pnl)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      </div>

      {mounted && auctionModal
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-md flex items-center justify-center p-4 animate-modal-backdrop-in"
              onClick={closeAuctionModal}
            >
          <div
            className="relative z-[101] bg-white rounded-lg border border-zinc-200 shadow-xl max-w-sm w-full p-6 space-y-4 animate-modal-panel-in"
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
                className="px-4 py-2 rounded text-sm border border-zinc-300 hover:bg-zinc-100 transition-colors duration-150"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAuction}
                disabled={auctionSubmitting}
                className="px-4 py-2 rounded text-sm bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center justify-center"
              >
                {auctionSubmitting ? (
                  <>
                    <span className="spinner" />
                    Creating auction…
                  </>
                ) : (
                  'Start auction'
                )}
              </button>
            </div>
          </div>
        </div>,
            document.body,
          )
        : null}

      {mounted && modal
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-md flex items-center justify-center p-4 animate-modal-backdrop-in"
              onClick={closeListModal}
            >
          <div
            className="relative z-[101] bg-white rounded-lg border border-zinc-200 shadow-xl max-w-sm w-full p-6 space-y-4 animate-modal-panel-in"
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
                className="px-4 py-2 rounded text-sm border border-zinc-300 hover:bg-zinc-100 transition-colors duration-150"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitListing}
                disabled={submitting}
                className="px-4 py-2 rounded text-sm bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center justify-center"
              >
                {submitting ? (
                  <>
                    <span className="spinner" />
                    Creating listing…
                  </>
                ) : (
                  'Create listing'
                )}
              </button>
            </div>
          </div>
        </div>,
            document.body,
          )
        : null}

      {mounted && cardDetail
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-md flex items-center justify-center p-4 animate-modal-backdrop-in"
              onClick={closeCardDetail}
            >
              <div
                className="relative z-[101] bg-white rounded-lg border border-zinc-200 shadow-xl max-w-md w-full p-6 space-y-4 animate-modal-panel-in"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={closeCardDetail}
                  aria-label="Close"
                  className="absolute top-3 right-3 text-zinc-400 hover:text-zinc-700 text-xl leading-none"
                >
                  ×
                </button>
                {(() => {
                  const current = prices.get(cardDetail.cardId) ?? cardDetail.currentPrice;
                  const pnl = current - cardDetail.acquiredPrice;
                  const pnlClass =
                    pnl > 0
                      ? 'text-green-700'
                      : pnl < 0
                        ? 'text-red-700'
                        : 'text-zinc-500';
                  return (
                    <>
                      <div className="flex justify-center pt-2">
                        <Image
                          src={cardDetail.imageUrl}
                          alt={cardDetail.name}
                          width={245}
                          height={342}
                          className={`w-64 h-auto rounded border-2 ${RARITY_BORDER[cardDetail.rarity] ?? 'border-zinc-300'}`}
                          unoptimized
                        />
                      </div>
                      <div className="text-center space-y-1">
                        <h2 className="text-lg font-semibold">{cardDetail.name}</h2>
                        <p className="text-sm text-zinc-500">{cardDetail.setName}</p>
                        <p className="text-xs uppercase tracking-widest text-zinc-500">
                          Rarity {cardDetail.rarity}
                        </p>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-center text-sm bg-zinc-50 border border-zinc-200 rounded-md p-3">
                        <div>
                          <p className="text-xs text-zinc-500">Acquired</p>
                          <p className="font-mono">
                            {fmtUsd(cardDetail.acquiredPrice)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-zinc-500">Market</p>
                          <p className="font-mono">{fmtUsd(current)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-zinc-500">P&amp;L</p>
                          <p className={`font-mono ${pnlClass}`}>
                            {fmtUsdSigned(pnl)}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            const item = cardDetail;
                            closeCardDetail();
                            openListModal(item);
                          }}
                          className="flex-1 px-4 py-2.5 rounded-md text-sm font-medium border border-zinc-300 hover:bg-zinc-100 transition-colors duration-150"
                        >
                          List for Sale
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const item = cardDetail;
                            closeCardDetail();
                            openAuctionModal(item);
                          }}
                          className="flex-1 px-4 py-2.5 rounded-md text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 transition-colors duration-150"
                        >
                          Start Auction
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
