import { randomUUID } from 'node:crypto';
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
  rollPackHmac,
  type SlotWeights,
  type Tier,
} from '@pullvault/domain';
import { z } from 'zod';
import { withErrors } from '@/lib/api-handler';
import { loadCardPool } from '@/lib/card-pool';
import {
  DropNotOpenError,
  InsufficientFundsError,
  SoldOutError,
} from '@/lib/errors';
import {
  enqueueIntent,
  pushInteractionSignature,
} from '@/lib/lottery/intent-store';
import { withRateLimit } from '@/lib/rate-limit/middleware';
import { publish } from '@/lib/redis-publish';
import { requireAuth } from '@/lib/require-auth';
import { consumeSeed } from '@/lib/seed-pool';

const LOTTERY_WINDOW_MS = Number(process.env.LOTTERY_WINDOW_MS ?? 5_000);

const InteractionSig = z.object({
  mouseEvents: z.number().int().min(0).max(10_000),
  keyEvents: z.number().int().min(0).max(10_000),
});

// Provably-fair client seed contribution (Part B §12). 32–128 hex chars; the
// browser default is 64 random hex (32 bytes via crypto.getRandomValues), but
// the user can override via the buy UI's "custom seed" input.
const ClientSeedSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{32,128}$/u, 'client_seed must be 32–128 hex chars');

const BuyBody = z.object({
  interaction_signature: InteractionSig.optional(),
  client_seed: ClientSeedSchema.optional(),
});

function generateRandomClientSeed(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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
    async (req, ctx) => {
  const user = await requireAuth();
  const dropId = ctx.params.id;

  // Parse body opportunistically — old clients may send empty body. The
  // interaction_signature is optional and best-effort recorded for the
  // bot-scoring cron's signal #6 (mouse/key event presence).
  let body: z.infer<typeof BuyBody> = {};
  try {
    const raw = await req.json();
    body = BuyBody.parse(raw);
  } catch {
    body = {};
  }
  if (body.interaction_signature) {
    pushInteractionSignature(user.id, body.interaction_signature).catch((err) =>
      console.error('[drop-buy] interaction-signature push failed', err),
    );
  }

  // Resolve the client seed once per request. If the user's body did not
  // include one (older clients), generate a random hex so the verify page
  // still works — the audit invariant only requires the *server* commit be
  // pre-published, not that the client seed be user-specified.
  const clientSeed = body.client_seed ?? generateRandomClientSeed();

  // Lottery fairness branch — Part B §10.
  // While the drop is OPEN and we're inside the fairness window, divert the
  // intent into a Redis sorted set with a random score. The lottery-resolver
  // cron drains the set in score order and runs the existing atomic UPDATE
  // path per winner, so race protection from §6.1 is unchanged.
  const [meta] = await db
    .select({ startsAt: packDrops.startsAt, state: packDrops.state })
    .from(packDrops)
    .where(eq(packDrops.id, dropId))
    .limit(1);
  if (!meta) throw new DropNotOpenError();

  const windowEnd = meta.startsAt.getTime() + LOTTERY_WINDOW_MS;
  if (meta.state === 'OPEN' && Date.now() < windowEnd) {
    const enq = await enqueueIntent(dropId, user.id, LOTTERY_WINDOW_MS);
    return NextResponse.json(
      {
        status: 'queued',
        position: enq.position,
        resolveAfterMs: Math.max(0, windowEnd - Date.now()) + 2_000,
      },
      { status: 202 },
    );
  }

  // Past the fairness window — fall through to direct atomic path (Part A
  // behaviour preserved verbatim).

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

    // ── 2b. Provably-fair: claim a pre-published seed and pin the pack id ──
    // Pack id is generated in JS so the same value is used in (a) the HMAC
    // payload `client_seed:pack_id:i`, (b) the seed_pool.used_for_pack_id
    // backreference, and (c) the packs row insert below — without a second
    // UPDATE round-trip after insert.
    const packId = randomUUID();
    const { commit, serverSeed } = await consumeSeed(tx, packId);

    // ── 3. Roll cards via the HMAC sampler. ──
    const rolled = await rollPackHmac({
      tier: drop.tier,
      pool: cardPool,
      serverSeed,
      clientSeed,
      packId,
      slots,
    });

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

    // Snapshot the eligibility set so the verify page reproduces the exact
    // same pool — sorted ascending so the on-disk array is canonical and the
    // browser-side sort in the sampler matches index-by-index.
    const eligibleCardIds = cardPool
      .map((c) => c.id)
      .slice()
      .sort();

    // ── 5. Insert packs row with the per-pack provably-fair snapshot. ──
    const [pack] = await tx
      .insert(packs)
      .values({
        id: packId,
        ownerId: user.id,
        dropId,
        tier: drop.tier,
        pricePaid: drop.priceCents,
        packEvAtPurchase,
        rarityWeights: { slots },
        serverSeedCommit: commit,
        serverSeed,
        clientSeed,
        eligibleCardIds,
      })
      .returning({ id: packs.id });
    if (!pack) throw new Error('pack insert returned no row');

    // ── 6. Insert pack_cards. Position N = HMAC slot index N so the verify ──
    //       page can recompute slot N's HMAC and compare to pack_cards[N].
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
  // SeedPoolEmptyError thrown inside the tx aborts the transaction (rolling
  // back the inventory + wallet decrements) and bubbles to the api-handler
  // wrapper, which surfaces it as a 503. The buy fails loudly rather than
  // silently fabricating a non-pre-published seed — preserving the audit
  // invariant matters more than a single denied purchase.

  // ── 9. Publish AFTER commit. ──
  await publish(`drop:${dropId}`, {
    inventoryRemaining: result.remaining,
    soldOut: result.remaining === 0,
  });

  return NextResponse.json({ packId: result.packId }, { status: 201 });
    },
  ),
);
