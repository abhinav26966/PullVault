'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import NavLink from '@/components/nav-link';
import { PackTile } from '@/components/pack-tile';
import { useChannel } from '@/hooks/use-socket';

type Tier = 'BRONZE' | 'SILVER' | 'GOLD';
type DropState = 'SCHEDULED' | 'OPEN' | 'SOLD_OUT' | 'CLOSED';

interface Props {
  id: string;
  tier: Tier;
  priceCents: number;
  initialState: DropState;
  initialInventoryRemaining: number;
  inventoryTotal: number;
  startsAtIso: string;
}

const TIER_BAR: Record<Tier, string> = {
  BRONZE: 'bg-amber-700',
  SILVER: 'bg-zinc-500',
  GOLD: 'bg-amber-500',
};

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatCountdown(secs: number): string {
  if (secs <= 0) return 'opening soon…';
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Client island per drop card. Subscribes to `drop:{id}` and replaces
 * the server-rendered inventory + state with live values whenever:
 *
 *   - the buy route publishes `{ inventoryRemaining, soldOut }` on commit
 *     (apps/web/app/api/drops/[id]/buy/route.ts step 8),
 *   - the drop-activator cron publishes `{ state: 'OPEN', inventoryRemaining,
 *     inventoryTotal }` when it flips a SCHEDULED drop to OPEN
 *     (apps/ws/src/jobs/drop-activator.ts).
 *
 * Implements the "Drops list subscribes to drop:{id} for each upcoming drop"
 * promise in ARCHITECTURE.md §7.1. Initial values come from the server's
 * SQL render, so the card has correct data on first paint; the WS layer
 * only delivers deltas while the connection is live (per §7.3 — on
 * reconnect we refetch via REST through the existing useChannel onReconnect).
 */
export default function DropCard({
  id,
  tier,
  priceCents,
  initialState,
  initialInventoryRemaining,
  inventoryTotal,
  startsAtIso,
}: Props) {
  const router = useRouter();
  const [state, setState] = useState<DropState>(initialState);
  const [remaining, setRemaining] = useState(initialInventoryRemaining);

  // Local clock for the SCHEDULED-state countdown. Null-initial pattern so
  // server SSR and client hydration produce identical DOM (no time-text
  // mismatch); the real Date.now() only kicks in after mount.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);

  useChannel(`drop:${id}`, {
    onEvent: (payload) => {
      if (typeof payload.inventoryRemaining === 'number') {
        setRemaining(payload.inventoryRemaining);
      }
      if (payload.soldOut === true) setState('SOLD_OUT');
      if (payload.state === 'OPEN') setState('OPEN');
    },
    onReconnect: () => router.refresh(),
  });

  const startsAtMs = new Date(startsAtIso).getTime();
  const secondsUntil =
    now === null ? null : Math.max(0, Math.ceil((startsAtMs - now) / 1000));

  const soldOut =
    state === 'SOLD_OUT' || (state === 'OPEN' && remaining === 0);
  const fillPercent =
    inventoryTotal > 0
      ? Math.round((remaining / inventoryTotal) * 100)
      : 0;

  // SCHEDULED + countdown reached zero, but no WS event from the activator
  // yet. The cron runs every 60s — show an optimistic "Opening soon…"
  // until either the activator fires (`state: 'OPEN'`) or the user refreshes.
  const scheduledText = (() => {
    if (secondsUntil === null) {
      // SSR + first hydration — render absolute date so server and client
      // produce identical text.
      return `Scheduled — opens ${new Date(startsAtIso).toLocaleString()}`;
    }
    if (secondsUntil === 0) return 'Opening soon…';
    return `Opens in ${formatCountdown(secondsUntil)}`;
  })();

  return (
    <li className="border border-zinc-200 bg-white rounded-lg transition-all duration-150 hover:border-zinc-400 hover:shadow-md">
      <NavLink href={`/drops/${id}`} className="block p-4">
        <div className="flex gap-4">
          <PackTile tier={tier} size="md" />
          <div className="flex-1 flex flex-col">
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-semibold">{tier}</h2>
              <span className="text-zinc-400 text-lg" aria-hidden>
                →
              </span>
            </div>
            <p className="font-mono text-lg mt-1">{fmtUsd(priceCents)}</p>
            {state === 'OPEN' ? (
              <p className="text-sm text-zinc-600 mt-2 tabular-nums">
                {soldOut ? (
                  <span className="text-zinc-400">Sold out</span>
                ) : (
                  `${remaining} of ${inventoryTotal} packs available`
                )}
              </p>
            ) : (
              <p className="text-sm text-zinc-600 mt-2">{scheduledText}</p>
            )}
          </div>
        </div>
        {state === 'OPEN' && !soldOut ? (
          <div className="mt-4 h-1.5 bg-zinc-200 rounded-full overflow-hidden">
            <div
              className={`h-full ${TIER_BAR[tier]} transition-all duration-300`}
              style={{ width: `${fillPercent}%` }}
            />
          </div>
        ) : null}
      </NavLink>
    </li>
  );
}
