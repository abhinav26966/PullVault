import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

/**
 * Inserts one BRONZE drop with inventory_total=1 in the OPEN state, ready
 * for the D.1 race test. Idempotent in spirit: if you re-run, it creates
 * another such drop. That's the desired behavior — every D.1 run wants a
 * fresh inventory=1 target.
 */
async function main() {
  const { db, packDrops, queryClient } = await import('@pullvault/db');

  const [created] = await db
    .insert(packDrops)
    .values({
      tier: 'BRONZE',
      priceCents: 499,
      inventoryTotal: 1,
      inventoryRemaining: 1,
      startsAt: new Date(Date.now() - 1000), // already started
      state: 'OPEN',
    })
    .returning({ id: packDrops.id });

  console.log(`[seed-test-drop] OPENED inventory=1 BRONZE drop: ${created!.id}`);
  await queryClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
