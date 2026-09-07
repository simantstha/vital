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

  for (let i = 1; i <= 300; i += 1) {
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

  return front * (result - 1);
}

/** Two-sided p-value for a Student t statistic. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  const p = incompleteBeta(x, df / 2, 0.5);
  return Math.min(1, Math.max(0, Math.abs(p)));
}

export interface SlopeResult { slope: number; pValue: number; n: number }

/**
 * Ordinary least squares slope of ys on xs, with a two-sided t-test on the
 * slope. A degenerate fit (n < 3, zero variance in x, or a perfect fit with
 * zero residual variance) reports slope 0 / p 1 rather than NaN or a spurious
 * certainty — except a perfect non-flat fit, which is genuinely significant.
 */
export function olsSlope(xs: number[], ys: number[]): SlopeResult {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { slope: 0, pValue: 1, n };

  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return { slope: 0, pValue: 1, n };

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let residualSumSquares = 0;
  for (let i = 0; i < n; i += 1) {
    residualSumSquares += (ys[i] - (intercept + slope * xs[i])) ** 2;
  }

  if (residualSumSquares === 0) {
    return { slope, pValue: slope === 0 ? 1 : 0, n };
  }

  const df = n - 2;
  const standardError = Math.sqrt(residualSumSquares / df / sxx);
  const t = slope / standardError;
  return { slope, pValue: studentTTwoSidedP(t, df), n };
}
