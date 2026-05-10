/**
 * Kolmogorov–Smirnov one-sample goodness-of-fit — Part B §13.
 *
 * Secondary fairness test alongside chi-squared. Where chi-squared sums the
 * per-bucket squared residual, K-S takes the maximum gap between the
 * observed empirical CDF and the hypothesised CDF.
 *
 *   F_obs(b) = (Σ_{i ≤ b} obs_i) / N
 *   F_exp(b) = Σ_{i ≤ b} expected_weight_i
 *   D = max_b |F_obs(b) - F_exp(b)|
 *   λ = D * sqrt(N)
 *
 * Bucket order matters because K-S walks an explicit sequence — for the
 * fairness tab we order C → U → R → E → L (rarity ascending). The caller
 * supplies the arrays in that order.
 *
 * Asymptotic p-value via the Kolmogorov distribution:
 *
 *   Q(λ) = 2 * Σ_{k=1..∞} (-1)^(k-1) * exp(-2 k² λ²)
 *
 * The series alternates and converges fast for λ ≥ 0.5 (e^(-2) → e^(-8) →
 * e^(-18) drops 4 orders per term). For λ < ~0.18 the asymptotic
 * approximation breaks down — we cap at 1 below a small λ threshold.
 *
 * Pure module — same-library policy as chi-squared. Used both server-side
 * (fairness API route) and shippable to the client if we ever want a live
 * recompute. No DB or fetch calls inside.
 */

export interface KsInput {
  /** Observed counts per bucket, in the same order as `expectedWeights`. */
  readonly observed: readonly number[];
  /** Expected weights summing to ~1.0, in matched bucket order. */
  readonly expectedWeights: readonly number[];
}

export interface KsResult {
  readonly d: number;
  readonly lambda: number;
  readonly n: number;
  readonly pValue: number;
  /** Per-bucket cumulative gap |F_obs(b) - F_exp(b)| for surfacing in the UI. */
  readonly cumulativeGaps: readonly number[];
}

const LAMBDA_MIN = 1e-6; // below this, p ≈ 1 to double precision

/** Q(λ) = P(D * sqrt(n) ≥ λ | H0) under the asymptotic Kolmogorov law.
 *  Sums until the next term is < 1e-12 or 100 terms — whichever first. */
export function kolmogorovSurvival(lambda: number): number {
  if (lambda < 0) throw new Error('K-S: lambda must be ≥ 0');
  if (lambda < LAMBDA_MIN) return 1;
  let q = 0;
  for (let k = 1; k < 100; k++) {
    const term = 2 * (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda);
    q += term;
    if (Math.abs(term) < 1e-12) break;
  }
  // Numerical-safety clamp — series can drift a hair above 1 or below 0
  // for extreme λ before convergence.
  if (q < 0) return 0;
  if (q > 1) return 1;
  return q;
}

export function kolmogorovSmirnov(input: KsInput): KsResult {
  const { observed, expectedWeights } = input;
  if (observed.length !== expectedWeights.length) {
    throw new Error('K-S: observed and expectedWeights must have equal length');
  }
  if (observed.length < 2) {
    throw new Error('K-S: need at least 2 buckets');
  }
  const n = observed.reduce((a, b) => a + b, 0);
  if (n <= 0) throw new Error('K-S: total observed count must be > 0');

  let cumObs = 0;
  let cumExp = 0;
  const cumulativeGaps: number[] = [];
  let d = 0;
  for (let i = 0; i < observed.length; i++) {
    cumObs += observed[i]! / n;
    cumExp += expectedWeights[i]!;
    const gap = Math.abs(cumObs - cumExp);
    cumulativeGaps.push(gap);
    if (gap > d) d = gap;
  }

  const lambda = d * Math.sqrt(n);
  const pValue = kolmogorovSurvival(lambda);
  return { d, lambda, n, pValue, cumulativeGaps };
}
