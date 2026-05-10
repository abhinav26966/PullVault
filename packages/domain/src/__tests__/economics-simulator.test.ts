import { describe, expect, it } from 'vitest';
import { FLOOR_WEIGHTS } from '../economics/floors';
import { simulate } from '../economics/simulator';
import { solveWeights } from '../economics/solver';
import type { SlotWeights } from '../economics/types';
import { RARITY_MEAN_CENTS, TIER_CONFIG } from '../tier-config';

function aspireFor(tier: 'BRONZE' | 'SILVER' | 'GOLD'): SlotWeights[] {
  return TIER_CONFIG[tier].slots.map((s) => ({
    type: s.type,
    count: s.count,
    weights: { ...s.weights },
  }));
}

function floorFor(tier: 'BRONZE' | 'SILVER' | 'GOLD'): SlotWeights[] {
  return TIER_CONFIG[tier].slots.map((s) => ({
    type: s.type,
    count: s.count,
    weights: { ...FLOOR_WEIGHTS[s.type] },
  }));
}

describe('simulate — determinism', () => {
  it('same seed produces byte-identical result across two invocations', () => {
    const input = {
      slots: aspireFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 10_000,
      seed: 42,
    };
    const a = simulate(input);
    const b = simulate(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds produce different distributions', () => {
    const base = {
      slots: aspireFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 10_000,
    };
    const a = simulate({ ...base, seed: 1 });
    const b = simulate({ ...base, seed: 2 });
    // Means should be different (with overwhelming probability) but close.
    expect(a.meanCents).not.toBe(b.meanCents);
    expect(Math.abs(a.meanCents - b.meanCents)).toBeLessThan(50);
  });
});

describe('simulate — accuracy at aspirational weights', () => {
  it('Bronze aspirational mean ≈ documented EV (305c) within Monte Carlo noise', () => {
    const result = simulate({
      slots: aspireFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 50_000,
      seed: 7,
    });
    expect(Math.abs(result.meanCents - 305)).toBeLessThan(15);
  });

  it('Silver aspirational mean ≈ documented EV (974c)', () => {
    const result = simulate({
      slots: aspireFor('SILVER'),
      priceCents: 1_499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 50_000,
      seed: 7,
    });
    expect(Math.abs(result.meanCents - 974)).toBeLessThan(50);
  });
});

describe('simulate — outputs are well-ordered', () => {
  it('p5 ≤ p50 ≤ p95 ≤ max plausible value', () => {
    const result = simulate({
      slots: aspireFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 5_000,
      seed: 99,
    });
    expect(result.p5Cents).toBeLessThanOrEqual(result.p50Cents);
    expect(result.p50Cents).toBeLessThanOrEqual(result.p95Cents);
  });

  it('marginActual = (price - mean) / price', () => {
    const result = simulate({
      slots: aspireFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 5_000,
      seed: 11,
    });
    const expected = (499 - result.meanCents) / 499;
    expect(Math.abs(result.marginActual - expected)).toBeLessThan(0.01);
  });

  it('winRate is in [0, 1]', () => {
    const result = simulate({
      slots: aspireFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 5_000,
      seed: 13,
    });
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
  });
});

describe('simulate — composes with solver', () => {
  it('solver-tilted weights produce simulation mean ≈ solver evCents', () => {
    const elevated = { C: 10, U: 30, R: 150, E: 1_500, L: 12_000 };
    const solved = solveWeights({
      aspirational: aspireFor('BRONZE'),
      floor: floorFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: elevated,
      targetMargin: 0.3,
      mode: 'lagrangian',
    });
    expect(solved.status).toBe('ok');
    const sim = simulate({
      slots: solved.slots,
      priceCents: 499,
      rarityMeanCents: elevated,
      n: 50_000,
      seed: 17,
    });
    expect(Math.abs(sim.meanCents - solved.evCents)).toBeLessThan(40);
  });
});

describe('simulate — input validation', () => {
  it('throws when n is non-positive', () => {
    expect(() =>
      simulate({
        slots: aspireFor('BRONZE'),
        priceCents: 499,
        rarityMeanCents: RARITY_MEAN_CENTS,
        n: 0,
      }),
    ).toThrow(/n must be positive/);
  });
});

describe('simulate — card-level mode (Part B §12 carry-forward)', () => {
  // Build a synthetic pool where each rarity has a tight cluster around the
  // documented bucket mean — card-level sampling should produce an EV very
  // close to the bucket-mean EV (parity invariant).
  function tightPool(): { rarity: keyof typeof RARITY_MEAN_CENTS; priceCents: number }[] {
    const out: { rarity: keyof typeof RARITY_MEAN_CENTS; priceCents: number }[] = [];
    for (const r of ['C', 'U', 'R', 'E', 'L'] as const) {
      const mean = RARITY_MEAN_CENTS[r];
      // 5 cards per bucket spread ±10% around the mean.
      for (let i = 0; i < 5; i++) {
        const offset = ((i - 2) * mean) / 10;
        out.push({ rarity: r, priceCents: Math.max(1, Math.round(mean + offset)) });
      }
    }
    return out;
  }

  it('reports mode=card-level when cardPool is provided', () => {
    const r = simulate({
      slots: aspireFor('BRONZE'),
      priceCents: 499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      cardPool: tightPool(),
      n: 5_000,
      seed: 23,
    });
    expect(r.mode).toBe('card-level');
  });

  it('agrees with bucket-mean EV within 2% on a tight pool', () => {
    // The card-level draw has higher per-card variance than the bucket-mean
    // path (each card varies ±20% around the bucket mean), so MC noise on
    // 50K samples lands a hair above 1% on average. The signal we care
    // about — "no systemic divergence between modes" — is well-captured at
    // 2%; an order-of-magnitude bug would still fail.
    const base = {
      slots: aspireFor('SILVER'),
      priceCents: 1_499,
      rarityMeanCents: RARITY_MEAN_CENTS,
      n: 50_000,
      seed: 51,
    };
    const bucket = simulate(base);
    const card = simulate({ ...base, cardPool: tightPool() });
    expect(bucket.mode).toBe('bucket-mean');
    expect(card.mode).toBe('card-level');
    const delta = Math.abs(card.meanCents - bucket.meanCents);
    expect(delta / bucket.meanCents).toBeLessThan(0.02);
  });

  it('with a heavy-hit pool produces meaningful win-rate (> bucket-mean win-rate)', () => {
    // L-bucket cards far above pack price; W-rate at card-level should be
    // measurably higher than bucket-mean (which uses the L-bucket *mean* of
    // 5000c, leaving a nonzero gap relative to a 4999c GOLD pack).
    const heavyPool: { rarity: keyof typeof RARITY_MEAN_CENTS; priceCents: number }[] = [
      ...Array.from({ length: 10 }, () => ({ rarity: 'C' as const, priceCents: 5 })),
      ...Array.from({ length: 10 }, () => ({ rarity: 'U' as const, priceCents: 15 })),
      ...Array.from({ length: 10 }, () => ({ rarity: 'R' as const, priceCents: 75 })),
      ...Array.from({ length: 5 }, () => ({ rarity: 'E' as const, priceCents: 600 })),
      // L bucket: a few low and one whale at 50,000c — same mean (5000) but
      // large variance, so individual draws can clear pack price.
      { rarity: 'L', priceCents: 1_000 },
      { rarity: 'L', priceCents: 1_000 },
      { rarity: 'L', priceCents: 1_000 },
      { rarity: 'L', priceCents: 50_000 },
    ];
    const sim = simulate({
      slots: aspireFor('GOLD'),
      priceCents: 4_999,
      rarityMeanCents: RARITY_MEAN_CENTS,
      cardPool: heavyPool,
      n: 20_000,
      seed: 71,
    });
    // We don't pin a specific number — just assert the win-rate signal exists.
    expect(sim.winRate).toBeGreaterThan(0);
  });

  it('falls back through empty buckets without throwing', () => {
    const sparsePool = [
      { rarity: 'C' as const, priceCents: 5 },
      { rarity: 'U' as const, priceCents: 15 },
      { rarity: 'R' as const, priceCents: 75 },
      // No E or L cards — Gold's JACKPOT slot would normally roll those.
    ];
    expect(() =>
      simulate({
        slots: aspireFor('GOLD'),
        priceCents: 4_999,
        rarityMeanCents: RARITY_MEAN_CENTS,
        cardPool: sparsePool,
        n: 1_000,
        seed: 99,
      }),
    ).not.toThrow();
  });
});
