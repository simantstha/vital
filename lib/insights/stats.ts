/** Pure numerics for the insight engine. No domain knowledge, no I/O. */

export function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/** Sample standard deviation (n-1 denominator). Zero for n < 2. */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let sum = 0;
  for (const x of xs) sum += (x - m) ** 2;
  return Math.sqrt(sum / (xs.length - 1));
}

/** Natural log of the gamma function (Lanczos approximation). */
function logGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i += 1) x += g[i] / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized incomplete beta I_x(a, b) via Lentz's continued fraction. */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Use the symmetry relation where the continued fraction converges faster.
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);

  const front =
    Math.exp(a * Math.log(x) + b * Math.log(1 - x) + logGamma(a + b) - logGamma(a) - logGamma(b)) / a;

  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;

  // The loop starts at i = 2, NOT i = 1. The i = 1 term evaluates to
  // -((a+b)x)/(a+1), which is exactly what `d`'s initialization above already
  // folded in; recomputing it corrupts every subsequent convergent and makes
  // the result wrong by orders of magnitude in the tail. i = 2 yields
  // (b-1)x/((a+1)(a+2)), which is the first loop term in Numerical Recipes'
  // betacf. Verify any change here against an independent implementation.
  for (let i = 2; i <= 300; i += 1) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      numerator = (-((a + m) * (a + b + m)) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    }
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    const delta = c * d;
    result *= delta;
    if (Math.abs(1 - delta) < 1e-12) break;
  }

  return front * result;
}

/** Two-sided p-value for a Student t statistic. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  const p = incompleteBeta(x, df / 2, 0.5);
  return Math.min(1, Math.max(0, p));
}

export interface SlopeResult { slope: number; pValue: number; n: number; t: number }

/**
 * Ordinary least squares slope of ys on xs, with a two-sided t-test on the
 * slope. A degenerate fit (n < 3, zero variance in x, or a perfect fit with
 * zero residual variance) reports slope 0 / p 1 rather than NaN or a spurious
 * certainty — except a perfect non-flat fit, which is genuinely significant.
 */
export function olsSlope(xs: number[], ys: number[]): SlopeResult {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { slope: 0, pValue: 1, n, t: 0 };

  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return { slope: 0, pValue: 1, n, t: 0 };

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let residualSumSquares = 0;
  for (let i = 0; i < n; i += 1) {
    residualSumSquares += (ys[i] - (intercept + slope * xs[i])) ** 2;
  }

  if (residualSumSquares === 0) {
    return { slope, pValue: slope === 0 ? 1 : 0, n, t: 0 };
  }

  const df = n - 2;
  const standardError = Math.sqrt(residualSumSquares / df / sxx);
  const t = slope / standardError;
  return { slope, pValue: studentTTwoSidedP(t, df), n, t };
}

/**
 * Lag-1 autocorrelation. Returns 0 for series too short to estimate it, or with
 * no variance. Negative serial correlation is clamped to 0: it makes a test
 * conservative rather than anti-conservative, so there is nothing to correct.
 */
export function lag1Autocorrelation(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    const d = xs[i] - m;
    denominator += d * d;
    if (i < n - 1) numerator += d * (xs[i + 1] - m);
  }
  if (denominator === 0) return 0;
  const r = numerator / denominator;
  if (!Number.isFinite(r)) return 0;
  return Math.min(0.99, Math.max(0, r));
}

/**
 * Effective sample size under AR(1)-like serial dependence
 * (Bartlett / Bretherton): n_eff = n (1 - r) / (1 + r).
 *
 * Ninety consecutive daily health observations are not ninety independent ones.
 * Treating them as independent is exactly what let the null-data canary certify
 * 51-79% of pure noise. A random walk has r -> 1, so n_eff collapses and the
 * p-value goes to 1; i.i.d. data has r = 0 and is unaffected. Floored at 3 so
 * downstream degrees-of-freedom arithmetic stays defined.
 */
export function effectiveSampleSize(n: number, r: number): number {
  if (n <= 0) return 0;
  const clamped = Math.min(0.99, Math.max(0, r));
  return Math.max(3, (n * (1 - clamped)) / (1 + clamped));
}

/**
 * Effective sample size for a correlation between two autocorrelated series
 * (Quenouille / Bartlett pair form): n_eff = n (1 - rx ry) / (1 + rx ry).
 * Note the product: a correlation is only inflated when BOTH series carry
 * serial structure, so pairing an i.i.d. series with a random walk costs
 * nothing.
 */
export function effectiveSampleSizePair(n: number, rx: number, ry: number): number {
  if (n <= 0) return 0;
  const product = Math.min(0.99, Math.max(0, rx * ry));
  return Math.max(3, (n * (1 - product)) / (1 + product));
}

/** Ranks with average ranks for ties (1-indexed). */
export function ranks(xs: number[]): number[] {
  const indexed = xs.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const averageRank = (i + j + 2) / 2; // ranks are 1-indexed
    for (let k = i; k <= j; k += 1) out[indexed[k].index] = averageRank;
    i = j + 1;
  }
  return out;
}

export interface CorrelationResult { rho: number; pValue: number; n: number }

/**
 * Spearman rank correlation with a t-approximation p-value. Rank correlation
 * rather than Pearson because health series are non-normal and outlier-prone.
 */
export function spearman(xs: number[], ys: number[]): CorrelationResult {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { rho: 0, pValue: 1, n };

  const rx = ranks(xs.slice(0, n));
  const ry = ranks(ys.slice(0, n));
  const mx = mean(rx);
  const my = mean(ry);

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return { rho: 0, pValue: 1, n };

  const rho = sxy / Math.sqrt(sxx * syy);
  if (Math.abs(rho) >= 1) return { rho, pValue: 0, n };

  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return { rho, pValue: studentTTwoSidedP(t, n - 2), n };
}

/** Chi-square survival function, exact closed form for even df only. */
function chiSquareSurvivalEvenDf(x: number, df: number): number {
  if (x <= 0) return 1;
  const m = df / 2;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < m; k += 1) {
    term *= x / 2 / k;
    sum += term;
  }
  return Math.min(1, Math.max(0, Math.exp(-x / 2) * sum));
}

export interface KruskalResult { h: number; pValue: number; n: number }

/**
 * Kruskal–Wallis across exactly seven weekday groups, with tie correction.
 * Requiring all seven groups fixes df at 6, so the chi-square survival
 * function has an exact closed form and no incomplete-gamma routine is
 * needed. Any other shape reports p = 1 (no finding).
 */
export function kruskalWallisSevenGroups(groups: number[][]): KruskalResult {
  if (groups.length !== 7 || groups.some((g) => g.length === 0)) {
    return { h: 0, pValue: 1, n: 0 };
  }

  const all = groups.flat();
  const n = all.length;
  if (n < 14) return { h: 0, pValue: 1, n };

  const allRanks = ranks(all);

  let offset = 0;
  let weighted = 0;
  for (const group of groups) {
    let groupRankSum = 0;
    for (let i = 0; i < group.length; i += 1) groupRankSum += allRanks[offset + i];
    weighted += (groupRankSum * groupRankSum) / group.length;
    offset += group.length;
  }

  let h = (12 / (n * (n + 1))) * weighted - 3 * (n + 1);

  // Tie correction: divide by 1 - Σ(t³ - t) / (n³ - n).
  const counts = new Map<number, number>();
  for (const value of all) counts.set(value, (counts.get(value) ?? 0) + 1);
  let tieSum = 0;
  for (const count of counts.values()) if (count > 1) tieSum += count ** 3 - count;
  const correction = 1 - tieSum / (n ** 3 - n);
  if (correction > 0) h /= correction;

  if (!Number.isFinite(h) || h <= 0) return { h: 0, pValue: 1, n };
  return { h, pValue: chiSquareSurvivalEvenDf(h, 6), n };
}

/**
 * Benjamini–Hochberg step-up procedure. Returns, in input order, whether each
 * p-value is rejected (i.e. is a discovery) at false-discovery rate q.
 *
 * This is the single most important function in the engine: it is what stops
 * a sweep of ~150 hypotheses from reporting its expected crop of noise as
 * insight.
 */
export function benjaminiHochberg(pValues: number[], q: number): boolean[] {
  const m = pValues.length;
  if (m === 0) return [];

  const ordered = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p);

  // Largest k such that p_(k) <= (k/m) * q; reject all ranks up to it.
  let maxK = 0;
  for (let k = 1; k <= m; k += 1) {
    if (ordered[k - 1].p <= (k / m) * q) maxK = k;
  }

  const out = new Array<boolean>(m).fill(false);
  for (let k = 0; k < maxK; k += 1) out[ordered[k].index] = true;
  return out;
}
