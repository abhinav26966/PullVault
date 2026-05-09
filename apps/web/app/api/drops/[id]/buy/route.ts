import { NextResponse } from 'next/server';
import { and, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import {
  cardPrices,
  db,
  packCards,
  packDrops,
  packEconomicsSnapshots,
  packs,
  walletLedger,
  wallets,
} from '@pullvault/db';
import {
  TIER_CONFIG,
  rollPack,
  type SlotWeights,
  type Tier,
} from '@pullvault/domain';
import { withErrors } from '@/lib/api-handler';
import { loadCardPool } from '@/lib/card-pool';
import {
  DropNotOpenError,
  InsufficientFundsError,
  SoldOutError,
} from '@/lib/errors';
import { withRateLimit } from '@/lib/rate-limit/middleware';
import { publish } from '@/lib/redis-publish';
import { requireAuth } from '@/lib/require-auth';

interface ActiveSnapshotJson {
  readonly slots: readonly SlotWeights[];
}

function defaultSlotsFor(tier: Tier): SlotWeights[] {
  return TIER_CONFIG[tier].slots.map((s) => ({
    type: s.type,
    count: s.count,
    weights: { ...s.weights },
  }));
}

export const dynamic = 'force-dynamic';

/**
 * Atomic pack purchase — implements ARCHITECTURE §6.1 verbatim.
 *
 * Order of operations (matters):
 *   1.  Atomic conditional UPDATE on inventory (decrement, check rowcount).
 *   1b. Read active rarity-weights snapshot for the tier (Part B §9).
 *   2.  Atomic conditional UPDATE on wallet (debit, check rowcount).
 *   3.  Roll cards via @pullvault/domain rollPack with the snapshot slots.
 *   4.  Snapshot pack EV (sum of rolled cards' current prices).
 *   5.  Insert packs row, including rarity_weights snapshot.
 *   6.  Insert pack_cards rows (positions 0..N, sorted commons-first by roller).
 *   7.  Insert wallet_ledger PACK_PURCHASE row.
 *   8.  If inventory hit 0, mark drop SOLD_OUT.
 *   9.  After commit: publish drop:{id} delta to Redis (stub for Phase 5).
 *
 * D.1 (canonical race for last pack) and D.2 (same-user rapid-fire with
 * insufficient funds) are gated by the rowcount checks in steps 1 and 2.
 */
export const POST = withErrors<{ id: string }>(
  withRateLimit<{ id: string }>(
    {
      endpoint: 'buy_drop',
      user: { limit: 5, windowMs: 60_000 },
      ip: { limit: 20, windowMs: 60_000 },
    },
    async (_req, ctx) => {
  const user = await requireAuth();
  const dropId = ctx.params.id;

  // Pre-load card pool outside the transaction so rollPack has it ready.
  // First call queries; subsequent calls hit the in-memory cache.
  const cardPool = await loadCardPool();

  const result = await db.transaction(async (tx) => {
    // ── 1. Atomically decrement inventory. Returns the new value or 0 rows. ──
    const decremented = await tx
      .update(packDrops)
      .set({ inventoryRemaining: sql`${packDrops.inventoryRemaining} - 1` })
      .where(
        and(
          eq(packDrops.id, dropId),
          gt(packDrops.inventoryRemaining, 0),
          eq(packDrops.state, 'OPEN'),
        ),
      )
      .returning({
        remaining: packDrops.inventoryRemaining,
        tier: packDrops.tier,
        priceCents: packDrops.priceCents,
      });

    if (decremented.length === 0) {
      // Either the drop is sold out, not open, or doesn't exist. Disambiguate
      // for a useful error code, but only as a one-shot read — the rowcount
      // is what matters for correctness. Order: SOLD_OUT before DROP_NOT_OPEN
      // because the inventory race winner will have flipped state to
      // SOLD_OUT by the time the loser's tx runs this check.
      const [existing] = await tx
        .select({ state: packDrops.state, remaining: packDrops.inventoryRemaining })
        .from(packDrops)
        .where(eq(packDrops.id, dropId))
        .limit(1);
      if (!existing) throw new DropNotOpenError();
      if (existing.state === 'SOLD_OUT' || existing.remaining === 0) {
        throw new SoldOutError();
      }
      throw new DropNotOpenError();
    }

    const drop = decremented[0]!;

    // ── 1b. Snapshot active rarity weights for this tier (Part B §9). ──
    // Read inside the tx so the snapshot used for rolling is the same row
    // we'll persist onto packs.rarity_weights. Existing in-flight packs
    // remain immune to a recompute that lands between this buy's atomic
    // UPDATE and the pack insert — the per-pack snapshot is the source
    // of truth at rip time.
    const [activeSnap] = await tx
      .select({ weights: packEconomicsSnapshots.weights })
      .from(packEconomicsSnapshots)
      .where(
        and(
          eq(packEconomicsSnapshots.tier, drop.tier),
          eq(packEconomicsSnapshots.isActive, true),
        ),
      )
      .limit(1);

    const snapshotJson = (activeSnap?.weights ?? null) as ActiveSnapshotJson | null;
    const slots: readonly SlotWeights[] =
      snapshotJson?.slots && Array.isArray(snapshotJson.slots) && snapshotJson.slots.length > 0
        ? snapshotJson.slots.map((s) => ({
            type: s.type,
            count: s.count,
            weights: { ...s.weights },
          }))
        : defaultSlotsFor(drop.tier);

    // ── 2. Atomically debit the wallet. ──
    const debited = await tx
      .update(wallets)
      .set({
        balanceAvailable: sql`${wallets.balanceAvailable} - ${drop.priceCents}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(wallets.userId, user.id),
          gte(wallets.balanceAvailable, drop.priceCents),
        ),
      )
      .returning({ available: wallets.balanceAvailable });

    if (debited.length === 0) throw new InsufficientFundsError();

    // ── 3. Roll cards (pure function, no I/O). Use the per-pack snapshot. ──
    const rolled = rollPack(drop.tier, cardPool, undefined, slots);

    // ── 4. Snapshot pack EV: sum of rolled cards' current prices. ──
    // This is what powers the realized-margin metric in the economics
    // dashboard (Phase 12) — pack_revenue minus pack_ev_at_purchase grouped
    // by tier. Constant per-tier EV would make the metric trivial.
    const cardIds = rolled.map((c) => c.cardId);
    const priceRows = await tx
      .select({ id: cardPrices.cardId, price: cardPrices.price })
      .from(cardPrices)
      .where(inArray(cardPrices.cardId, cardIds));
    const priceMap = new Map(priceRows.map((p) => [p.id, p.price]));
    const packEvAtPurchase = rolled.reduce(
      (sum, c) => sum + (priceMap.get(c.cardId) ?? 0),
      0,
    );

    // ── 5. Insert packs row, including the rarity-weights snapshot. ──
    const [pack] = await tx
      .insert(packs)
      .values({
        ownerId: user.id,
        dropId,
        tier: drop.tier,
        pricePaid: drop.priceCents,
        packEvAtPurchase,
        rarityWeights: { slots },
      })
      .returning({ id: packs.id });
    if (!pack) throw new Error('pack insert returned no row');

    // ── 6. Insert pack_cards (already sorted commons-first by rollPack). ──
    await tx.insert(packCards).values(
      rolled.map((c, i) => ({
        packId: pack.id,
        cardId: c.cardId,
        position: i,
        slotType: c.slotType,
        rarityAtPull: c.rarity,
      })),
    );

    // ── 7. Wallet ledger entry (debit). ──
    await tx.insert(walletLedger).values({
      userId: user.id,
      type: 'PACK_PURCHASE',
      amount: -drop.priceCents,
      packId: pack.id,
    });

    // ── 8. Mark drop SOLD_OUT if inventory hit 0. ──
    if (drop.remaining === 0) {
      await tx
        .update(packDrops)
        .set({ state: 'SOLD_OUT' })
        .where(eq(packDrops.id, dropId));
    }

    return { packId: pack.id, remaining: drop.remaining, tier: drop.tier };
  });

  // ── 9. Publish AFTER commit. ──
  await publish(`drop:${dropId}`, {
    inventoryRemaining: result.remaining,
    soldOut: result.remaining === 0,
  });

  return NextResponse.json({ packId: result.packId }, { status: 201 });
    },
  ),
);
