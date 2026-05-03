import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

async function main() {
  const { db, packDrops } = await import('@pullvault/db');
  const { and, eq, lte } = await import('drizzle-orm');

  const now = new Date();
  const flipped = await db
    .update(packDrops)
    .set({ state: 'OPEN' })
    .where(and(eq(packDrops.state, 'SCHEDULED'), lte(packDrops.startsAt, now)))
    .returning({ id: packDrops.id, tier: packDrops.tier, startsAt: packDrops.startsAt });

  if (flipped.length === 0) {
    console.log('[activator] no SCHEDULED drops past their starts_at');
  } else {
    for (const d of flipped) console.log(`[activator] OPENED ${d.tier} ${d.id} (started ${d.startsAt.toISOString()})`);
  }

  // Phase 5 ad-hoc: postgres-js connection — close it so the script exits.
  const { queryClient } = await import('@pullvault/db');
  await queryClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
