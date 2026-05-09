import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

/**
 * One-shot seed for pack_economics_snapshots — Part B §9.
 *
 * Creates one is_active=true row per tier (BRONZE / SILVER / GOLD) using the
 * static aspirational weights from TIER_CONFIG, EV computed against current
 * card_prices averages, and win_rate from a 10K-pack Monte Carlo.
 *
 * Idempotent: skips any tier that already has an is_active=true row, so
 * re-running after a partial failure or after recompute has populated some
 * tiers is safe.
 *
 * Notes column is set to 'initial seed from tier_config' so the dashboard
 * can distinguish bootstrap rows from solver-driven recompute rows.
 */
async function main() {
  const { and, eq, sql } = await import('drizzle-orm');
  const {
    cardPrices,
    cards,
    db,
    packEconomicsSnapshots,
    queryClient,
  } = await import('@pullvault/db');
  const { TIER_CONFIG, computeTierEV, simulate } = await import('@pullvault/domain');

  const TIERS = ['BRONZE', 'SILVER', 'GOLD'] as const;
  const TARGET_MARGIN = 0.3;
  const SIM_N = 10_000;
  const SIM_SEED = 0xb15eed;

  // Read rarity-mean-cents from card_prices (same query the recompute uses).
  const rows = await db
    .select({
      rarity: cards.rarity,
      meanPrice: sql<string>`AVG(${cardPrices.price})`,
    })
    .from(cards)
    .innerJoin(cardPrices, eq(cardPrices.cardId, cards.id))
    .groupBy(cards.rarity);

  const rarityMeanCents = { C: 0, U: 0, R: 0, E: 0, L: 0 };
  for (const r of rows) {
    const v = Number(r.meanPrice ?? 0);
    if (Number.isFinite(v)) rarityMeanCents[r.rarity as 'C'|'U'|'R'|'E'|'L'] = v;
  }
  console.log('[seed-economics] rarity means (cents):', rarityMeanCents);

  let inserted = 0;
  let skipped = 0;

  for (const tier of TIERS) {
    const cfg = TIER_CONFIG[tier];
    const slots = cfg.slots.map((s) => ({
      type: s.type,
      count: s.count,
      weights: { ...s.weights },
    }));

    const existing = await db
      .select({ id: packEconomicsSnapshots.id })
      .from(packEconomicsSnapshots)
      .where(
        and(
          eq(packEconomicsSnapshots.tier, tier),
          eq(packEconomicsSnapshots.isActive, true),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      console.log(`[seed-economics] ${tier}: active snapshot already exists, skipping`);
      skipped++;
      continue;
    }

    const ev = computeTierEV(tier, rarityMeanCents);
    const sim = simulate({
      slots,
      priceCents: cfg.priceCents,
      rarityMeanCents,
      n: SIM_N,
      seed: SIM_SEED,
    });

    await db.insert(packEconomicsSnapshots).values({
      tier,
      weights: { slots, trigger: 'initial-seed' },
      targetMargin: TARGET_MARGIN.toFixed(4),
      evCents: ev.evCents,
      winRate: sim.winRate.toFixed(4),
      isActive: true,
      notes: 'initial seed from tier_config',
    });
    inserted++;
    console.log(
      `[seed-economics] ${tier}: seeded ev=${ev.evCents}c (${(ev.marginPercent * 100).toFixed(1)}% margin) winRate=${(sim.winRate * 100).toFixed(1)}%`,
    );
  }

  console.log(`[seed-economics] done — inserted=${inserted} skipped=${skipped}`);
  await queryClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
