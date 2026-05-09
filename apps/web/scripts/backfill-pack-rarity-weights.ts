import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

/**
 * Backfill packs.rarity_weights — Part B §9.
 *
 * Existing pre-Part-B packs were created without a rarity_weights snapshot.
 * Pack-roller falls back to TIER_CONFIG when null, so existing rips still
 * work, but the column needs to be NOT NULL going forward (next migration).
 *
 * For each pack with rarity_weights IS NULL, write the static aspirational
 * weights from TIER_CONFIG[pack.tier] — i.e. the same weights pack-roller
 * was already using for these packs implicitly. This makes the snapshot
 * faithful to the actual pre-Part-B behavior.
 *
 * Idempotent: WHERE clause filters NULLs only, so re-running after a partial
 * failure picks up where it left off.
 */
async function main() {
  const { eq, isNull } = await import('drizzle-orm');
  const { db, packs, queryClient } = await import('@pullvault/db');
  const { TIER_CONFIG } = await import('@pullvault/domain');

  const missing = await db
    .select({ id: packs.id, tier: packs.tier })
    .from(packs)
    .where(isNull(packs.rarityWeights));

  console.log(`[backfill-pack-weights] found ${missing.length} packs missing rarity_weights`);

  let updated = 0;
  for (const pack of missing) {
    const slots = TIER_CONFIG[pack.tier].slots.map((s) => ({
      type: s.type,
      count: s.count,
      weights: { ...s.weights },
    }));
    await db
      .update(packs)
      .set({ rarityWeights: { slots, trigger: 'backfill' } })
      .where(eq(packs.id, pack.id));
    updated++;
  }

  // Final count for self-verification.
  const remaining = await db
    .select({ id: packs.id })
    .from(packs)
    .where(isNull(packs.rarityWeights));

  console.log(`[backfill-pack-weights] updated=${updated} remaining_null=${remaining.length}`);
  await queryClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
