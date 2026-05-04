import { and, count, eq, gt } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { db, packDrops } from '@pullvault/db';

/**
 * Self-throttling drop replenisher. Runs every 12 hours; if there are
 * fewer than REPLENISH_THRESHOLD OPEN drops with inventory remaining,
 * inserts 3 fresh SCHEDULED drops (BRONZE/SILVER/GOLD) staggered to
 * activate within the next ~15 minutes. The existing drop-activator
 * cron picks them up and flips them to OPEN at their starts_at.
 *
 * Purpose: keep the deployed demo browseable indefinitely. Reviewers
 * who visit after seed inventory has sold out should still see at
 * least one OPEN drop.
 *
 * Idempotency: the < THRESHOLD guard prevents runaway insertion. If
 * drops are already healthy, the cron tick is a no-op.
 *
 * Concurrency-test safety: each new drop still has finite inventory
 * (50/20/5 per the existing tier defaults). The D.1 race against the
 * last pack remains demonstrable on whichever drop the reviewer picks.
 */

const REPLENISH_THRESHOLD = 2;

async function runOnce(): Promise<void> {
  const [row] = await db
    .select({ value: count() })
    .from(packDrops)
    .where(
      and(
        eq(packDrops.state, 'OPEN'),
        gt(packDrops.inventoryRemaining, 0),
      ),
    );
  const openCount = Number(row?.value ?? 0);
  if (openCount >= REPLENISH_THRESHOLD) {
    return;
  }

  const now = new Date();
  const drops = [
    {
      tier: 'BRONZE' as const,
      priceCents: 499,
      inventoryTotal: 50,
      inventoryRemaining: 50,
      startsAt: new Date(now.getTime() + 1 * 60_000),
    },
    {
      tier: 'SILVER' as const,
      priceCents: 1499,
      inventoryTotal: 20,
      inventoryRemaining: 20,
      startsAt: new Date(now.getTime() + 5 * 60_000),
    },
    {
      tier: 'GOLD' as const,
      priceCents: 4999,
      inventoryTotal: 5,
      inventoryRemaining: 5,
      startsAt: new Date(now.getTime() + 15 * 60_000),
    },
  ];

  await db.insert(packDrops).values(drops);
  console.log(
    `[drop-replenisher] OPEN count was ${openCount} (< ${REPLENISH_THRESHOLD}); created 3 new SCHEDULED drops`,
  );
}

export function scheduleDropReplenisher(): ScheduledTask {
  return cron.schedule('0 */12 * * *', async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[drop-replenisher] tick failed', err);
    }
  });
}

export async function runDropReplenisherNow(): Promise<void> {
  await runOnce();
}
