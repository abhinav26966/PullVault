import { describe, expect, it } from 'vitest';
import { FLOOR_WEIGHTS } from '../economics/floors';
import { solveWeights } from '../economics/solver';
import type { SlotWeights, SolverInput } from '../economics/types';
import { RARITY_MEAN_CENTS, RARITY_ORDER, TIER_CONFIG } from '../tier-config';

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

function packEV(
  slots: ReadonlyArray<{
    count: number;
    weights: Readonly<Record<'C' | 'U' | 'R' | 'E' | 'L', number>>;
  }>,
  prices: Readonly<Record<'C' | 'U' | 'R' | 'E' | 'L', number>>,
): number {
  let ev = 0;
  for (const s of slots) {
    let slotEv = 0;
    for (const r of RARITY_ORDER) slotEv += s.weights[r] * prices[r];
    ev += s.count * slotEv;
  }
  return ev;
}

const BRONZE_INPUT: SolverInput = {
  aspirational: aspireFor('BRONZE'),
  floor: floorFor('BRONZE'),
  priceCents: 499,
  rarityMeanCents: RARITY_MEAN_CENTS,
  targetMargin: 0.3,
};

describe('solveWeights — primary path', () => {
  it('Bronze 30% margin: status ok, EV ≤ target, weights summed to 1', () => {
    const result = solveWeights(BRONZE_INPUT);
    expect(result.status).toBe('ok');
    const targetEV = 499 * 0.7;
    expect(result.evCents).toBeLessThanOrEqual(Math.ceil(targetEV) + 1);
    for (const s of result.slots) {
      const sum = RARITY_ORDER.reduce((acc, r) => acc + s.weights[r], 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('returns per-slot tilts in [0, 1]', () => {
    const result = solveWeights(BRONZE_INPUT);
    for (const s of result.slots) {
      expect(s.tilt).toBeGreaterThanOrEqual(0);
      expect(s.tilt).toBeLessThanOrEqual(1);
    }
  });

  it('Gold 25% margin: feasible at default rarity means', () => {
    const result = solveWeights({
      aspirational: aspireFor('GOLD'),
      floor: floorFor('GOLD'),
      priceCents: 4_999,
      rarityMeanCents: RARITY_MEAN_CENTS,
      targetMargin: 0.25,
    });
    expect(result.status).toBe('ok');
    expect(result.evCents).toBeLessThanOrEqual(Math.ceil(4_999 * 0.75) + 1);
  });
});

describe('solveWeights — feasibility edges', () => {
  it('infeasible: target EV below pack floor EV', () => {
    const result = solveWeights({
      ...BRONZE_INPUT,
      targetMargin: 0.99, // target_ev = 4.99c, well below floor EV
    });
    expect(result.status).toBe('infeasible');
    expect(result.reason).toMatch(/floor/);
  });

  it('aspirational already meets margin: returns t=1 for all slots', () => {
    // Tiny prices → aspire EV stays tiny → easily under any reasonable target
    const result = solveWeights({
      ...BRONZE_INPUT,
      rarityMeanCents: { C: 1, U: 2, R: 3, E: 4, L: 5 },
      targetMargin: 0.3,
    });
    expect(result.status).toBe('ok');
    for (const s of result.slots) expect(s.tilt).toBe(1);
  });

  it('sparse pool — zero E and L means → solver still produces feasible weights', () => {
    const result = solveWeights({
      ...BRONZE_INPUT,
      rarityMeanCents: { C: 5, U: 15, R: 75, E: 0, L: 0 },
      targetMargin: 0.3,
    });
    expect(result.status).toBe('ok');
  });
});

describe('solveWeights — Lagrangian / tilt self-test invariant', () => {
  // Elevated prices that push aspirational EV above target EV — forces
  // the solver to actually tilt rather than early-exit on aspirational.
  const ELEVATED = { C: 10, U: 30, R: 150, E: 1_500, L: 12_000 };

  it('Lagrangian and tilt converge to similar pack EV when tilting is required', () => {
    const base = { ...BRONZE_INPUT, rarityMeanCents: ELEVATED };
    const lag = solveWeights({ ...base, mode: 'lagrangian' });
    const tilt = solveWeights({ ...base, mode: 'tilt' });
    expect(lag.status).toBe('ok');
    expect(tilt.status).toBe('ok');
    const targetEV = 499 * 0.7;
    // Both solvers must hit the target EV (within rounding).
    expect(Math.abs(lag.evCents - targetEV) / targetEV).toBeLessThan(0.01);
    expect(Math.abs(tilt.evCents - targetEV) / targetEV).toBeLessThan(0.01);
    // And they must agree well enough that the recompute self-test does not
    // fire on a normal pool (the 0.5% gate documented in B1 §9).
    expect(Math.abs(lag.evCents - tilt.evCents) / lag.evCents).toBeLessThan(0.005);
  });

  it('Lagrangian and tilt agree across all three tiers under elevated prices', () => {
    for (const tier of ['BRONZE', 'SILVER', 'GOLD'] as const) {
      const base = {
        aspirational: aspireFor(tier),
        floor: floorFor(tier),
        priceCents: TIER_CONFIG[tier].priceCents,
        rarityMeanCents: ELEVATED,
        targetMargin: 0.3,
      };
      const lag = solveWeights({ ...base, mode: 'lagrangian' });
      const tilt = solveWeights({ ...base, mode: 'tilt' });
      expect(lag.status).toBe('ok');
      expect(tilt.status).toBe('ok');
      const delta = Math.abs(lag.evCents - tilt.evCents) / Math.max(lag.evCents, 1);
      expect(delta).toBeLessThan(0.005);
    }
  });

  it('default prices (where aspirational already meets margin): both modes return identical aspire-EV', () => {
    const lag = solveWeights({ ...BRONZE_INPUT, mode: 'lagrangian' });
    const tilt = solveWeights({ ...BRONZE_INPUT, mode: 'tilt' });
    expect(lag.evCents).toBe(tilt.evCents);
    for (const s of lag.slots) expect(s.tilt).toBe(1);
    for (const s of tilt.slots) expect(s.tilt).toBe(1);
  });
});

describe('solveWeights — determinism', () => {
  it('byte-identical JSON output across two invocations on the same input', () => {
    const r1 = solveWeights(BRONZE_INPUT);
    const r2 = solveWeights(BRONZE_INPUT);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('output EV equals computed EV from returned weights (no off-by-rounding)', () => {
    const result = solveWeights(BRONZE_INPUT);
    expect(result.status).toBe('ok');
    const recomputed = packEV(result.slots, RARITY_MEAN_CENTS);
    expect(Math.abs(result.evCents - recomputed)).toBeLessThan(1);
  });
});

describe('solveWeights — input validation', () => {
  it('throws when aspirational and floor lengths differ', () => {
    expect(() =>
      solveWeights({
        aspirational: aspireFor('BRONZE'),
        floor: floorFor('BRONZE').slice(0, 1),
        priceCents: 499,
        rarityMeanCents: RARITY_MEAN_CENTS,
        targetMargin: 0.3,
      }),
    ).toThrow(/lengths differ/);
  });

  it('throws when slot type or count mismatches between aspirational and floor', () => {
    const badFloor = floorFor('BRONZE').map((s, i) =>
      i === 0 ? { ...s, count: s.count + 1 } : s,
    );
    expect(() =>
      solveWeights({
        aspirational: aspireFor('BRONZE'),
        floor: badFloor,
        priceCents: 499,
        rarityMeanCents: RARITY_MEAN_CENTS,
        targetMargin: 0.3,
      }),
    ).toThrow(/mismatch/);
  });
});
