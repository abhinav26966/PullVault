'use client';

import { useEffect, useRef, useState } from 'react';
import { useChannel } from '@/hooks/use-socket';

interface Props {
  userId: string;
  displayName: string;
  email: string;
  createdAtIso: string;
  balanceAvailable: number;
  balanceHeld: number;
}

const WALLET_REFETCH_EVENTS = new Set([
  'card_sold',
  'card_bought',
  'auction_won',
  'auction_sold',
  'outbid',
]);

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Header user-info trigger + popover. The wallet line stays visible inline
 * (matches the previous header behavior); clicking the displayName button
 * opens a popover with email + member-since + balance breakdown. Closes on
 * outside click or Escape.
 */
export default function UserMenu({
  userId,
  displayName,
  email,
  createdAtIso,
  balanceAvailable: initialAvailable,
  balanceHeld: initialHeld,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Header balance is reactive to its own WS subscription rather than
  // depending on the (app) layout's RSC re-render via router.refresh(). The
  // layout-level subscriber's callback occasionally fails to fire (HMR /
  // Strict-Mode double-mount tangling the listener) — making this component
  // self-sufficient is the bulletproof path.
  const [balanceAvailable, setBalanceAvailable] = useState(initialAvailable);
  const [balanceHeld, setBalanceHeld] = useState(initialHeld);

  // Sync if the layout re-renders with fresh SSR values (e.g., on navigation
  // back to a route after a page-level wallet change).
  useEffect(() => {
    setBalanceAvailable(initialAvailable);
  }, [initialAvailable]);
  useEffect(() => {
    setBalanceHeld(initialHeld);
  }, [initialHeld]);

  async function refetchWallet(): Promise<void> {
    try {
      const res = await fetch('/api/wallet', { credentials: 'same-origin' });
      if (!res.ok) return;
      const j = (await res.json()) as { available?: unknown; held?: unknown };
      if (typeof j.available === 'number') setBalanceAvailable(j.available);
      if (typeof j.held === 'number') setBalanceHeld(j.held);
    } catch {
      // Stay on last known good values; next event or page nav will resync.
    }
  }

  useChannel(`user:${userId}`, {
    onEvent: (payload) => {
      const ev = (payload as { event?: string }).event;
      if (typeof ev === 'string' && WALLET_REFETCH_EVENTS.has(ev)) {
        void refetchWallet();
      }
    },
    onReconnect: () => {
      void refetchWallet();
    },
  });

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent): void {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const joined = new Date(createdAtIso);
  const joinedLabel = joined.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-zinc-700 hover:text-zinc-900 transition-colors"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {displayName} ·{' '}
        <span className="font-mono">{fmtUsd(balanceAvailable)}</span>
        {balanceHeld > 0 ? (
          <span className="text-zinc-500"> · in auctions {fmtUsd(balanceHeld)}</span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          className="absolute right-0 mt-2 w-72 bg-white border border-zinc-200 rounded-md shadow-lg p-4 space-y-3 z-50"
        >
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Display name
            </p>
            <p className="text-sm font-medium">{displayName}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500">Email</p>
            <p className="text-sm font-mono break-all">{email}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-500">Joined</p>
            <p className="text-sm">{joinedLabel}</p>
          </div>
          <div className="pt-3 border-t border-zinc-100 space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                Available
              </span>
              <span className="text-sm font-mono">
                {fmtUsd(balanceAvailable)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                In auctions
              </span>
              <span className="text-sm font-mono">{fmtUsd(balanceHeld)}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
