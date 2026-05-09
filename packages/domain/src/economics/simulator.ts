/**
 * Pack-economics simulator — Part B §9.
 *
 * Pure Monte Carlo over the solver's worldview: each simulated pack is a
 * sequence of rarity samples (one per slot, weighted by the slot's
 * `weights`), and the realised value is the sum of bucket-mean prices for
 * the sampled rarities. This matches the solver's resolution — within-
 * bucket card-level variance is a refinement deferred to ARCHITECTURE
 * §9 if budget allows.
 *
 * Determinism: seeded mulberry32. Same inputs + seed → byte-identical
 * output. The recompute layer fixes the seed (see recompute.ts) so two
 * recomputes on the same prices produce the same audit trail.
 */

import { mulberry32, type Rng } from '../pack-roller';
import { RARITY_ORDER, type Rarity } from '../tier-config';
import type { SlotWeights } from './types';

export interface SimulatorInput {
  readonly slots: readonly SlotWeights[];
  readonly priceCents: number;
  readonly rarityMeanCents: Readonly<Record<Rarity, number>>;
  readonly n: number;
  readonly seed?: number;
}

export interface SimulatorResult {
  readonly n: number;
  readonly meanCents: number;
  readonly p5Cents: number;
  readonly p50Cents: number;
  readonly p95Cents: number;
  /** Pack price minus mean realised value, divided by price. Positive = platform gain. */
  readonly marginActual: number;
  /** Fraction of packs where realised value ≥ priceCents (the "win" floor). */
  readonly winRate: number;
}

const DEFAULT_SEED = 0xdecaf;

function pickRarity(weights: Readonly<Record<Rarity, number>>, rng: Rng): Rarity {
  const r = rng();
  let acc = 0;
  for (const rarity of RARITY_ORDER) {
    acc += weights[rarity];
    if (r < acc) return rarity;
  }
  // Float drift safety: walk back to the last non-zero weight.
  for (let i = RARITY_ORDER.length - 1; i >= 0; i--) {
    const rr = RARITY_ORDER[i]!;
    if (weights[rr] > 0) return rr;
  }
  throw new Error('simulator: empty rarity weights');
}

function rollPackValue(
  slots: readonly SlotWeights[],
  prices: Readonly<Record<Rarity, number>>,
  rng: Rng,
): number {
  let value = 0;
  for (const slot of slots) {
    for (let i = 0; i < slot.count; i++) {
      const rarity = pickRarity(slot.weights, rng);
      value += prices[rarity];
    }
  }
  return value;
}

export function simulate(input: SimulatorInput): SimulatorResult {
  if (input.n <= 0) throw new Error('simulator: n must be positive');
  const rng = mulberry32(input.seed ?? DEFAULT_SEED);
  const values = new Float64Array(input.n);
  let sum = 0;
  let wins = 0;
  for (let i = 0; i < input.n; i++) {
    const v = rollPackValue(input.slots, input.rarityMeanCents, rng);
    values[i] = v;
    sum += v;
    if (v >= input.priceCents) wins++;
  }
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mean = sum / input.n;
  return {
    n: input.n,
    meanCents: Math.round(mean),
    p5Cents: Math.round(sorted[Math.floor(input.n * 0.05)] ?? 0),
    p50Cents: Math.round(sorted[Math.floor(input.n * 0.5)] ?? 0),
    p95Cents: Math.round(sorted[Math.floor(input.n * 0.95)] ?? 0),
    marginActual: (input.priceCents - mean) / input.priceCents,
    winRate: wins / input.n,
  };
}
