/**
 * Pack-economics solver — Part B §9.
 *
 * Given aspirational weights, floor weights, mean prices per rarity bucket,
 * and a target margin, compute per-slot tilt parameters t_s ∈ [0, 1] such
 * that pack EV equals the target EV.
 *
 *   w_s(t_s)   = (1 - t_s) * floor_s + t_s * aspirational_s
 *   slotEV_s   = sum_r w_s(t_s)[r] * meanPrice[r]   (linear in t_s)
 *   packEV     = sum_s count_s * slotEV_s
 *   targetEV   = priceCents * (1 - targetMargin)
 *
 * Two modes:
 *
 * - 'lagrangian' (primary): minimise sum_s (1 - t_s)^2 subject to packEV =
 *   targetEV and t_s ∈ [0, 1]. KKT gives interior t_s = 1 + λ * count_s *
 *   leverage_s / 2 with a global Lagrange multiplier λ ≤ 0; clamping to
 *   [0, 1] is handled implicitly by bisecting on λ over a wide interval
 *   so out-of-range t_s saturate at the bounds. Non-uniform tilting:
 *   high-leverage slots (more cards × more EV swing) move first.
 *
 * - 'tilt' (fallback / self-test): a single global tilt parameter shared
 *   across slots. Closed-form. Used by the recompute layer to compare
 *   against the lagrangian output as a numeric self-test — disagreement
 *   >0.5% blocks activation per the B1 self-test invariant.
 *
 * Determinism is mandatory. All bisection bounds and iteration counts
 * are fixed; tilt and weight values are rounded to 1e-6 before being
 * returned, then renormalised so each slot's weights sum to exactly 1.
 */

import { RARITY_ORDER, type Rarity } from '../tier-config';
import type {
  SlotWeights,
  SolverInput,
  SolverResult,
  SolverMode,
  SolvedSlot,
} from './types';

const BISECTION_ITERATIONS = 50;
const FLOAT_PRECISION = 1_000_000;
const FEASIBILITY_TOL = 1e-6;

interface PerSlot {
  readonly aspire: SlotWeights;
  readonly floor: SlotWeights;
  readonly aspireEV: number;
  readonly floorEV: number;
  readonly leverage: number;
}

function roundToPrecision(value: number): number {
  return Math.round(value * FLOAT_PRECISION) / FLOAT_PRECISION;
}

function slotEV(
  weights: Readonly<Record<Rarity, number>>,
  prices: Readonly<Record<Rarity, number>>,
): number {
  let ev = 0;
  for (const r of RARITY_ORDER) ev += weights[r] * prices[r];
  return ev;
}

function buildPerSlot(input: SolverInput): PerSlot[] {
  if (input.aspirational.length !== input.floor.length) {
    throw new Error(
      `solver: aspirational(${input.aspirational.length}) and floor(${input.floor.length}) lengths differ`,
    );
  }
  return input.aspirational.map((aspire, i) => {
    const floor = input.floor[i]!;
    if (aspire.type !== floor.type || aspire.count !== floor.count) {
      throw new Error(
        `solver: floor[${i}] mismatch — expected ${aspire.type}/${aspire.count}, got ${floor.type}/${floor.count}`,
      );
    }
    const aspireEV = slotEV(aspire.weights, input.rarityMeanCents);
    const floorEV = slotEV(floor.weights, input.rarityMeanCents);
    return { aspire, floor, aspireEV, floorEV, leverage: aspireEV - floorEV };
  });
}

function evAtLambda(perSlot: readonly PerSlot[], lambda: number): number {
  let ev = 0;
  for (const s of perSlot) {
    const tRaw = 1 + (lambda * s.aspire.count * s.leverage) / 2;
    const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
    ev += s.aspire.count * (s.floorEV + t * s.leverage);
  }
  return ev;
}

function solveLagrangian(perSlot: readonly PerSlot[], targetEV: number): number[] {
  // evAt(lambda) is monotonically non-decreasing in lambda over [-1e6, 0]:
  //   lambda → -∞ pushes every t_s to 0 (pack at floor EV)
  //   lambda = 0 pushes every t_s to 1 (pack at aspire EV)
  let lo = -1_000_000;
  let hi = 0;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const ev = evAtLambda(perSlot, mid);
    if (ev > targetEV) hi = mid;
    else lo = mid;
  }
  const lambda = (lo + hi) / 2;
  return perSlot.map((s) => {
    const tRaw = 1 + (lambda * s.aspire.count * s.leverage) / 2;
    return tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
  });
}

function solveTilt(perSlot: readonly PerSlot[], targetEV: number): number[] {
  let packFloorEV = 0;
  let packLeverage = 0;
  for (const s of perSlot) {
    packFloorEV += s.aspire.count * s.floorEV;
    packLeverage += s.aspire.count * s.leverage;
  }
  if (packLeverage <= FEASIBILITY_TOL) return perSlot.map(() => 1);
  const tRaw = (targetEV - packFloorEV) / packLeverage;
  const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
  return perSlot.map(() => t);
}

function buildSolvedSlot(s: PerSlot, t: number): SolvedSlot {
  const tilt = roundToPrecision(t);
  const raw: Record<Rarity, number> = { C: 0, U: 0, R: 0, E: 0, L: 0 };
  for (const r of RARITY_ORDER) {
    raw[r] = roundToPrecision((1 - tilt) * s.floor.weights[r] + tilt * s.aspire.weights[r]);
  }
  // Renormalise so the slot weights sum to exactly 1 after rounding.
  let sum = 0;
  for (const r of RARITY_ORDER) sum += raw[r];
  if (sum <= 0) throw new Error('solver: degenerate weights — sum ≤ 0');
  const weights: Record<Rarity, number> = { C: 0, U: 0, R: 0, E: 0, L: 0 };
  for (const r of RARITY_ORDER) weights[r] = roundToPrecision(raw[r] / sum);
  return { type: s.aspire.type, count: s.aspire.count, weights, tilt };
}

export function solveWeights(input: SolverInput): SolverResult {
  const mode: SolverMode = input.mode ?? 'lagrangian';
  const perSlot = buildPerSlot(input);
  const targetEV = input.priceCents * (1 - input.targetMargin);

  let packFloorEV = 0;
  let packAspireEV = 0;
  for (const s of perSlot) {
    packFloorEV += s.aspire.count * s.floorEV;
    packAspireEV += s.aspire.count * s.aspireEV;
  }

  if (targetEV < packFloorEV - FEASIBILITY_TOL) {
    return {
      status: 'infeasible',
      reason: `target_ev=${targetEV.toFixed(2)}c < pack_floor_ev=${packFloorEV.toFixed(2)}c; even floor weights overshoot the target margin`,
      slots: perSlot.map((s) => buildSolvedSlot(s, 0)),
      evCents: Math.round(packFloorEV),
      mode,
    };
  }
  if (targetEV >= packAspireEV - FEASIBILITY_TOL) {
    // Aspirational is already at-or-below target; no tilt needed.
    return {
      status: 'ok',
      slots: perSlot.map((s) => buildSolvedSlot(s, 1)),
      evCents: Math.round(packAspireEV),
      mode,
    };
  }

  const tilts =
    mode === 'lagrangian'
      ? solveLagrangian(perSlot, targetEV)
      : solveTilt(perSlot, targetEV);

  const slots = perSlot.map((s, i) => buildSolvedSlot(s, tilts[i]!));
  let evFloat = 0;
  for (const s of slots) evFloat += s.count * slotEV(s.weights, input.rarityMeanCents);

  return {
    status: 'ok',
    slots,
    evCents: Math.round(evFloat),
    mode,
  };
}
