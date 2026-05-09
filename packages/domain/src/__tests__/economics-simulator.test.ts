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
