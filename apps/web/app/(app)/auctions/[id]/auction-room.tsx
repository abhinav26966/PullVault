'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { computeMinValidBid } from '@pullvault/domain';
import { useChannel } from '@/hooks/use-socket';

interface BidRow {
  id: string;
  amount: number;
  placedAt: string;
  bidderId: string;
  bidderDisplayName: string;
}

interface InitialState {
  state: 'OPEN' | 'CLOSED' | 'SETTLED';
  startingBid: number;
  currentBid: number | null;
  currentBidUserId: string | null;
  currentBidDisplayName: string | null;
  endsAt: string;
  minNextBid: number;
  currentUserId: string;
  bids: BidRow[];
}

interface Props {
  auctionId: string;
  isSeller: boolean;
  card: {
    name: string;
    setName: string;
    rarity: string;
    currentMarketPrice: number;
  };
  sellerDisplayName: string;
  initialState: InitialState;
}

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtCountdown(seconds: number): string {
  if (seconds <= 0) return 'ended';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
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

interface ClosedEvent {
  event: 'closed';
  state?: 'SETTLED' | 'CLOSED';
  winnerId?: string | null;
  winnerDisplayName?: string | null;
  finalBid?: number | null;
}

interface BidEvent {
  event: 'bid';
  currentBid?: number;
  currentBidUserId?: string;
  currentBidderDisplayName?: string;
  endsAt?: string;
  placedAt?: string;
}

interface WatchersEvent {
  event: 'watchers';
  count?: number;
}

export default function AuctionRoom({
  auctionId,
  isSeller,
  card,
  sellerDisplayName,
  initialState,
}: Props) {
  const router = useRouter();

  const [state, setState] = useState(initialState.state);
  const [currentBid, setCurrentBid] = useState(initialState.currentBid);
  const [currentBidDisplayName, setCurrentBidDisplayName] = useState(
    initialState.currentBidDisplayName,
  );
  const [endsAt, setEndsAt] = useState(initialState.endsAt);
  const [bidList, setBidList] = useState<BidRow[]>(initialState.bids);
  const [watchers, setWatchers] = useState(0);
  const [closedBanner, setClosedBanner] = useState<{
    state: 'SETTLED' | 'CLOSED';
    winnerId: string | null;
    winnerDisplayName: string | null;
    finalBid: number | null;
  } | null>(null);
  const [outbidAt, setOutbidAt] = useState<number | null>(null);

  // Auto-dismiss the outbid banner after 5 seconds. The bid event handler
  // also clears it whenever the current user reclaims the high-bidder slot.
  useEffect(() => {
    if (outbidAt === null) return;
    const id = setTimeout(() => setOutbidAt(null), 5000);
    return () => clearTimeout(id);
  }, [outbidAt]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const minNext = useMemo(
    () => computeMinValidBid(currentBid, initialState.startingBid),
    [currentBid, initialState.startingBid],
  );

  const [bidInput, setBidInput] = useState(() => (initialState.minNextBid / 100).toFixed(2));
  const [bidError, setBidError] = useState<string | null>(null);
  const [bidBusy, setBidBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Re-suggest min when minNext changes (after a new bid arrives, prefill the
  // form with the new minimum so the user doesn't have to retype).
  useEffect(() => {
    setBidInput((minNext / 100).toFixed(2));
  }, [minNext]);

  useChannel(`auction:${auctionId}`, {
    onEvent: (payload) => {
      const ev = (payload as { event?: string }).event;
      if (ev === 'bid') {
        const e = payload as unknown as BidEvent;
        if (typeof e.currentBid === 'number') setCurrentBid(e.currentBid);
        if (typeof e.currentBidderDisplayName === 'string') {
          setCurrentBidDisplayName(e.currentBidderDisplayName);
        }
        if (typeof e.endsAt === 'string') setEndsAt(e.endsAt);
        // If the current user is the new high bidder, clear any pending
        // outbid banner — they reclaimed the top slot.
        if (e.currentBidUserId === initialState.currentUserId) {
          setOutbidAt(null);
        }
        if (
          typeof e.currentBid === 'number' &&
          typeof e.currentBidUserId === 'string' &&
          typeof e.currentBidderDisplayName === 'string' &&
          typeof e.placedAt === 'string'
        ) {
          const newBid: BidRow = {
            id: `${e.placedAt}-${e.currentBidUserId}`,
            amount: e.currentBid,
            placedAt: e.placedAt,
            bidderId: e.currentBidUserId,
            bidderDisplayName: e.currentBidderDisplayName,
          };
          setBidList((prev) =>
            prev.some((b) => b.id === newBid.id) ? prev : [newBid, ...prev].slice(0, 50),
          );
        }
      } else if (ev === 'watchers') {
        const e = payload as unknown as WatchersEvent;
        if (typeof e.count === 'number') setWatchers(e.count);
      } else if (ev === 'closed') {
        const e = payload as unknown as ClosedEvent;
        const closed = {
          state: (e.state ?? 'SETTLED') as 'SETTLED' | 'CLOSED',
          winnerId: e.winnerId ?? null,
          winnerDisplayName: e.winnerDisplayName ?? null,
          finalBid: e.finalBid ?? null,
        };
        setState(closed.state);
        setClosedBanner(closed);
      }
    },
    onReconnect: () => router.refresh(),
  });

  // user:{currentUserId} room delivers outbid notifications. Server
  // publishes this from the bid POST whenever a previous high bidder
  // exists; we surface it as an inline banner per the no-toast scope cut.
  useChannel(`user:${initialState.currentUserId}`, {
    onEvent: (payload) => {
      const ev = (payload as { event?: string }).event;
      const eventAuctionId = (payload as { auctionId?: unknown }).auctionId;
      if (ev === 'outbid' && eventAuctionId === auctionId) {
        setOutbidAt(Date.now());
      }
    },
  });

  const endsAtMs = new Date(endsAt).getTime();
  const secsLeft = Math.max(0, Math.ceil((endsAtMs - now) / 1000));
  const expired = secsLeft === 0;
  const isLive = state === 'OPEN' && !expired;

  async function placeBid(): Promise<void> {
    setBidError(null);
    const cents = parseDollarsToCents(bidInput);
    if (cents === null) {
      setBidError('Enter a positive amount like 5.00.');
      return;
    }
    if (cents < minNext) {
      setBidError(`Bid must be at least ${fmtUsd(minNext)}.`);
      return;
    }
    setBidBusy(true);
    try {
      const res = await fetch(`/api/auctions/${auctionId}/bid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bidCents: cents }),
      });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setBidError(j.message ?? `Bid failed (${res.status})`);
        return;
      }
      toast.success(`Bid placed — ${fmtUsd(cents)}`);
    } finally {
      setBidBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    setCancelError(null);
    setCancelBusy(true);
    try {
      const res = await fetch(`/api/auctions/${auctionId}/cancel`, { method: 'POST' });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setCancelError(j.message ?? `Cancel failed (${res.status})`);
        return;
      }
      router.replace('/collection');
      router.refresh();
    } finally {
      setCancelBusy(false);
    }
  }

  const youAreHigh = currentBid !== null && initialState.currentUserId === bidList[0]?.bidderId;
  const youWon =
    closedBanner?.state === 'SETTLED' &&
    closedBanner.winnerId === initialState.currentUserId;
  const youLost =
    closedBanner?.state === 'SETTLED' &&
    closedBanner.winnerId !== null &&
    closedBanner.winnerId !== initialState.currentUserId &&
    bidList.some((b) => b.bidderId === initialState.currentUserId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{card.name}</h1>
        <p className="text-sm text-zinc-500">
          {card.setName} · {card.rarity} · market{' '}
          <span className="font-mono">{fmtUsd(card.currentMarketPrice)}</span>
        </p>
        <p className="text-sm text-zinc-500">Listed by {sellerDisplayName}</p>
      </div>

      <div className="bg-white border border-zinc-200 rounded p-4 space-y-1">
        <p className="text-sm text-zinc-500">Current high bid</p>
        <p className="text-3xl font-mono">
          {currentBid !== null
            ? fmtUsd(currentBid)
            : `${fmtUsd(initialState.startingBid)} (start)`}
        </p>
        {currentBidDisplayName ? (
          <p className="text-xs text-zinc-500">by {currentBidDisplayName}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-white border border-zinc-200 rounded p-3">
          <p className="text-xs text-zinc-500">Time remaining</p>
          <p className="font-mono">{fmtCountdown(secsLeft)}</p>
        </div>
        <div className="bg-white border border-zinc-200 rounded p-3">
          <p className="text-xs text-zinc-500">Watchers</p>
          <p className="font-mono">{watchers}</p>
        </div>
      </div>

      {closedBanner ? (
        <div
          className={`rounded p-3 text-sm ${
            youWon
              ? 'bg-green-50 border border-green-300 text-green-900'
              : closedBanner.state === 'CLOSED'
                ? 'bg-zinc-100 border border-zinc-300 text-zinc-700'
                : 'bg-zinc-100 border border-zinc-300 text-zinc-700'
          }`}
        >
          {closedBanner.state === 'CLOSED'
            ? 'Auction ended with no bids.'
            : youWon
              ? `You won — paid ${fmtUsd(closedBanner.finalBid ?? 0)}.`
              : youLost
                ? `Sold to ${closedBanner.winnerDisplayName ?? 'another bidder'} for ${fmtUsd(closedBanner.finalBid ?? 0)}.`
                : `Sold for ${fmtUsd(closedBanner.finalBid ?? 0)}.`}
        </div>
      ) : null}

      {outbidAt !== null && isLive && !isSeller ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          ⚠ You&rsquo;ve been outbid — current high is{' '}
          <span className="font-mono">
            {currentBid !== null ? fmtUsd(currentBid) : '—'}
          </span>
          {currentBidDisplayName ? ` by ${currentBidDisplayName}` : null}.
        </div>
      ) : null}

      {isLive && !isSeller ? (
        <div className="space-y-2 bg-white border border-zinc-200 rounded p-4">
          <p className="text-sm font-medium">Place a bid</p>
          <p className="text-xs text-zinc-500">
            Minimum next bid <span className="font-mono">{fmtUsd(minNext)}</span>
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={bidInput}
              onChange={(e) => setBidInput(e.target.value)}
              className="flex-1 border border-zinc-300 rounded px-3 py-2 font-mono"
            />
            <button
              type="button"
              onClick={placeBid}
              disabled={bidBusy}
              className="bg-zinc-900 text-white rounded px-4 py-2 hover:bg-zinc-800 disabled:opacity-50"
            >
              {bidBusy ? 'Bidding…' : 'Bid'}
            </button>
          </div>
          {youAreHigh ? (
            <p className="text-xs text-green-700">You are the current high bidder.</p>
          ) : null}
          {bidError ? <p className="text-sm text-red-600">{bidError}</p> : null}
        </div>
      ) : null}

      {isLive && isSeller && currentBid === null ? (
        <div className="space-y-2 bg-white border border-zinc-200 rounded p-4">
          <p className="text-sm text-zinc-500">
            You can cancel this auction while no bids have been placed.
          </p>
          <button
            type="button"
            onClick={cancel}
            disabled={cancelBusy}
            className="bg-zinc-200 rounded px-4 py-2 hover:bg-zinc-300 disabled:opacity-50"
          >
            {cancelBusy ? 'Cancelling…' : 'Cancel auction'}
          </button>
          {cancelError ? <p className="text-sm text-red-600">{cancelError}</p> : null}
        </div>
      ) : null}

      {isLive && isSeller && currentBid !== null ? (
        <p className="text-sm text-zinc-500">
          Auction has bids and cannot be cancelled. It will settle automatically when the
          timer hits zero.
        </p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-700">Bid history</h2>
        {bidList.length === 0 ? (
          <p className="text-xs text-zinc-500">No bids yet. Be the first.</p>
        ) : (
          <ul className="text-sm divide-y divide-zinc-100 border border-zinc-200 rounded bg-white">
            {bidList.map((b) => (
              <li key={b.id} className="flex justify-between px-3 py-2">
                <span>{b.bidderDisplayName}</span>
                <span className="font-mono">{fmtUsd(b.amount)}</span>
                <span className="text-xs text-zinc-500">
                  {new Date(b.placedAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
