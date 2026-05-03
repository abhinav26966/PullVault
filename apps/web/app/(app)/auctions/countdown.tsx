'use client';

import { useEffect, useState } from 'react';

function format(secs: number): string {
  if (secs <= 0) return 'ended';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function AuctionsCountdown({ endsAtIso }: { endsAtIso: string }) {
  const endsAt = new Date(endsAtIso).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return (
    <p className="text-xs text-zinc-500 font-mono">ends in {format(secs)}</p>
  );
}
