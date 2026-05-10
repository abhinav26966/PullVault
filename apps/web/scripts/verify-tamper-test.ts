// dotenv is loaded via `tsx -r dotenv/config` from the package.json script.

/**
 * Reviewer test: "Buy a pack, navigate to /verify/[packId], all slots green;
 * tamper packs.server_seed, refresh, page flips to MISMATCH."
 *
 * Direct-DB analogue of the manual flow used in B2's lottery test and B3's
 * sealed-bid test. Picks the most recent provably-fair pack, runs the same
 * sampler the verify page uses, asserts every slot matches; then writes a
 * tampered server_seed, re-runs, asserts SHA-256 mismatch; finally restores
 * the seed so the production state is unchanged.
 *
 * Run: pnpm -F @pullvault/web verify-tamper-test
 */

import { randomUUID } from 'node:crypto';
import { and, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  cardPrices,
  cards,
  db,
  packCards,
  packDrops,
  packEconomicsSnapshots,
  packs,
  walletLedger,
  wallets,
} from '@pullvault/db';
import {
  rollPackHmac,
  samplePack,
  sha256Hex,
  TIER_CONFIG,
  type PfPoolEntry,
  type PfSlotConfig,
  type Rarity,
  type SlotWeights,
  type Tier,
} from '@pullvault/domain';

interface VerifyOutcome {
  commitOk: boolean;
  allSlotsMatch: boolean;
  computedCommit: string;
  expectedCommit: string;
  perSlot: Array<{
    slotIndex: number;
    expectedCardId: string;
    revealedCardId: string;
    matches: boolean;
  }>;
}

async function verifyPackById(packId: string): Promise<VerifyOutcome> {
  const [pack] = await db.select().from(packs).where(eq(packs.id, packId)).limit(1);
  if (!pack) throw new Error(`pack ${packId} not found`);
  if (
    !pack.serverSeed ||
    !pack.serverSeedCommit ||
    !pack.clientSeed ||
    !pack.eligibleCardIds
  ) {
    throw new Error(`pack ${packId} is pre-PF — cannot verify`);
  }

  const computedCommit = await sha256Hex(pack.serverSeed);
  const commitOk = computedCommit === pack.serverSeedCommit;

  // Build the eligibility set with rarities.
  const cardRows = await db
    .select({ id: cards.id, rarity: cards.rarity })
    .from(cards)
    .where(inArray(cards.id, pack.eligibleCardIds));
  const pool: PfPoolEntry[] = cardRows.map((c) => ({ id: c.id, rarity: c.rarity }));

  const json = pack.rarityWeights as {
    slots: Array<{ count: number; weights: Record<Rarity, number> }>;
  };
  const slots: PfSlotConfig[] = json.slots.map((s) => ({
    count: s.count,
    weights: s.weights,
  }));

  const sampled = await samplePack({
    serverSeed: pack.serverSeed,
    clientSeed: pack.clientSeed,
    packId: pack.id,
    slots,
    pool,
  });

  const revealed = await db
    .select({ position: packCards.position, cardId: packCards.cardId })
    .from(packCards)
    .where(eq(packCards.packId, packId))
    .orderBy(packCards.position);

  const perSlot = sampled.map((s) => {
    const r = revealed.find((x) => x.position === s.slotIndex);
    return {
      slotIndex: s.slotIndex,
      expectedCardId: s.cardId,
      revealedCardId: r?.cardId ?? '<none>',
      matches: r?.cardId === s.cardId,
    };
  });
  const allSlotsMatch = perSlot.every((s) => s.matches);

  return {
    commitOk,
    allSlotsMatch,
    computedCommit,
    expectedCommit: pack.serverSeedCommit,
    perSlot,
  };
}

/**
 * Mint a fresh PF-equipped pack inline. Mirrors the buy route's transaction
 * body verbatim so the integration test exercises the production code path.
 * If a PF pack already exists, return it instead.
 */
async function mintTestPack(): Promise<string> {
  const [existing] = await db
    .select({ id: packs.id })
    .from(packs)
    .where(isNotNull(packs.serverSeed))
    .orderBy(packs.purchasedAt)
    .limit(1);
  if (existing) return existing.id;

  // Pick a user with funds.
  const [user] = await db
    .select({ id: wallets.userId, balance: wallets.balanceAvailable })
    .from(wallets)
    .where(gte(wallets.balanceAvailable, 5000))
    .limit(1);
  if (!user) throw new Error('mintTestPack: no user with ≥ 50.00 balance');

  // Pick an OPEN drop.
  const [drop] = await db
    .select({
      id: packDrops.id,
      tier: packDrops.tier,
      priceCents: packDrops.priceCents,
    })
    .from(packDrops)
    .where(and(eq(packDrops.state, 'OPEN'), gt(packDrops.inventoryRemaining, 0)))
    .limit(1);
  if (!drop) throw new Error('mintTestPack: no OPEN drop with inventory');

  const cardPool = await db
    .select({ id: cards.id, rarity: cards.rarity })
    .from(cards);

  const clientSeed = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');

  return db.transaction(async (tx) => {
    // 1. Atomic decrement.
    const dec = await tx
      .update(packDrops)
      .set({ inventoryRemaining: sql`${packDrops.inventoryRemaining} - 1` })
      .where(
        and(
          eq(packDrops.id, drop.id),
          gt(packDrops.inventoryRemaining, 0),
          eq(packDrops.state, 'OPEN'),
        ),
      )
      .returning({ remaining: packDrops.inventoryRemaining });
    if (dec.length === 0) throw new Error('mintTestPack: lost inventory race');

    // 1b. Active snapshot or fall back to TIER_CONFIG.
    const [snap] = await tx
      .select({ weights: packEconomicsSnapshots.weights })
      .from(packEconomicsSnapshots)
      .where(
        and(
          eq(packEconomicsSnapshots.tier, drop.tier),
          eq(packEconomicsSnapshots.isActive, true),
        ),
      )
      .limit(1);
    const tier = drop.tier as Tier;
    const slots: SlotWeights[] = ((snap?.weights as { slots?: SlotWeights[] } | null)?.slots ??
      TIER_CONFIG[tier].slots.map((s) => ({
        type: s.type,
        count: s.count,
        weights: { ...s.weights },
      }))) as SlotWeights[];

    // 2. Wallet debit.
    const debited = await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} - ${drop.priceCents}`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(wallets.userId, user.id), gte(wallets.balanceAvailable, drop.priceCents)),
      )
      .returning({ available: wallets.balanceAvailable });
    if (debited.length === 0) throw new Error('mintTestPack: insufficient funds');

    // 2b. Consume seed (FK backfilled after the pack insert).
    const packId = randomUUID();
    const consumed = await tx.execute<{
      id: string;
      commit: string;
      server_seed: string;
    }>(sql`
      UPDATE seed_pool
      SET used = true, used_at = now()
      WHERE id = (
        SELECT id FROM seed_pool WHERE used = false
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id, commit, server_seed
    `);
    if (!consumed[0]) throw new Error('mintTestPack: seed pool empty');
    const { id: seedPoolId, commit, server_seed: serverSeed } = consumed[0];

    // 3. Roll cards via HMAC.
    const rolled = await rollPackHmac({
      tier,
      pool: cardPool,
      serverSeed,
      clientSeed,
      packId,
      slots,
    });

    // 4. Pack EV.
    const cardIds = rolled.map((c) => c.cardId);
    const priceRows = await tx
      .select({ id: cardPrices.cardId, price: cardPrices.price })
      .from(cardPrices)
      .where(inArray(cardPrices.cardId, cardIds));
    const priceMap = new Map(priceRows.map((p) => [p.id, p.price]));
    const packEvAtPurchase = rolled.reduce(
      (s, c) => s + (priceMap.get(c.cardId) ?? 0),
      0,
    );

    const eligibleCardIds = cardPool.map((c) => c.id).slice().sort();

    // 5. Insert pack.
    await tx.insert(packs).values({
      id: packId,
      ownerId: user.id,
      dropId: drop.id,
      tier,
      pricePaid: drop.priceCents,
      packEvAtPurchase,
      rarityWeights: { slots },
      serverSeedCommit: commit,
      serverSeed,
      clientSeed,
      eligibleCardIds,
    });

    // 5b. Backfill seed_pool → packs FK.
    await tx.execute(sql`
      UPDATE seed_pool SET used_for_pack_id = ${packId}::uuid WHERE id = ${seedPoolId}::uuid
    `);

    // 6. Pack cards.
    await tx.insert(packCards).values(
      rolled.map((c, i) => ({
        packId,
        cardId: c.cardId,
        position: i,
        slotType: c.slotType,
        rarityAtPull: c.rarity,
      })),
    );

    // 7. Ledger.
    await tx.insert(walletLedger).values({
      userId: user.id,
      type: 'PACK_PURCHASE',
      amount: -drop.priceCents,
      packId,
    });

    return packId;
  });
}

async function main(): Promise<void> {
  const targetId = await mintTestPack();
  console.log(`[verify-tamper-test] using pack ${targetId}`);
  const target = { id: targetId };

  // Step 1: clean verify must succeed.
  const clean = await verifyPackById(target.id);
  console.log(
    `  clean: commitOk=${clean.commitOk} allSlotsMatch=${clean.allSlotsMatch}`,
  );
  if (!clean.commitOk || !clean.allSlotsMatch) {
    console.error('[verify-tamper-test] FAIL: clean verify did not pass.');
    if (!clean.commitOk) {
      console.error(
        `    commit mismatch: computed=${clean.computedCommit} expected=${clean.expectedCommit}`,
      );
    }
    for (const s of clean.perSlot.filter((x) => !x.matches)) {
      console.error(
        `    slot ${s.slotIndex}: expected=${s.expectedCardId} revealed=${s.revealedCardId}`,
      );
    }
    process.exit(1);
  }

  // Step 2: tamper. Snapshot the original seed first so we can restore.
  const [original] = await db
    .select({ serverSeed: packs.serverSeed })
    .from(packs)
    .where(eq(packs.id, target.id))
    .limit(1);
  if (!original?.serverSeed) {
    console.error('[verify-tamper-test] FAIL: lost original seed mid-test');
    process.exit(1);
  }

  const tamperedSeed =
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  await db
    .update(packs)
    .set({ serverSeed: tamperedSeed })
    .where(eq(packs.id, target.id));

  // Step 3: tampered verify must flip to MISMATCH.
  const tampered = await verifyPackById(target.id);
  console.log(
    `  tampered: commitOk=${tampered.commitOk} allSlotsMatch=${tampered.allSlotsMatch}`,
  );

  // Step 4: restore the original seed so production state is intact.
  await db
    .update(packs)
    .set({ serverSeed: original.serverSeed })
    .where(eq(packs.id, target.id));

  // Step 5: re-verify after restore — should be back to green.
  const restored = await verifyPackById(target.id);
  console.log(
    `  restored: commitOk=${restored.commitOk} allSlotsMatch=${restored.allSlotsMatch}`,
  );

  const ok =
    clean.commitOk &&
    clean.allSlotsMatch &&
    !tampered.commitOk &&
    restored.commitOk &&
    restored.allSlotsMatch;

  console.log(`[verify-tamper-test] ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify-tamper-test] error', err);
  process.exit(1);
});
