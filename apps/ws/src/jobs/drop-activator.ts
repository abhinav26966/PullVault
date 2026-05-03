import { and, eq, lte } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { db, packDrops } from '@pullvault/db';
import { publisher } from '../redis';

async function runOnce(): Promise<void> {
  const now = new Date();
  const flipped = await db
    .update(packDrops)
    .set({ state: 'OPEN' })
    .where(and(eq(packDrops.state, 'SCHEDULED'), lte(packDrops.startsAt, now)))
    .returning({
      id: packDrops.id,
      tier: packDrops.tier,
      inventoryRemaining: packDrops.inventoryRemaining,
      inventoryTotal: packDrops.inventoryTotal,
    });

  if (flipped.length === 0) return;

  for (const d of flipped) {
    console.log(`[drop-activator] OPENED ${d.tier} ${d.id}`);
    await publisher.publish(
      `drop:${d.id}`,
      JSON.stringify({
        state: 'OPEN',
        inventoryRemaining: d.inventoryRemaining,
        inventoryTotal: d.inventoryTotal,
      }),
    );
  }
}

export function scheduleDropActivator(): ScheduledTask {
  return cron.schedule('* * * * *', async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[drop-activator] tick failed', err);
    }
  });
}

export async function runDropActivatorNow(): Promise<void> {
  await runOnce();
}
