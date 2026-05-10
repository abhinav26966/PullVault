/**
 * Pearson chi-squared goodness-of-fit — Part B §13.
 *
 * Tests whether an observed discrete count vector is consistent with a
 * hypothesised expected count vector. The fairness tab feeds this with
 * (rarity_observed_counts, rarity_expected_counts_from_weights) per tier so
 * a third party can verify "the rolled-rarity distribution is statistically
 * indistinguishable from the published weights."
 *
 *   chi2 = Σ_i (obs_i - exp_i)² / exp_i,    df = k - 1
 *
 * p-value via the **Wilson–Hilferty cube-root transform**: chi2/df is
 * approximately N(1 - 2/(9*df), 2/(9*df))^(1/3) under H0, so
 *
 *   z = ((chi2/df)^(1/3) - (1 - 2/(9*df))) / sqrt(2/(9*df))
 *   p = 1 - Φ(z)
 *
 * Wilson–Hilferty is accurate to within ~0.005 across the practical df range
 * (df ≥ 2). It's the standard closed-form approximation when you don't want
 * to lug a chi2_cdf implementation around. Φ uses Abramowitz–Stegun 7.1.26.
 *
 * Pure module — no I/O, no dependencies. The fairness route imports it as
 * a function and runs it server-side; the result + raw inputs ship to the
 * client so a reviewer can plug the numbers into scipy and reproduce.
 */

export interface ChiSquaredInput {
  /** Observed counts per bucket. Length must equal `expected.length`. */
  readonly observed: readonly number[];
  /** Expected counts per bucket. All entries must be > 0. */
  readonly expected: readonly number[];
}

export interface ChiSquaredResult {
  readonly chiSq: number;
  readonly df: number;
  readonly pValue: number;
  /** Per-bucket residual term `(obs-exp)²/exp` — handy for the dashboard
   *  to surface which bucket is driving the chi² value. */
  readonly contributions: readonly number[];
}

const SQRT_2 = Math.sqrt(2);

/** Standard normal CDF Φ(z) via Abramowitz–Stegun 7.1.26 erf approximation.
 *  Maximum error ≈ 1.5e-7 over the entire real line — well below the 0.01
 *  tolerance the fairness tab cares about. */
function standardNormalCdf(z: number): number {
  // erf(z / sqrt(2))
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / SQRT_2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  const erf = sign * y;
  return 0.5 * (1 + erf);
}

/** chi² survival function via Wilson–Hilferty. p = P(X ≥ chiSq | df).
 *  df must be ≥ 1; chiSq must be ≥ 0. */
export function chiSquaredSurvival(chiSq: number, df: number): number {
  if (df < 1) throw new Error('chi-squared: df must be ≥ 1');
  if (chiSq < 0) throw new Error('chi-squared: chiSq must be ≥ 0');
  if (chiSq === 0) return 1;
  // Wilson-Hilferty.
  const a = Math.cbrt(chiSq / df);
  const b = 1 - 2 / (9 * df);
  const c = Math.sqrt(2 / (9 * df));
  const z = (a - b) / c;
  return 1 - standardNormalCdf(z);
}

export function chiSquared(input: ChiSquaredInput): ChiSquaredResult {
  const { observed, expected } = input;
  if (observed.length !== expected.length) {
    throw new Error('chi-squared: observed and expected must have equal length');
  }
  if (observed.length < 2) {
    throw new Error('chi-squared: need at least 2 buckets');
  }
  const contributions: number[] = [];
  let chiSq = 0;
  for (let i = 0; i < observed.length; i++) {
    const e = expected[i]!;
    const o = observed[i]!;
    if (e <= 0) {
      // The test is undefined when an expected bucket is zero. Two reasonable
      // ways to handle it: drop the bucket, or treat it as fatal. We treat
      // it as fatal — the dashboard surfaces a clear error rather than a
      // silently-skewed p-value.
      throw new Error(`chi-squared: expected[${i}] must be > 0 (got ${e})`);
    }
    const diff = o - e;
    const term = (diff * diff) / e;
    contributions.push(term);
    chiSq += term;
  }
  const df = observed.length - 1;
  const pValue = chiSquaredSurvival(chiSq, df);
  return { chiSq, df, pValue, contributions };
}
