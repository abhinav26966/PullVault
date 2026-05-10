import { describe, expect, it } from 'vitest';
import { kolmogorovSmirnov, kolmogorovSurvival } from '../stats/ks';

/**
 * Reference values for the asymptotic Kolmogorov distribution Q(λ):
 *
 *   λ = 0     → Q ≈ 1.0
 *   λ = 0.5   → Q ≈ 0.964
 *   λ = 1.0   → Q ≈ 0.270
 *   λ = 1.358 → Q ≈ 0.05  (the 5% critical value)
 *   λ = 1.628 → Q ≈ 0.01  (the 1% critical value)
 *   λ = 2.0   → Q ≈ 0.00067
 *
 * Critical values are the canonical K-S textbook table; intermediate values
 * sourced from scipy.stats.kstwobign.sf which is the same asymptotic
 * distribution.
 */

describe('kolmogorovSurvival — textbook values', () => {
  it('λ ≈ 0 → p ≈ 1', () => {
    expect(kolmogorovSurvival(0)).toBeCloseTo(1, 6);
    expect(kolmogorovSurvival(1e-9)).toBeCloseTo(1, 6);
  });

  it('λ = 1.0 → p ≈ 0.270', () => {
    expect(kolmogorovSurvival(1.0)).toBeCloseTo(0.27, 2);
  });

  it('λ = 1.358 (5% critical) → p ≈ 0.05', () => {
    expect(kolmogorovSurvival(1.358)).toBeCloseTo(0.05, 2);
  });

  it('λ = 1.628 (1% critical) → p ≈ 0.01', () => {
    expect(kolmogorovSurvival(1.628)).toBeCloseTo(0.01, 3);
  });

  it('p shrinks monotonically as λ grows', () => {
    const ps = [0.1, 0.5, 1.0, 1.5, 2.0].map(kolmogorovSurvival);
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i]!).toBeLessThanOrEqual(ps[i - 1]!);
    }
  });
});

describe('kolmogorovSmirnov — perfect-fit reference', () => {
  it('observed proportions exactly match expected weights → D=0, p=1', () => {
    // Counts of 50,30,15,4,1 normalize to weights 0.50,0.30,0.15,0.04,0.01 —
    // identical to the supplied expected weights. CDFs coincide everywhere.
    const r = kolmogorovSmirnov({
      observed: [50, 30, 15, 4, 1],
      expectedWeights: [0.5, 0.3, 0.15, 0.04, 0.01],
    });
    expect(r.d).toBeCloseTo(0, 12);
    expect(r.pValue).toBeCloseTo(1, 6);
    expect(r.n).toBe(100);
  });
});

describe('kolmogorovSmirnov — uniform-vs-shifted reference', () => {
  it('uniform observation against a heavily-tilted prior → D=0.3, λ=3, p≈0', () => {
    // n = 100, observed flat 20 each
    const r = kolmogorovSmirnov({
      observed: [20, 20, 20, 20, 20],
      expectedWeights: [0.4, 0.3, 0.2, 0.05, 0.05],
    });
    // F_obs cumulative: 0.2, 0.4, 0.6, 0.8, 1.0
    // F_exp cumulative: 0.4, 0.7, 0.9, 0.95, 1.0
    // gaps:             0.2, 0.3, 0.3, 0.15, 0.0  → D = 0.3
    expect(r.d).toBeCloseTo(0.3, 12);
    expect(r.lambda).toBeCloseTo(3, 9);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.cumulativeGaps[2]!).toBeCloseTo(0.3, 12);
  });

  it('mild deviation D=0.1 with n=100 → λ=1, p ≈ 0.27', () => {
    // Constructed so the max gap is exactly 0.1.
    const r = kolmogorovSmirnov({
      observed: [60, 20, 10, 5, 5],
      expectedWeights: [0.5, 0.3, 0.15, 0.04, 0.01],
    });
    expect(r.d).toBeCloseTo(0.1, 12);
    expect(r.lambda).toBeCloseTo(1, 6);
    expect(r.pValue).toBeCloseTo(0.27, 2);
  });
});

describe('kolmogorovSmirnov — input validation', () => {
  it('throws when observed and expectedWeights disagree in length', () => {
    expect(() =>
      kolmogorovSmirnov({ observed: [1, 2], expectedWeights: [0.5, 0.3, 0.2] }),
    ).toThrow();
  });

  it('throws on a single-bucket input', () => {
    expect(() =>
      kolmogorovSmirnov({ observed: [10], expectedWeights: [1] }),
    ).toThrow();
  });

  it('throws when total observed is 0', () => {
    expect(() =>
      kolmogorovSmirnov({ observed: [0, 0, 0], expectedWeights: [0.5, 0.3, 0.2] }),
    ).toThrow();
  });
});
