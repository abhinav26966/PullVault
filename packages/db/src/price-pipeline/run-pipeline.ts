import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { db } from '../client';
import {
  cardPrices,
  cards,
  packDrops,
  PLATFORM_USER_ID,
  users,
  wallets,
} from '../schema';
import { normalizeRarity, rarityBucketMean } from './rarity-map';
import { source } from './source';

const DEFAULT_SETS = 'swsh1,swsh4,swsh12,sv1,sv3';

const PRICE_BROADCAST_THRESHOLD =
  Number(process.env.PRICE_BROADCAST_THRESHOLD_PERCENT ?? 1) / 100;

export interface PipelineResult {
  source: string;
  totalFetched: number;
  inserted: number;
  priceUpdated: number;
  broadcast: number;
  changed: Array<{ cardId: string; price: number }>;
  unknownRarities: string[];
}

/**
 * Single function that runs at boot (initial population) and on every cron
 * tick (recurring refresh). There is no architectural distinction between
 * "seed" and "refresh" — they share this code path.
 */
export async function runPipeline(opts?: {
  setIds?: string[];
  perSet?: number;
}): Promise<PipelineResult> {
  const setIds =
    opts?.setIds ?? (process.env.SEED_SETS ?? DEFAULT_SETS).split(',').map((s) => s.trim());
  const perSet = opts?.perSet ?? Number(process.env.SEED_CARDS_PER_SET ?? 100);

  const rawCards = await source.fetchCards(setIds, { perSet });

  const changed: Array<{ cardId: string; price: number }> = [];
  let inserted = 0;
  let priceUpdated = 0;
  const unknownRarities = new Set<string>();

  for (const raw of rawCards) {
    const { bucket, known } = normalizeRarity(raw.rarity);
    if (!known && raw.rarity) unknownRarities.add(raw.rarity);

    const livePriceCents = source.extractPrice(raw) ?? rarityBucketMean(raw.rarity);

    const cardRow = {
      id: raw.id,
      name: raw.name,
      setId: raw.set.id,
      setName: raw.set.name,
      number: raw.number,
      rarityRaw: raw.rarity ?? '',
      rarity: bucket,
      imageUrl: raw.images.large,
      imageUrlSmall: raw.images.small,
    };

    await db
      .insert(cards)
      .values(cardRow)
      .onConflictDoUpdate({
        target: cards.id,
        set: {
          name: cardRow.name,
          setId: cardRow.setId,
          setName: cardRow.setName,
          number: cardRow.number,
          rarityRaw: cardRow.rarityRaw,
          rarity: cardRow.rarity,
          imageUrl: cardRow.imageUrl,
          imageUrlSmall: cardRow.imageUrlSmall,
        },
      });

    const existing = await db
      .select()
      .from(cardPrices)
      .where(eq(cardPrices.cardId, raw.id))
      .limit(1);

    const isNew = existing.length === 0;
    const oldPrice = existing[0]?.price ?? 0;
    const drift = isNew || oldPrice === 0 ? 0 : Math.abs(livePriceCents - oldPrice) / oldPrice;
    const meaningfulChange = !isNew && drift > PRICE_BROADCAST_THRESHOLD;

    const now = new Date();
    await db
      .insert(cardPrices)
      .values({
        cardId: raw.id,
        price: livePriceCents,
        baseline: livePriceCents,
        lastRealPollAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: cardPrices.cardId,
        set: {
          baseline: livePriceCents,
          price: livePriceCents,
          lastRealPollAt: now,
          updatedAt: now,
        },
      });

    if (isNew) inserted++;
    if (meaningfulChange) {
      priceUpdated++;
      changed.push({ cardId: raw.id, price: livePriceCents });
    }
  }

  // Phase 6 will publish `prices:global` to Redis here when changed.length > 0.
  // For Phase 2 the pipeline runs out of band, so we just log.

  console.info(
    `[pipeline source=${source.name}] fetched=${rawCards.length} inserted=${inserted} ` +
      `priceUpdated=${priceUpdated} broadcast=${changed.length}`,
  );
  if (unknownRarities.size > 0) {
    console.warn(
      `[pipeline] unknown rarities (defaulted to R, add to rarity-map.ts):`,
      Array.from(unknownRarities),
    );
  }

  return {
    source: source.name,
    totalFetched: rawCards.length,
    inserted,
    priceUpdated,
    broadcast: changed.length,
    changed,
    unknownRarities: Array.from(unknownRarities),
  };
}

/**
 * The platform user owns the counterparty side of fee ledger entries.
 * No one ever logs in as it; the password hash is intentionally invalid.
 */
const PLATFORM_USER_EMAIL = 'platform@pullvault.local';
const PLATFORM_USER_DISPLAY = '__platform__';

export async function ensurePlatformUser(): Promise<boolean> {
  const existing = await db.select().from(users).where(eq(users.id, PLATFORM_USER_ID)).limit(1);
  if (existing.length > 0) return false;

  // Opaque, deliberately non-bcrypt — bcrypt.compare against any password rejects.
  const fakeHash = `__platform_no_login__${randomBytes(24).toString('hex')}`;

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: PLATFORM_USER_ID,
      email: PLATFORM_USER_EMAIL,
      passwordHash: fakeHash,
      displayName: PLATFORM_USER_DISPLAY,
    });
    await tx.insert(wallets).values({
      userId: PLATFORM_USER_ID,
      balanceAvailable: 0,
      balanceHeld: 0,
    });
  });

  console.info('[pipeline] inserted platform user');
  return true;
}

/**
 * Three sample drops for the dev environment so reviewers (and demos) have
 * something to look at immediately. Idempotent: only inserts if the drops
 * table is currently empty. On subsequent pipeline runs this is a no-op.
 */
export async function ensureSampleDrops(): Promise<number> {
  const any = await db.select().from(packDrops).limit(1);
  if (any.length > 0) return 0;

  const now = Date.now();
  const samples = [
    {
      tier: 'BRONZE' as const,
      priceCents: 499,
      inventoryTotal: 50,
      startsAt: new Date(now + 2 * 60_000),
    },
    {
      tier: 'SILVER' as const,
      priceCents: 1499,
      inventoryTotal: 20,
      startsAt: new Date(now + 60 * 60_000),
    },
    {
      tier: 'GOLD' as const,
      priceCents: 4999,
      inventoryTotal: 5,
      startsAt: new Date(now + 3 * 60 * 60_000),
    },
  ];

  for (const s of samples) {
    await db.insert(packDrops).values({
      tier: s.tier,
      priceCents: s.priceCents,
      inventoryTotal: s.inventoryTotal,
      inventoryRemaining: s.inventoryTotal,
      startsAt: s.startsAt,
    });
  }

  console.info(`[pipeline] inserted ${samples.length} sample drops`);
  return samples.length;
}
