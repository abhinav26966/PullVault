/**
 * Pack-economics simulator — Part B §9, upgraded for B4.
 *
 * Two sampling modes:
 *
 *   1. **Bucket-mean (default).** Each simulated pack is a sequence of rarity
 *      samples (one per slot, weighted by the slot's `weights`); realised
 *      value is the sum of bucket-mean prices for the sampled rarities. This
 *      matches the solver's worldview — agreement between solver EV and
 *      simulator EV is the audit invariant the recompute layer relies on.
 *
 *   2. **Card-level (B4 carry-forward TODO).** Pass `cardPool` to opt in.
 *      The simulator picks a rarity bucket as before, then samples one card
 *      uniformly from that bucket and records its price. This is what the
 *      verify page does too — the same two-stage sampling logic, just driven
 *      by mulberry32 inside Monte Carlo because we don't need cryptographic
 *      determinism here. Card-level produces meaningful win-rate
 *      distributions even when the bucket mean is below the pack price (the
 *      pokemontcg.io ingest case where L-bucket mean = 153c < 499c bronze
 *      pack price would otherwise yield winRate=0 across all tiers).
 *
 * Determinism: seeded mulberry32. Same inputs + seed → byte-identical
 * output. The recompute layer fixes the seed (see recompute.ts) so two
 * recomputes on the same prices produce the same audit trail. The card-level
 * mode also uses the same seed; switching modes on the same seed produces a
 * different output (different RNG draws consumed) but each mode is
 * individually reproducible.
 */

import { mulberry32, type Rng } from '../pack-roller';
import { RARITY_ORDER, type Rarity } from '../tier-config';
import type { SlotWeights } from './types';

export interface SimulatorPoolEntry {
  readonly rarity: Rarity;
  readonly priceCents: number;
}

export interface SimulatorInput {
  readonly slots: readonly SlotWeights[];
  readonly priceCents: number;
  readonly rarityMeanCents: Readonly<Record<Rarity, number>>;
  /** Optional card-level pool. When provided the simulator samples a specific
   *  card price within the rolled rarity bucket, instead of using the bucket
   *  mean. Required for meaningful win-rate distributions on pools where the
   *  bucket mean is far below or above pack price. */
  readonly cardPool?: ReadonlyArray<SimulatorPoolEntry>;
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
  /** 'bucket-mean' or 'card-level' — surfaces in the dashboard so reviewers
   *  know which sampling mode produced the numbers. */
  readonly mode: 'bucket-mean' | 'card-level';
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

function rollPackBucketMean(
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

function groupPoolByRarity(
  pool: ReadonlyArray<SimulatorPoolEntry>,
): Record<Rarity, number[]> {
  const out: Record<Rarity, number[]> = { C: [], U: [], R: [], E: [], L: [] };
  for (const entry of pool) out[entry.rarity].push(entry.priceCents);
  return out;
}

function rollPackCardLevel(
  slots: readonly SlotWeights[],
  byRarity: Record<Rarity, number[]>,
  rng: Rng,
): number {
  let value = 0;
  for (const slot of slots) {
    for (let i = 0; i < slot.count; i++) {
      const wanted = pickRarity(slot.weights, rng);
      let bucket = byRarity[wanted];
      if (bucket.length === 0) {
        // Sparse-pool fallback mirrors the production sampler — walk down,
        // then up, so simulator EV reflects what the live mint would do.
        const startIdx = RARITY_ORDER.indexOf(wanted);
        for (let j = startIdx - 1; j >= 0; j--) {
          const cand = byRarity[RARITY_ORDER[j]!];
          if (cand.length > 0) {
            bucket = cand;
            break;
          }
        }
        if (bucket.length === 0) {
          for (let j = startIdx + 1; j < RARITY_ORDER.length; j++) {
            const cand = byRarity[RARITY_ORDER[j]!];
            if (cand.length > 0) {
              bucket = cand;
              break;
            }
          }
        }
        if (bucket.length === 0) {
          throw new Error('simulator: card pool empty across all rarities');
        }
      }
      const idx = Math.min(bucket.length - 1, Math.floor(rng() * bucket.length));
      value += bucket[idx]!;
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

  const byRarity = input.cardPool ? groupPoolByRarity(input.cardPool) : null;
  const mode: 'bucket-mean' | 'card-level' = byRarity ? 'card-level' : 'bucket-mean';

  for (let i = 0; i < input.n; i++) {
    const v = byRarity
      ? rollPackCardLevel(input.slots, byRarity, rng)
      : rollPackBucketMean(input.slots, input.rarityMeanCents, rng);
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
    mode,
  };
}
