import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { cardPrices, cards, db, getActiveSlots } from '@pullvault/db';
import {
  FLOOR_WEIGHTS,
  TIER_CONFIG,
  simulate,
  solveWeights,
  type Rarity,
  type SlotWeights,
  type Tier,
} from '@pullvault/domain';
import { withErrors } from '@/lib/api-handler';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD']),
  n: z.coerce.number().int().min(100).max(100_000).default(10_000),
  source: z.enum(['active', 'aspirational', 'solver']).default('active'),
  targetMargin: z.coerce.number().min(0).max(0.95).default(0.3),
});

async function readRarityMeanCents(): Promise<Record<Rarity, number>> {
  const rows = await db
    .select({
      rarity: cards.rarity,
      meanPrice: sql<string>`AVG(${cardPrices.price})`,
    })
    .from(cards)
    .innerJoin(cardPrices, eq(cardPrices.cardId, cards.id))
    .groupBy(cards.rarity);
  const out: Record<Rarity, number> = { C: 0, U: 0, R: 0, E: 0, L: 0 };
  for (const row of rows) {
    const v = Number(row.meanPrice ?? 0);
    if (Number.isFinite(v)) out[row.rarity as Rarity] = v;
  }
  return out;
}

async function pickSlots(
  tier: Tier,
  source: 'active' | 'aspirational' | 'solver',
  rarityMeanCents: Record<Rarity, number>,
  targetMargin: number,
): Promise<{ slots: readonly SlotWeights[]; meta: Record<string, unknown> }> {
  if (source === 'aspirational') {
    return {
      slots: TIER_CONFIG[tier].slots.map((s) => ({
        type: s.type,
        count: s.count,
        weights: { ...s.weights },
      })),
      meta: { source: 'aspirational' },
    };
  }
  if (source === 'solver') {
    const aspirational = TIER_CONFIG[tier].slots.map((s) => ({
      type: s.type,
      count: s.count,
      weights: { ...s.weights },
    }));
    const floor = aspirational.map((s) => ({
      type: s.type,
      count: s.count,
      weights: { ...FLOOR_WEIGHTS[s.type] },
    }));
    const solved = solveWeights({
      aspirational,
      floor,
      priceCents: TIER_CONFIG[tier].priceCents,
      rarityMeanCents,
      targetMargin,
      mode: 'lagrangian',
    });
    return {
      slots: solved.slots,
      meta: { source: 'solver', solverStatus: solved.status, evCents: solved.evCents },
    };
  }
  // 'active'
  const active = await getActiveSlots(tier);
  return { slots: active, meta: { source: 'active' } };
}

export const POST = withErrors(async (req) => {
  await requireAuth();
  const url = new URL(req.url);
  const params = QuerySchema.parse({
    tier: url.searchParams.get('tier'),
    n: url.searchParams.get('n') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    targetMargin: url.searchParams.get('targetMargin') ?? undefined,
  });

  const rarityMeanCents = await readRarityMeanCents();
  const priceCents = TIER_CONFIG[params.tier].priceCents;
  const { slots, meta } = await pickSlots(
    params.tier,
    params.source,
    rarityMeanCents,
    params.targetMargin,
  );

  const result = simulate({
    slots,
    priceCents,
    rarityMeanCents,
    n: params.n,
  });

  return NextResponse.json({
    tier: params.tier,
    priceCents,
    rarityMeanCents,
    slots,
    n: params.n,
    result,
    meta,
  });
});

export const GET = POST;
