import type { SlotWeights } from './economics/types';
import {
  RARITY_ORDER,
  TIER_CONFIG,
  type Rarity,
  type SlotType,
  type Tier,
} from './tier-config';

export interface PoolCard {
  readonly id: string;
  readonly rarity: Rarity;
}

export interface RolledCard {
  readonly cardId: string;
  readonly rarity: Rarity;
  readonly slotType: SlotType;
}

export type Rng = () => number;

/**
 * Mulberry32: 32-bit deterministic PRNG. Used by tests to make pack rolls
 * reproducible. NOT a cryptographic RNG — fine for game randomness.
 */
export function mulberry32(seed: number): Rng {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pickRarity(weights: Record<Rarity, number>, rng: Rng): Rarity {
  const r = rng();
  let acc = 0;
  for (const rarity of RARITY_ORDER) {
    acc += weights[rarity];
    if (r < acc) return rarity;
  }
  // Float drift safety: return the last rarity with non-zero weight.
  for (let i = RARITY_ORDER.length - 1; i >= 0; i--) {
    const rr = RARITY_ORDER[i]!;
    if ((weights[rr] ?? 0) > 0) return rr;
  }
  throw new Error('No rarity weights configured');
}

function pickFromPool<T>(pool: readonly T[], rng: Rng): T {
  // Cap the index even if rng() ever returns 1.0 (some PRNGs do at edges).
  const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[idx]!;
}

/**
 * Roll a pack. Deterministic given `rng`. Output is sorted by rarity
 * ascending (commons first, hits last) per ARCHITECTURE §5.6 and §6.1, so
 * the reveal UI can iterate by index to build tension.
 *
 * The roller is robust to a sparse card pool: if the rolled rarity bucket is
 * empty, it walks down to the next non-empty bucket. This matters for the
 * trial-scale seed where the L bucket has only ~6 cards.
 *
 * Part B §9: `slots` is the per-pack snapshot of rarity weights actually
 * used to roll this pack. Pass the value from `packs.rarity_weights` when
 * re-rolling a historical pack or when minting a new pack with the active
 * solver snapshot. Defaults to `TIER_CONFIG[tier].slots` (the advertised
 * aspirational weights) for backwards compatibility with Part A callers.
 */
export function rollPack(
  tier: Tier,
  cardPool: ReadonlyArray<PoolCard>,
  rng: Rng = Math.random,
  slots: readonly SlotWeights[] = TIER_CONFIG[tier].slots,
): RolledCard[] {
  const byRarity = new Map<Rarity, PoolCard[]>();
  for (const r of RARITY_ORDER) byRarity.set(r, []);
  for (const card of cardPool) byRarity.get(card.rarity)!.push(card);

  const rolled: RolledCard[] = [];

  for (const slot of slots) {
    for (let i = 0; i < slot.count; i++) {
      const wantedRarity = pickRarity(slot.weights, rng);
      let pool = byRarity.get(wantedRarity)!;

      if (pool.length === 0) {
        // Walk down to a populated bucket (commons are the densest fallback).
        const startIdx = RARITY_ORDER.indexOf(wantedRarity);
        for (let j = startIdx - 1; j >= 0; j--) {
          const candidate = byRarity.get(RARITY_ORDER[j]!)!;
          if (candidate.length > 0) {
            pool = candidate;
            break;
          }
        }
        // If still empty, walk up. Last resort.
        if (pool.length === 0) {
          for (let j = startIdx + 1; j < RARITY_ORDER.length; j++) {
            const candidate = byRarity.get(RARITY_ORDER[j]!)!;
            if (candidate.length > 0) {
              pool = candidate;
              break;
            }
          }
        }
        if (pool.length === 0) {
          throw new Error('Card pool is empty across all rarity buckets');
        }
      }

      const card = pickFromPool(pool, rng);
      rolled.push({ cardId: card.id, rarity: card.rarity, slotType: slot.type });
    }
  }

  // Sort by rarity ascending. Array.sort is stable in modern JS engines,
  // so ties preserve roll order.
  rolled.sort(
    (a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity),
  );
  return rolled;
}
