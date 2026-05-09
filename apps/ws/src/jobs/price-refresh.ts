import cron, { type ScheduledTask } from 'node-cron';
import { recomputeAllTiers, runPipeline } from '@pullvault/db';
import { publisher } from '../redis';

const intervalHours = Math.max(
  1,
  Math.floor(Number(process.env.PRICE_REFRESH_INTERVAL_HOURS ?? 1)),
);

const autoRecompute = process.env.ECONOMICS_AUTO_RECOMPUTE === '1';

async function runOnce(): Promise<void> {
  const result = await runPipeline();
  if (result.changed.length === 0) return;

  // Wire-format contract for `prices:global`: the Phase 6 pubsub bridge in
  // apps/ws/src/pubsub.ts spreads the parsed payload into the Socket.io
  // event envelope. Phase 8's collection-client (apps/web/app/(app)/collection/
  // collection-client.tsx) reads `payload.prices` as an Array<{cardId, price}>
  // through the `isPriceUpdate` runtime guard. We MUST publish an object,
  // never a raw array — ARCHITECTURE §9.7's `JSON.stringify(changed)` sketch
  // would arrive at the client as `{ '0': {...}, '1': {...} }` after the
  // bridge spread and silently no-op the typeguard.
  await publisher.publish(
    'prices:global',
    JSON.stringify({ prices: result.changed }),
  );
  console.log(
    `[price-refresh] broadcast ${result.changed.length} price update(s)`,
  );

  // Part B §9: auto-recompute pack-economics weights after prices change.
  // Gated by ECONOMICS_AUTO_RECOMPUTE=1 so reviewers/admins can keep manual
  // control during a demo. Failure here must not abort the price-refresh
  // tick — the price broadcast above is the more user-visible action.
  if (!autoRecompute) return;
  try {
    const out = await recomputeAllTiers({ trigger: 'price-refresh-cron' });
    const summary = out.outcomes
      .map((o) => `${o.tier}=${o.status}(${o.evCents}c)`)
      .join(' ');
    console.log(`[price-refresh] economics recompute: ${summary}`);
  } catch (err) {
    console.error('[price-refresh] economics recompute failed', err);
  }
}

export function schedulePriceRefresh(): ScheduledTask {
  // node-cron 5-field syntax: minute 0 of every Nth hour. Default N=1 (hourly).
  const cronExpr = `0 */${intervalHours} * * *`;
  return cron.schedule(cronExpr, async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[price-refresh] tick failed', err);
    }
  });
}

export async function runPriceRefreshNow(): Promise<void> {
  await runOnce();
}
