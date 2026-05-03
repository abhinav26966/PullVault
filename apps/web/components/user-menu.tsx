'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  displayName: string;
  email: string;
  createdAtIso: string;
  balanceAvailable: number;
  balanceHeld: number;
}

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
  displayName,
  email,
  createdAtIso,
  balanceAvailable,
  balanceHeld,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

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
