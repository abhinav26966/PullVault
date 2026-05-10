import { describe, expect, it } from 'vitest';
import {
  chiSquared,
  chiSquaredSurvival,
} from '../stats/chi-squared';

/**
 * Textbook reference values. Wilson–Hilferty is an *approximation* — its
 * worst-case error for moderate df is ~0.005 — so the assertions use a 0.01
 * tolerance against the exact scipy `scipy.stats.chi2.sf(x, df)` outputs.
 *
 * scipy reproduction:
 *   from scipy.stats import chi2
 *   chi2.sf(0.0, 4)   # → 1.0
 *   chi2.sf(0.8, 4)   # → 0.93845...
 *   chi2.sf(10.0, 4)  # → 0.04042...
 *   chi2.sf(20.0, 4)  # → 0.000497...
 */

describe('chiSquaredSurvival — textbook values', () => {
  it('returns 1 when chi² = 0 (perfect fit)', () => {
    expect(chiSquaredSurvival(0, 4)).toBe(1);
  });

  it('chi²=0.8, df=4 → p ≈ 0.93845', () => {
    expect(chiSquaredSurvival(0.8, 4)).toBeCloseTo(0.93845, 2);
  });

  it('chi²=10, df=4 → p ≈ 0.04042 (significant)', () => {
    expect(chiSquaredSurvival(10, 4)).toBeCloseTo(0.04042, 2);
  });

  it('chi²=20, df=4 → p ≈ 0.0005 (highly significant)', () => {
    const p = chiSquaredSurvival(20, 4);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.01);
  });

  it('p decreases monotonically as chi² grows for fixed df', () => {
    const ps = [0, 1, 2, 5, 10, 20].map((x) => chiSquaredSurvival(x, 4));
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i]!).toBeLessThan(ps[i - 1]!);
    }
  });
});

describe('chiSquared — 5-bucket gambling-die fairness test', () => {
  it('perfect uniform observation → chi²=0, p=1', () => {
    const r = chiSquared({
      observed: [10, 10, 10, 10, 10],
      expected: [10, 10, 10, 10, 10],
    });
    expect(r.chiSq).toBe(0);
    expect(r.df).toBe(4);
    expect(r.pValue).toBe(1);
  });

  it('mild deviation → chi²=0.8, p ≈ 0.94', () => {
    const r = chiSquared({
      observed: [12, 8, 10, 10, 10],
      expected: [10, 10, 10, 10, 10],
    });
    expect(r.chiSq).toBeCloseTo(0.8, 9);
    expect(r.df).toBe(4);
    expect(r.pValue).toBeCloseTo(0.93845, 2);
    expect(r.contributions).toEqual([0.4, 0.4, 0, 0, 0]);
  });

  it('loaded-die deviation → chi²=10, p ≈ 0.04 (significant at α=0.05)', () => {
    const r = chiSquared({
      observed: [5, 15, 5, 15, 10],
      expected: [10, 10, 10, 10, 10],
    });
    expect(r.chiSq).toBe(10);
    expect(r.pValue).toBeCloseTo(0.04042, 2);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('exposes per-bucket contributions for the dashboard', () => {
    const r = chiSquared({
      observed: [20, 0, 20, 0, 10],
      expected: [10, 10, 10, 10, 10],
    });
    // Each contributing term: (10²/10), (10²/10), (10²/10), (10²/10), 0 = 10+10+10+10+0=40
    expect(r.contributions).toEqual([10, 10, 10, 10, 0]);
    expect(r.chiSq).toBe(40);
  });
});

describe('chiSquared — input validation', () => {
  it('throws when expected and observed length disagree', () => {
    expect(() => chiSquared({ observed: [1, 2], expected: [1, 2, 3] })).toThrow();
  });

  it('throws on a single-bucket input (df would be 0)', () => {
    expect(() => chiSquared({ observed: [10], expected: [10] })).toThrow();
  });

  it('throws when any expected count is zero (test undefined)', () => {
    expect(() =>
      chiSquared({ observed: [10, 0, 10], expected: [10, 0, 10] }),
    ).toThrow(/expected\[1\]/);
  });
});
