import { describe, expect, it } from 'vitest';
import { mulberry32, rollPack, type PoolCard } from '../pack-roller';
import { RARITY_ORDER, TIER_CONFIG, type Rarity, type Tier } from '../tier-config';

/** Build a generous test pool with many cards in every rarity bucket. */
function makePool(perBucket = 20): PoolCard[] {
  const out: PoolCard[] = [];
  for (const r of RARITY_ORDER) {
    for (let i = 0; i < perBucket; i++) out.push({ id: `${r}-${i}`, rarity: r });
  }
  return out;
}

describe('rollPack — basic shape', () => {
  it.each<[Tier, number]>([
    ['BRONZE', 5],
    ['SILVER', 7],
    ['GOLD', 10],
  ])('%s yields %i cards', (tier, count) => {
    const cards = rollPack(tier, makePool(), mulberry32(42));
    expect(cards).toHaveLength(count);
  });

  it('output is sorted by rarity ascending', () => {
    for (const tier of ['BRONZE', 'SILVER', 'GOLD'] as const) {
      const cards = rollPack(tier, makePool(), mulberry32(42));
      const positions = cards.map((c) => RARITY_ORDER.indexOf(c.rarity));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    }
  });

  it('seeded RNG is deterministic', () => {
    const a = rollPack('GOLD', makePool(), mulberry32(7));
    const b = rollPack('GOLD', makePool(), mulberry32(7));
    expect(a).toEqual(b);
  });

  it('different seeds produce different rolls', () => {
    const a = rollPack('GOLD', makePool(), mulberry32(1));
    const b = rollPack('GOLD', makePool(), mulberry32(2));
    expect(a).not.toEqual(b);
  });
});

describe('rollPack — sparse pool fallback', () => {
  it('survives an empty L bucket by walking down to E/R/U/C', () => {
    // All Gold jackpot weights point at R/E/L; remove L entirely.
    const pool: PoolCard[] = [];
    for (const r of ['C', 'U', 'R', 'E'] as Rarity[]) {
      for (let i = 0; i < 5; i++) pool.push({ id: `${r}-${i}`, rarity: r });
    }
    const cards = rollPack('GOLD', pool, mulberry32(42));
    expect(cards).toHaveLength(10);
    // Every card should be a real pool card.
    for (const c of cards) {
      expect(['C', 'U', 'R', 'E']).toContain(c.rarity);
    }
  });

  it('throws if every bucket is empty', () => {
    expect(() => rollPack('BRONZE', [], mulberry32(0))).toThrow();
  });
});

/**
 * Statistical test. 10,000 rolls per tier; empirical proportion of each
 * rarity in the rolled cards should be within 2 percentage points (absolute)
 * of the configured proportion. This catches gross implementation errors
 * (swapped weights, off-by-one slot counts, biased RNG) while tolerating
 * binomial noise on the rarer buckets at this sample size.
 */
function expectedProportion(tier: Tier, rarity: Rarity): number {
  const cfg = TIER_CONFIG[tier];
  let weight = 0;
  for (const slot of cfg.slots) {
    weight += slot.weights[rarity] * slot.count;
  }
  return weight / cfg.cardCount;
}

describe('rollPack — slots override (Part B §9 snapshot path)', () => {
  it('honours an explicit slots argument over TIER_CONFIG defaults', () => {
    // Force every slot to roll commons by passing an all-C weight vector.
    const allCommons = [
      {
        type: 'FILLER' as const,
        count: 5,
        weights: { C: 1, U: 0, R: 0, E: 0, L: 0 },
      },
    ];
    const cards = rollPack('BRONZE', makePool(), mulberry32(42), allCommons);
    expect(cards).toHaveLength(5);
    for (const c of cards) expect(c.rarity).toBe('C');
  });

  it('passing the same TIER_CONFIG slots explicitly produces an identical roll', () => {
    const seed = 99;
    const baseline = rollPack('BRONZE', makePool(), mulberry32(seed));
    const explicit = rollPack(
      'BRONZE',
      makePool(),
      mulberry32(seed),
      TIER_CONFIG.BRONZE.slots,
    );
    expect(explicit).toEqual(baseline);
  });
});

describe('rollPack — empirical distribution (10k rolls)', () => {
  it.each<[Tier]>([['BRONZE'], ['SILVER'], ['GOLD']])(
    '%s distribution within 2pp of configured weights',
    (tier) => {
      const N = 10_000;
      const pool = makePool(50);
      const rng = mulberry32(123);
      const counts: Record<Rarity, number> = { C: 0, U: 0, R: 0, E: 0, L: 0 };

      let totalCards = 0;
      for (let i = 0; i < N; i++) {
        const cards = rollPack(tier, pool, rng);
        for (const c of cards) {
          counts[c.rarity]++;
          totalCards++;
        }
      }

      for (const r of RARITY_ORDER) {
        const empirical = counts[r] / totalCards;
        const expected = expectedProportion(tier, r);
        expect(
          Math.abs(empirical - expected),
          `${tier}/${r}: empirical ${empirical.toFixed(4)} vs expected ${expected.toFixed(4)}`,
        ).toBeLessThan(0.02);
      }
    },
  );
});
