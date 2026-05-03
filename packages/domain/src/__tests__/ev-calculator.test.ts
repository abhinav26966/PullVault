import { describe, expect, it } from 'vitest';
import { computeTierEV } from '../ev-calculator';
import { RARITY_MEAN_CENTS } from '../tier-config';

/**
 * Per ARCHITECTURE §14.3 with the rarity means from §14.2:
 *
 *   Bronze: $3.05 EV, 38.9% margin (computed: 304.8 cents → rounded 305)
 *   Silver: $9.74 EV, 35.0% margin (computed: 974.25 → rounded 974)
 *   Gold:   spec lists $35.60 EV / 28.8% margin, but the per-slot numbers
 *           in the same section sum to $0.875 + $11.69 + $23.075 = $35.64.
 *           That's a documentation rounding inconsistency on the Gold
 *           total. The math is correct; this test asserts the actual
 *           computed value (3564 cents, ~28.7% margin) and flags the
 *           ARCH discrepancy in a comment for Phase 13's doc pass.
 */

describe('computeTierEV — values match ARCHITECTURE §14.3', () => {
  it('Bronze: 305 cents EV, ~38.9% margin', () => {
    const r = computeTierEV('BRONZE', RARITY_MEAN_CENTS);
    expect(Math.abs(r.evCents - 305)).toBeLessThanOrEqual(1);
    expect(r.marginPercent).toBeCloseTo(0.389, 2);
  });

  it('Silver: 974 cents EV, ~35.0% margin', () => {
    const r = computeTierEV('SILVER', RARITY_MEAN_CENTS);
    expect(Math.abs(r.evCents - 974)).toBeLessThanOrEqual(1);
    expect(r.marginPercent).toBeCloseTo(0.35, 2);
  });

  it('Gold: 3564 cents EV (ARCH §14.3 lists 3560 — doc has a 4¢ rounding artifact)', () => {
    const r = computeTierEV('GOLD', RARITY_MEAN_CENTS);
    expect(r.evCents).toBe(3564);
    // Margin is 1435/4999 ≈ 0.287 (ARCH spec text says 28.8%).
    expect(r.marginPercent).toBeCloseTo(0.287, 2);
  });

  it('uses provided rarity-mean map for live computation', () => {
    // Live mode: feed actual current avg prices per rarity bucket.
    const customMeans = { C: 10, U: 25, R: 100, E: 800, L: 6_000 } as const;
    const r = computeTierEV('BRONZE', customMeans);
    // Filler EV: 0.70*10 + 0.28*25 + 0.02*100 = 7 + 7 + 2 = 16. ×4 = 64.
    // Hit EV: 0.80*100 + 0.18*800 + 0.02*6000 = 80 + 144 + 120 = 344.
    // Total = 408.
    expect(r.evCents).toBe(408);
  });
});
