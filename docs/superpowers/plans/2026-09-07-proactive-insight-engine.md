# Proactive Insight Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Vital a trigger class for *absence* and *change*, so the coach can speak because you stopped training or because a pattern shifted — not only because an event landed or a clock struck.

**Architecture:** Two layers. A deterministic statistical battery runs generically over `daily_metrics`, gated by Benjamini–Hochberg FDR, a minimum effect size, and cross-run confirmation. An LLM then receives only the certified findings — never a raw series, never asked to find anything — and voices one. Delivery reuses the existing APNs path in `proactiveHealthWorker.ts` and finally wires up `pending_nudges`.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM + Postgres, `node:test` (built-in runner), Anthropic SDK, APNs, SwiftUI (iOS).

**Spec:** `docs/superpowers/specs/2026-09-07-proactive-insight-engine-design.md` — read it before starting. The plan argues from the spec.

## Global Constraints

- **Never run `drizzle-kit push`.** Schema changes ship as generated migration files: edit `db/schema.ts`, run `npx drizzle-kit generate`, commit the file under `db/migrations/`. Migrations must be additive-safe (old code runs against the new schema during the deploy window).
- **Never zero-fill a gap.** A missing day is not a measured zero. Every series carries explicit present/absent days.
- **Silence is a valid output.** No "not enough data yet" pushes. If nothing survives the gates, or the model fails, send nothing.
- **Findings that fail a gate are dropped, not downgraded.** There is no low-confidence tier.
- **Test runner:** `npm test` runs `node --import tsx --experimental-test-module-mocks --test`. Single file: `node --import tsx --test <path>`. Tests are colocated (`lib/insights/stats.test.ts`), use `node:assert/strict` and `node:test`, matching `lib/streak.test.ts`.
- **Statistical defaults:** BH at q = 0.10; `levelShift` |d| ≥ 0.8; `crossLag` |ρ| ≥ 0.35 with ≥30 pairs; `trend` ≥20 observed days; `dayOfWeek` ≥8 weeks; `cadenceBreak` established at ≥3/week over 28 days.
- **Delivery caps:** 1 nudge/day, 3/week, 14-day cooldown per finding kind.
- **Orchestration:** the highest-tier model does not write code. Implementation is delegated per `AI_COMMON.md`.

## File Structure

| File | Responsibility |
|---|---|
| `lib/insights/types.ts` | `Finding`, `MetricSeries`, `DayPoint`, `FindingKind`. No logic. |
| `lib/insights/stats.ts` | Pure numerics: descriptives, ranks, OLS slope, t/χ² p-values, Spearman, Kruskal–Wallis, Benjamini–Hochberg. No domain knowledge. |
| `lib/insights/series.ts` | Loads metric series from `daily_metrics`, gaps preserved. Only DB-touching module in Layer 1. |
| `lib/insights/detectors.ts` | The generic battery. Pure functions, series in → `Finding[]` out. |
| `lib/insights/evidence.ts` | The gate: per-detector rules, BH family correction, effect floor, established-baseline filter. |
| `lib/insights/confirmation.ts` | Cross-run persistence and confirmation against the previous run. |
| `lib/insights/arbiter.ts` | Deterministic shortlist of ≤3, with novelty and cooldown. |
| `lib/insights/voice.ts` | Builds the LLM request from certified findings; parses/validates output. |
| `lib/insights/nudgeWorker.ts` | Orchestration + delivery caps. Called from the existing worker tick. |
| `db/schema.ts` | Adds `insight_findings`; adds `finding_kind` to `pending_nudges`. |
| `scripts/proactive-health-worker.ts` | New stage in `tick()`. |
| `app/api/coach/route.ts` | Accepts a `findingId` so the chat opens with the finding in context. |
| iOS | Nudge deep link → coach chat, pre-seeded. |

---

## Task 1: Statistical primitives — descriptives and the t-distribution

**Files:**
- Create: `lib/insights/stats.ts`
- Test: `lib/insights/stats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `mean(xs: number[]): number`, `sd(xs: number[]): number`, `olsSlope(xs: number[], ys: number[]): { slope: number; pValue: number; n: number }`, `studentTTwoSidedP(t: number, df: number): number`.

**Why an exact t-distribution and not a normal approximation:** p-values feed Benjamini–Hochberg, which ranks them against each other. A normal approximation is wrong in exactly the tail BH cares about, so borderline findings would be mis-ranked. `studentTTwoSidedP` uses the regularized incomplete beta via Lentz's continued fraction — a standard ~40-line routine.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { mean, sd, olsSlope, studentTTwoSidedP } from './stats';

test('mean and sd match hand-computed values', () => {
  assert.equal(mean([2, 4, 6]), 4);
  // sample sd (n-1 denominator) of [2,4,6] is 2
  assert.equal(sd([2, 4, 6]), 2);
});

test('sd of a constant series is zero', () => {
  assert.equal(sd([5, 5, 5, 5]), 0);
});

test('two-sided t p-value matches known reference values', () => {
  // t=2.228, df=10 is the classic 0.05 two-sided critical value
  assert.ok(Math.abs(studentTTwoSidedP(2.228, 10) - 0.05) < 0.001);
  // t=0 is maximally unsurprising
  assert.equal(studentTTwoSidedP(0, 10), 1);
  // large t is vanishingly unlikely
  assert.ok(studentTTwoSidedP(10, 10) < 1e-5);
});

test('olsSlope recovers a planted slope and calls it significant', () => {
  const xs = Array.from({ length: 30 }, (_, i) => i);
  const ys = xs.map((x) => 3 * x + 10);
  const result = olsSlope(xs, ys);
  assert.ok(Math.abs(result.slope - 3) < 1e-9);
  assert.ok(result.pValue < 0.001);
  assert.equal(result.n, 30);
});

test('t p-values are correct at realistic degrees of freedom, not just df=10', () => {
  // The perfect-fit tests below short-circuit before studentTTwoSidedP is ever
  // called, so without these the safety-critical tail behaviour is exercised at
  // exactly one point. Reference values from the standard incomplete beta.
  assert.ok(Math.abs(studentTTwoSidedP(1, 1) - 0.5) < 0.001);        // Cauchy, exact 0.5
  assert.ok(Math.abs(studentTTwoSidedP(2, 20) - 0.0593) < 0.001);
  assert.ok(Math.abs(studentTTwoSidedP(4, 100) - 0.000121) < 0.00002);
  assert.ok(Math.abs(studentTTwoSidedP(50, 1) - 0.0127) < 0.001);
});

test('olsSlope on a flat series reports no significant trend', () => {
  const xs = Array.from({ length: 30 }, (_, i) => i);
  const ys = xs.map(() => 42);
  const result = olsSlope(xs, ys);
  assert.equal(result.slope, 0);
  assert.equal(result.pValue, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/stats.test.ts`
Expected: FAIL — cannot find module `./stats`.

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/stats.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/stats.ts lib/insights/stats.test.ts
git commit -m "feat(insights): add descriptive stats and an exact t-distribution"
```

---

## Task 2: Statistical primitives — rank correlation, Kruskal–Wallis, FDR

**Files:**
- Modify: `lib/insights/stats.ts`
- Test: `lib/insights/stats.test.ts` (append)

**Interfaces:**
- Consumes: `mean`, `studentTTwoSidedP` from Task 1.
- Produces: `ranks(xs: number[]): number[]`, `spearman(xs: number[], ys: number[]): { rho: number; pValue: number; n: number }`, `kruskalWallisSevenGroups(groups: number[][]): { h: number; pValue: number; n: number }`, `benjaminiHochberg(pValues: number[], q: number): boolean[]`.

**Two notes on method:**

Spearman rather than Pearson because health series are non-normal and outlier-prone; rank correlation degrades gracefully where Pearson does not. Ties get average ranks.

`kruskalWallisSevenGroups` deliberately requires **all seven weekdays present**, which fixes df at 6. For even df the χ² survival function has an exact closed form — `exp(-x/2) · Σ_{k=0}^{m-1} (x/2)^k / k!` with m = df/2 — so this needs no general incomplete-gamma routine. Callers must supply exactly 7 non-empty groups; anything else reports p = 1.

- [ ] **Step 1: Write the failing test**

```typescript
import { ranks, spearman, kruskalWallisSevenGroups, benjaminiHochberg } from './stats';

test('ranks assign average ranks to ties', () => {
  assert.deepEqual(ranks([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test('spearman is 1 for a monotonic relationship even when nonlinear', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = xs.map((x) => x ** 3);
  const result = spearman(xs, ys);
  assert.ok(Math.abs(result.rho - 1) < 1e-9);
  assert.ok(result.pValue < 0.01);
});

test('spearman is near zero and insignificant for unrelated series', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = [5, 1, 8, 2, 7, 3, 6, 4];
  const result = spearman(xs, ys);
  assert.ok(Math.abs(result.rho) < 0.5);
  assert.ok(result.pValue > 0.1);
});

test('kruskal-wallis requires exactly seven non-empty groups', () => {
  const six = Array.from({ length: 6 }, () => [1, 2, 3]);
  assert.equal(kruskalWallisSevenGroups(six).pValue, 1);
  const withEmpty = Array.from({ length: 7 }, (_, i) => (i === 3 ? [] : [1, 2, 3]));
  assert.equal(kruskalWallisSevenGroups(withEmpty).pValue, 1);
});

test('kruskal-wallis finds a planted weekday effect and ignores a flat one', () => {
  const flat = Array.from({ length: 7 }, () => [10, 11, 12, 13, 14, 15, 16, 17]);
  assert.ok(kruskalWallisSevenGroups(flat).pValue > 0.2);

  const shifted = Array.from({ length: 7 }, (_, day) =>
    day === 0 ? [90, 91, 92, 93, 94, 95, 96, 97] : [10, 11, 12, 13, 14, 15, 16, 17],
  );
  assert.ok(kruskalWallisSevenGroups(shifted).pValue < 0.01);
});

test('benjamini-hochberg rejects the clearly significant and keeps noise out', () => {
  const pValues = [0.001, 0.002, 0.2, 0.5, 0.9];
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), [true, true, false, false, false]);
});

test('benjamini-hochberg rejects nothing in a uniform (pure noise) family', () => {
  // Under the null, p-values are uniform on [0,1]. This is the shape a noise
  // sweep actually produces, and nothing in it should be called a discovery.
  const pValues = Array.from({ length: 20 }, (_, i) => (i + 1) / 20);
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), Array.from({ length: 20 }, () => false));
});

test('benjamini-hochberg is stricter than an uncorrected threshold', () => {
  // A lone p = 0.04 clears an uncorrected 0.05 but must NOT clear BH at m = 20.
  const pValues = [0.04, ...Array.from({ length: 19 }, (_, i) => 0.5 + i / 100)];
  assert.equal(benjaminiHochberg(pValues, 0.1)[0], false);
});

test('benjamini-hochberg does reject when the whole family is implausible', () => {
  // Twenty p-values at 0.04 when ~1 is expected IS collective evidence, and BH
  // correctly rejects them. Pinned so nobody "fixes" the procedure toward
  // always-reject or always-abstain.
  const pValues = Array.from({ length: 20 }, () => 0.04);
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), Array.from({ length: 20 }, () => true));
});

test('benjamini-hochberg preserves input order in its output', () => {
  const pValues = [0.9, 0.001, 0.5];
  assert.deepEqual(benjaminiHochberg(pValues, 0.1), [false, true, false]);
});

test('benjamini-hochberg on an empty family returns an empty array', () => {
  assert.deepEqual(benjaminiHochberg([], 0.1), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/stats.test.ts`
Expected: FAIL — `ranks` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/insights/stats.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/stats.test.ts`
Expected: PASS, 17 tests (6 from Task 1, 11 added here).

- [ ] **Step 5: Commit**

```bash
git add lib/insights/stats.ts lib/insights/stats.test.ts
git commit -m "feat(insights): add Spearman, Kruskal-Wallis, and BH-FDR control"
```

---

## Task 3: Shared types

**Files:**
- Create: `lib/insights/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FindingKind`, `DayPoint`, `MetricSeries`, `Finding`, `CertifiedFinding`.

No tests — this file is type declarations and one pure helper that Task 4 tests
through `series.ts`. Fold the commit into Task 4 if you prefer; it is listed
separately only so later tasks can quote exact field names.

- [ ] **Step 1: Write the file**

```typescript
/** Shared shapes for the insight engine. */

export type FindingKind = 'cadence_break' | 'level_shift' | 'trend' | 'cross_lag' | 'day_of_week';

/** One local day. `value` is null when the day exists in the window but has
 *  no observation — absence is never coerced to zero. */
export interface DayPoint {
  date: string;        // 'YYYY-MM-DD', the user's local day
  value: number | null;
}

export interface MetricSeries {
  metric: string;
  points: DayPoint[];  // dense over the window, ascending by date, nulls preserved
}

/**
 * A candidate produced by a detector, before any gating.
 *
 * `signature` is the stable identity of the claim (kind + metrics + direction),
 * used for cross-run confirmation and cooldown. It must NOT include the effect
 * size, or the same finding would get a new identity every day as the number
 * drifts.
 *
 * `pValue` is null for rule-shaped findings (cadence_break), which are not
 * hypothesis tests and must not enter the FDR family.
 */
export interface Finding {
  kind: FindingKind;
  signature: string;
  metrics: string[];
  effect: number;          // signed, in the detector's natural units
  effectLabel: string;     // human-readable magnitude, e.g. '1.4 SD below baseline'
  n: number;               // observations behind the claim
  pValue: number | null;
  detail: Record<string, string | number>;  // grounded facts the voice layer may cite
}

/** A finding that has passed every gate and is allowed to be spoken about. */
export interface CertifiedFinding extends Finding {
  confirmedOnRuns: number; // >= 2 by construction
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors from `lib/insights/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/insights/types.ts
git commit -m "feat(insights): add shared finding and series types"
```

---

## Task 4: Schema — `insight_findings` and `pending_nudges.finding_kind`

**Files:**
- Modify: `db/schema.ts`
- Create: `db/migrations/<generated>.sql` (produced by drizzle-kit, do not hand-write the filename)

**Interfaces:**
- Produces: `schema.insight_findings`, `schema.pending_nudges.finding_kind`.

**Why a new table:** cross-run confirmation requires knowing what the *previous*
run found. `pending_nudges` only records what was actually sent, which is at most
one finding per day — it cannot answer "did we also see this yesterday?" for the
findings we stayed quiet about. `insight_findings` is that memory.

**Why `finding_kind` on `pending_nudges`:** the 14-day per-kind cooldown is a
hot query on every run. A JSONB probe into `payload` can't use an index; a
column can.

⚠️ **`drizzle-kit push` is forbidden** (two production incidents). Generate a
migration file and commit it.

- [ ] **Step 1: Add the table and column to `db/schema.ts`**

Add next to the existing `pending_nudges` block:

```typescript
// ─── insight_findings ────────────────────────────────────────────────────────
// Per-run memory for the proactive insight engine. Every finding that survives
// the statistical gates is recorded here, whether or not it was ever spoken
// aloud, so the next run can require a finding to persist across two
// consecutive runs before it becomes eligible. Running the battery daily is
// itself repeated testing; without cross-run confirmation a borderline finding
// eventually surfaces by chance.

export const insight_findings = p.pgTable('insight_findings', {
  id:           p.uuid('id').primaryKey().defaultRandom(),
  user_id:      p.uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  signature:    p.text('signature').notNull(),          // stable identity: kind + metrics + direction
  kind:         p.text('kind').notNull(),
  computed_for: p.text('computed_for').notNull(),       // the user's local day, 'YYYY-MM-DD'
  payload:      p.jsonb('payload').notNull(),           // effect, n, pValue, detail
  created_at:   p.timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  p.uniqueIndex('insight_findings_user_signature_day_idx').on(t.user_id, t.signature, t.computed_for),
  p.index('insight_findings_user_signature_idx').on(t.user_id, t.signature),
]);
```

Add to the `pending_nudges` column list:

```typescript
  finding_kind:  p.text('finding_kind'),                                         // nullable: no rows exist yet
```

Add to the `pending_nudges` index list:

```typescript
  p.index('pending_nudges_user_kind_sent_idx').on(t.user_id, t.finding_kind, t.sent_at),
```

Add near the other type exports at the bottom of the file:

```typescript
export type InsightFinding    = typeof insight_findings.$inferSelect;
export type NewInsightFinding = typeof insight_findings.$inferInsert;
```

`finding_kind` is deliberately **nullable** so the migration is additive-safe:
no backfill is needed and old code keeps working during the deploy window.
`pending_nudges` has never been written to, so there are no rows to migrate.

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new file under `db/migrations/` plus an updated journal entry.

- [ ] **Step 3: Inspect the generated SQL**

Read the generated file. Confirm it contains only `CREATE TABLE`, `ADD COLUMN`,
and `CREATE INDEX` statements. **If it contains any `DROP`, stop and report it** —
that means the schema drifted and the migration would destroy data.

- [ ] **Step 4: Commit**

```bash
git add db/schema.ts db/migrations
git commit -m "feat(insights): add insight_findings and pending_nudges.finding_kind"
```

---

## Task 5: Series loading with gaps preserved

**Files:**
- Create: `lib/insights/series.ts`
- Test: `lib/insights/series.test.ts`

**Interfaces:**
- Consumes: `MetricSeries`, `DayPoint` from Task 3.
- Produces: `densify(rows: { date: string; value: number }[], startDay: string, endDay: string): DayPoint[]`, `loadSeries(userId: string, metrics: string[], endDay: string, windowDays: number): Promise<MetricSeries[]>`, `INSIGHT_WINDOW_DAYS = 90`.

`densify` is the pure, testable core; `loadSeries` is the thin DB wrapper around
it. Test `densify` directly — do not stand up a database for this.

**The rule this file exists to enforce:** a day with no observation becomes
`value: null`, never `0`. Zero-filling turned an unreadable HealthKit permission
into fabricated data once already; every detector downstream depends on being
able to tell "no data" from "a real zero".

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { densify } from './series';

test('densify preserves gaps as null rather than zero', () => {
  const points = densify(
    [{ date: '2026-09-01', value: 10 }, { date: '2026-09-04', value: 40 }],
    '2026-09-01',
    '2026-09-05',
  );
  assert.deepEqual(points, [
    { date: '2026-09-01', value: 10 },
    { date: '2026-09-02', value: null },
    { date: '2026-09-03', value: null },
    { date: '2026-09-04', value: 40 },
    { date: '2026-09-05', value: null },
  ]);
});

test('densify keeps a genuine zero distinct from a gap', () => {
  const points = densify([{ date: '2026-09-02', value: 0 }], '2026-09-01', '2026-09-02');
  assert.equal(points[0].value, null);
  assert.equal(points[1].value, 0);
});

test('densify returns ascending dates and ignores rows outside the window', () => {
  const points = densify(
    [{ date: '2026-08-01', value: 1 }, { date: '2026-09-02', value: 2 }],
    '2026-09-01',
    '2026-09-03',
  );
  assert.deepEqual(points.map((p) => p.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(points.map((p) => p.value), [null, 2, null]);
});

test('densify spans a month boundary correctly', () => {
  const points = densify([], '2026-08-30', '2026-09-02');
  assert.deepEqual(points.map((p) => p.date), ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/series.test.ts`
Expected: FAIL — cannot find module `./series`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { and, eq, gte, inArray, lte } from 'drizzle-orm';

import { db, schema } from '@/db';
import type { DayPoint, MetricSeries } from './types';

/** Rolling window the battery analyses. */
export const INSIGHT_WINDOW_DAYS = 90;

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Expands sparse rows into one point per day across [startDay, endDay].
 *
 * A day with no row becomes `value: null`. It is NEVER zero-filled — absence is
 * not a measured zero, and every detector downstream relies on telling them
 * apart.
 */
export function densify(
  rows: { date: string; value: number }[],
  startDay: string,
  endDay: string,
): DayPoint[] {
  const byDate = new Map<string, number>();
  for (const row of rows) byDate.set(row.date, row.value);

  const points: DayPoint[] = [];
  for (let day = startDay; day <= endDay; day = addDays(day, 1)) {
    const value = byDate.get(day);
    points.push({ date: day, value: value === undefined ? null : value });
  }
  return points;
}

/** Loads dense series for the given metrics over the window ending at endDay. */
export async function loadSeries(
  userId: string,
  metrics: string[],
  endDay: string,
  windowDays: number = INSIGHT_WINDOW_DAYS,
): Promise<MetricSeries[]> {
  if (metrics.length === 0) return [];
  const startDay = addDays(endDay, -(windowDays - 1));

  const rows = await db
    .select({
      metric: schema.daily_metrics.metric,
      date: schema.daily_metrics.date,
      value: schema.daily_metrics.value,
    })
    .from(schema.daily_metrics)
    .where(and(
      eq(schema.daily_metrics.user_id, userId),
      inArray(schema.daily_metrics.metric, metrics),
      gte(schema.daily_metrics.date, startDay),
      lte(schema.daily_metrics.date, endDay),
    ));

  const grouped = new Map<string, { date: string; value: number }[]>();
  for (const metric of metrics) grouped.set(metric, []);
  for (const row of rows) {
    // `date` columns come back as 'YYYY-MM-DD' strings from postgres.js.
    grouped.get(row.metric)?.push({ date: String(row.date), value: Number(row.value) });
  }

  return metrics.map((metric) => ({
    metric,
    points: densify(grouped.get(metric) ?? [], startDay, endDay),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/series.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/series.ts lib/insights/series.test.ts
git commit -m "feat(insights): load metric series with gaps preserved as null"
```

---

## Task 6: Detector — cadence break (the absence trigger)

**Files:**
- Create: `lib/insights/detectors.ts`
- Test: `lib/insights/detectors.test.ts`

**Interfaces:**
- Consumes: `MetricSeries`, `Finding` (Task 3).
- Produces: `CADENCE_METRICS: string[]`, `detectCadenceBreak(series: MetricSeries, todayIndexFromEnd?: number): Finding | null`.

This is the headline detector — the one thing nothing in the app can currently
do. It is a **rule, not a hypothesis test**, so it emits `pValue: null` and must
never enter the FDR family (Task 9 enforces that).

A day "counts" when it has a value **greater than zero**. A null day is absence
of data; a zero day is a recorded day of no activity. Both fail to count, but
only for the same reason a rest day does — neither is an error.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectCadenceBreak } from './detectors';
import type { MetricSeries } from './types';

/** Builds a 90-day series ending 2026-09-07 from a day -> value map. */
function series(metric: string, values: Record<string, number | null>): MetricSeries {
  const points = [];
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let i = 89; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    points.push({ date, value: date in values ? values[date] : null });
  }
  return { metric, points };
}

/** Marks `every`-th day active with `value`, across the whole window. */
function regular(every: number, value = 45): Record<string, number> {
  const out: Record<string, number> = {};
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let i = 89; i >= 0; i -= 1) {
    if (i % every !== 0) continue;
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out[d.toISOString().slice(0, 10)] = value;
  }
  return out;
}

test('fires when a six-day-a-week cadence has been silent for days', () => {
  // Active every day except the trailing 5.
  const values = regular(1);
  for (let i = 0; i < 5; i += 1) {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - i);
    delete values[d.toISOString().slice(0, 10)];
  }
  const finding = detectCadenceBreak(series('exercise_min', values));
  assert.ok(finding);
  assert.equal(finding.kind, 'cadence_break');
  assert.equal(finding.pValue, null);
  assert.equal(finding.effect, 5);
  assert.equal(finding.signature, 'cadence_break:exercise_min');
});

test('stays quiet when the user trained today', () => {
  assert.equal(detectCadenceBreak(series('exercise_min', regular(1))), null);
});

test('stays quiet when there is no established cadence to break', () => {
  // Roughly one session a week is below the >= 3/week bar.
  assert.equal(detectCadenceBreak(series('exercise_min', regular(7))), null);
});

test('a rest day is not a break for a six-day-a-week athlete', () => {
  const values = regular(1);
  const d = new Date(Date.UTC(2026, 8, 7));
  delete values[d.toISOString().slice(0, 10)];
  assert.equal(detectCadenceBreak(series('exercise_min', values)), null);
});

test('treats a recorded zero as a non-active day, not as missing data', () => {
  const values: Record<string, number | null> = regular(1);
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - i);
    values[d.toISOString().slice(0, 10)] = 0;
  }
  const finding = detectCadenceBreak(series('exercise_min', values));
  assert.ok(finding);
  assert.equal(finding.effect, 6);
});

test('returns null for a series with no activity at all', () => {
  assert.equal(detectCadenceBreak(series('exercise_min', {})), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/detectors.test.ts`
Expected: FAIL — cannot find module `./detectors`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { Finding, MetricSeries } from './types';

/** Metrics whose rhythm is meaningful enough that breaking it is worth saying. */
export const CADENCE_METRICS = ['exercise_min', 'active_energy_kcal', 'whoop_day_strain'];

const CADENCE_WINDOW_DAYS = 28;
const MIN_SESSIONS_PER_WEEK = 3;
const MIN_SILENT_DAYS = 3;

/**
 * Fires when an established rhythm has gone quiet.
 *
 * This is a rule about a known cadence, not a hypothesis test, so it reports
 * `pValue: null` and is excluded from the FDR family — forcing it through a
 * multiple-comparisons correction would be statistical theater.
 *
 * A day counts as active when its value is > 0. A null (no data) and a
 * recorded 0 both fail to count, which is correct: neither is a session.
 */
export function detectCadenceBreak(series: MetricSeries): Finding | null {
  const points = series.points;
  if (points.length === 0) return null;

  const isActive = (index: number): boolean => {
    const value = points[index].value;
    return value !== null && value > 0;
  };

  // Days since the most recent active day, counting back from the last point.
  let daysSinceLast = -1;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (isActive(i)) { daysSinceLast = points.length - 1 - i; break; }
  }
  if (daysSinceLast < 0) return null;           // never active — nothing to break
  if (daysSinceLast < MIN_SILENT_DAYS) return null;

  // Establish the cadence from the 28 days BEFORE the silence began, so the
  // silence itself doesn't drag the rate down and mask the break.
  const lastActiveIndex = points.length - 1 - daysSinceLast;
  const windowStart = Math.max(0, lastActiveIndex - CADENCE_WINDOW_DAYS + 1);
  let activeDays = 0;
  for (let i = windowStart; i <= lastActiveIndex; i += 1) if (isActive(i)) activeDays += 1;

  const observedDays = lastActiveIndex - windowStart + 1;
  if (observedDays < CADENCE_WINDOW_DAYS) return null;   // not enough history to call it established

  const perWeek = (activeDays / observedDays) * 7;
  if (perWeek < MIN_SESSIONS_PER_WEEK) return null;

  const expectedGap = Math.ceil(7 / perWeek);
  const threshold = Math.max(MIN_SILENT_DAYS, 2 * expectedGap);
  if (daysSinceLast < threshold) return null;

  return {
    kind: 'cadence_break',
    signature: `cadence_break:${series.metric}`,
    metrics: [series.metric],
    effect: daysSinceLast,
    effectLabel: `${daysSinceLast} days since the last session`,
    n: observedDays,
    pValue: null,
    detail: {
      daysSinceLast,
      sessionsPerWeek: Number(perWeek.toFixed(1)),
      windowDays: observedDays,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/detectors.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/detectors.ts lib/insights/detectors.test.ts
git commit -m "feat(insights): detect a broken training cadence"
```

---

## Task 7: Detectors — level shift and trend

**Files:**
- Modify: `lib/insights/detectors.ts`
- Test: `lib/insights/detectors.test.ts` (append)

**Interfaces:**
- Consumes: `mean`, `sd`, `olsSlope` (Tasks 1–2); `MetricSeries`, `Finding` (Task 3).
- Produces: `detectLevelShift(series: MetricSeries): Finding | null`, `detectTrend(series: MetricSeries): Finding | null`.

Both are hypothesis-shaped and emit a real `pValue`, so both enter the FDR
family in Task 9.

`detectLevelShift` measures the last 7 days against the preceding 28 in units of
**the user's own SD** — a 10 bpm move means something different for a steady
resting heart rate than a volatile one. A baseline SD of zero yields no finding
rather than an infinite effect size.

- [ ] **Step 1: Write the failing test**

```typescript
import { detectLevelShift, detectTrend } from './detectors';

/** 90-day series from a generator over day index 0..89 (89 = most recent). */
function generated(metric: string, fn: (daysAgo: number) => number | null): MetricSeries {
  const points = [];
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let daysAgo = 89; daysAgo >= 0; daysAgo -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    points.push({ date: d.toISOString().slice(0, 10), value: fn(daysAgo) });
  }
  return { metric, points };
}

test('level shift finds a planted drop in the last week', () => {
  const finding = detectLevelShift(generated('hrv_sdnn', (daysAgo) => {
    const wobble = (daysAgo % 5) - 2;              // small deterministic variation
    return daysAgo < 7 ? 40 + wobble : 60 + wobble;
  }));
  assert.ok(finding);
  assert.equal(finding.kind, 'level_shift');
  assert.ok(finding.effect < -1);                   // a drop, in SD units
  assert.equal(finding.signature, 'level_shift:hrv_sdnn:down');
  assert.ok(finding.pValue !== null && finding.pValue < 0.05);
});

test('level shift on a stable series yields only a small, unconvincing candidate', () => {
  // Detectors emit every hypothesis they TEST; they do not decide what is worth
  // saying. Gating happens in evidence.ts, which must correct over the full
  // family — so a stable series still produces a candidate, it just fails the
  // downstream floor. Pre-filtering here would shrink m and make the
  // false-discovery-rate correction anti-conservative.
  const finding = detectLevelShift(generated('hrv_sdnn', (daysAgo) => 60 + ((daysAgo % 5) - 2)));
  assert.ok(finding, 'expected a candidate, since the hypothesis was tested');
  assert.ok(Math.abs(finding.effect) < 0.8, 'effect must fail the downstream floor');
  assert.ok(finding.pValue !== null && finding.pValue > 0.05);
});

test('level shift stays quiet when the baseline has no variation', () => {
  // sd = 0 would make any change infinitely large; report nothing instead.
  assert.equal(detectLevelShift(generated('hrv_sdnn', (daysAgo) => (daysAgo < 7 ? 40 : 60))), null);
});

test('level shift stays quiet with too few recent days', () => {
  assert.equal(
    detectLevelShift(generated('hrv_sdnn', (daysAgo) => (daysAgo < 7 ? null : 60 + ((daysAgo % 5) - 2)))),
    null,
  );
});

test('trend finds a planted decline and reports its direction', () => {
  const finding = detectTrend(generated('sleep_minutes', (daysAgo) => 420 - (27 - Math.min(daysAgo, 27)) * 4));
  assert.ok(finding);
  assert.equal(finding.kind, 'trend');
  assert.ok(finding.effect < 0);
  assert.equal(finding.signature, 'trend:sleep_minutes:down');
});

test('trend stays quiet on a flat series', () => {
  assert.equal(detectTrend(generated('sleep_minutes', () => 420)), null);
});

test('trend stays quiet with too few observed days in the window', () => {
  assert.equal(
    detectTrend(generated('sleep_minutes', (daysAgo) => (daysAgo % 3 === 0 ? 420 - daysAgo : null))),
    null,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/detectors.test.ts`
Expected: FAIL — `detectLevelShift` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/insights/detectors.ts` (and add `mean`, `sd`, `olsSlope`,
`studentTTwoSidedP` to the imports from `./stats`):

```typescript
const RECENT_DAYS = 7;
const BASELINE_DAYS = 28;
const MIN_RECENT_OBS = 7;
const MIN_BASELINE_OBS = 21;

const TREND_DAYS = 28;
const MIN_TREND_OBS = 20;

/** Observed (non-null) values from the last `count` points. */
function tailValues(series: MetricSeries, count: number, skip = 0): number[] {
  const end = series.points.length - skip;
  const start = Math.max(0, end - count);
  const out: number[] = [];
  for (let i = start; i < end; i += 1) {
    const value = series.points[i].value;
    if (value !== null) out.push(value);
  }
  return out;
}

/**
 * Compares the last 7 days against the preceding 28, in units of the user's own
 * baseline SD. Expressing the change in personal SD is the point: 10 bpm means
 * something different for a steady resting heart rate than a volatile one.
 */
export function detectLevelShift(series: MetricSeries): Finding | null {
  const recent = tailValues(series, RECENT_DAYS);
  const baseline = tailValues(series, BASELINE_DAYS, RECENT_DAYS);
  if (recent.length < MIN_RECENT_OBS || baseline.length < MIN_BASELINE_OBS) return null;

  const baselineSd = sd(baseline);
  if (baselineSd === 0) return null;    // no variation: any change would read as infinite

  const recentMean = mean(recent);
  const baselineMean = mean(baseline);
  const effect = (recentMean - baselineMean) / baselineSd;

  // Welch t-test on the two means.
  const varRecent = sd(recent) ** 2 / recent.length;
  const varBaseline = baselineSd ** 2 / baseline.length;
  const denominator = Math.sqrt(varRecent + varBaseline);
  if (denominator === 0) return null;

  const t = (recentMean - baselineMean) / denominator;
  const df =
    (varRecent + varBaseline) ** 2 /
    (varRecent ** 2 / (recent.length - 1) + varBaseline ** 2 / (baseline.length - 1));
  const pValue = studentTTwoSidedP(t, Math.max(1, df));

  const direction = effect < 0 ? 'down' : 'up';
  return {
    kind: 'level_shift',
    signature: `level_shift:${series.metric}:${direction}`,
    metrics: [series.metric],
    effect,
    effectLabel: `${Math.abs(effect).toFixed(1)} SD ${direction === 'down' ? 'below' : 'above'} baseline`,
    n: recent.length + baseline.length,
    pValue,
    detail: {
      recentMean: Number(recentMean.toFixed(2)),
      baselineMean: Number(baselineMean.toFixed(2)),
      recentDays: recent.length,
      baselineDays: baseline.length,
    },
  };
}

/** Ordinary least squares slope over the last 28 days, with a t-test on the slope. */
export function detectTrend(series: MetricSeries): Finding | null {
  const window = series.points.slice(Math.max(0, series.points.length - TREND_DAYS));
  const xs: number[] = [];
  const ys: number[] = [];
  window.forEach((point, index) => {
    if (point.value !== null) { xs.push(index); ys.push(point.value); }
  });
  if (xs.length < MIN_TREND_OBS) return null;

  const { slope, pValue, n } = olsSlope(xs, ys);
  if (slope === 0) return null;

  const direction = slope < 0 ? 'down' : 'up';
  return {
    kind: 'trend',
    signature: `trend:${series.metric}:${direction}`,
    metrics: [series.metric],
    effect: slope,
    effectLabel: `${slope > 0 ? '+' : ''}${(slope * 7).toFixed(1)} per week`,
    n,
    pValue,
    detail: {
      slopePerDay: Number(slope.toFixed(4)),
      slopePerWeek: Number((slope * 7).toFixed(2)),
      observedDays: n,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/detectors.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/detectors.ts lib/insights/detectors.test.ts
git commit -m "feat(insights): detect level shifts and trends against personal baselines"
```

---

## Task 8: Detectors — directional cross-lag and day-of-week

**Files:**
- Modify: `lib/insights/detectors.ts`
- Test: `lib/insights/detectors.test.ts` (append)

**Interfaces:**
- Consumes: `spearman`, `kruskalWallisSevenGroups` (Task 2).
- Produces: `INPUT_METRICS: string[]`, `OUTCOME_METRICS: string[]`, `detectCrossLag(inputs: MetricSeries[], outcomes: MetricSeries[]): Finding[]`, `detectDayOfWeek(series: MetricSeries): Finding | null`.

**Read the spec section "Why `crossLag` is directional, not a blind sweep" before
implementing this.** The short version: an unrestricted sweep over all 23 catalog
metrics is ~1,265 hypotheses per run. BH would control the error rate correctly,
but against 90 days of data the corrected threshold gets so strict that nothing
real ever clears it — statistically impeccable and permanently silent. Inputs →
outcomes at lags {0,1} is ~150 hypotheses, roughly 8× the power, and still finds
things nobody enumerated.

`INPUT_METRICS` and `OUTCOME_METRICS` live in one place precisely so this
boundary stays reviewable. **Do not widen them without redoing the power
argument.**

- [ ] **Step 1: Write the failing test**

```typescript
import { detectCrossLag, detectDayOfWeek, INPUT_METRICS, OUTCOME_METRICS } from './detectors';

test('input and outcome metric sets are disjoint and non-empty', () => {
  assert.ok(INPUT_METRICS.length > 0 && OUTCOME_METRICS.length > 0);
  const overlap = INPUT_METRICS.filter((m) => OUTCOME_METRICS.includes(m));
  assert.deepEqual(overlap, []);
});

test('cross-lag finds a planted next-day relationship', () => {
  // Strain on day d drives recovery DOWN on day d+1.
  const strain = generated('whoop_day_strain', (daysAgo) => 5 + (daysAgo % 10));
  const recovery = generated('whoop_recovery', (daysAgo) => {
    const yesterdayStrain = 5 + ((daysAgo + 1) % 10);
    return 90 - yesterdayStrain * 3;
  });

  const findings = detectCrossLag([strain], [recovery]);
  const lagOne = findings.find((f) => f.detail.lag === 1);
  assert.ok(lagOne, 'expected a lag-1 finding');
  assert.equal(lagOne.kind, 'cross_lag');
  assert.ok(lagOne.effect < -0.9);
  assert.equal(lagOne.signature, 'cross_lag:whoop_day_strain:whoop_recovery:1:down');
});

test('cross-lag finds nothing convincing in unrelated series', () => {
  // Candidates are still emitted (they are tested hypotheses and must count
  // toward m); none of them should clear the magnitude the gate demands.
  const strain = generated('whoop_day_strain', (daysAgo) => 5 + (daysAgo % 10));
  const recovery = generated('whoop_recovery', (daysAgo) => 60 + ((daysAgo * 7) % 11));
  const findings = detectCrossLag([strain], [recovery]);
  assert.ok(findings.length > 0, 'tested pairs must be emitted even when unimpressive');
  assert.deepEqual(findings.filter((f) => Math.abs(f.effect) >= 0.35), []);
});

test('cross-lag skips pairs with too few overlapping observations', () => {
  const sparse = generated('whoop_day_strain', (daysAgo) => (daysAgo < 80 ? null : 10));
  const recovery = generated('whoop_recovery', () => 60);
  assert.deepEqual(detectCrossLag([sparse], [recovery]), []);
});

test('cross-lag pairs values by date, not by array position', () => {
  // One missing input day (daysAgo=40) must not shift the outcome alignment.
  // Date-joining gives exactly 89 pairs at lag 0 (90 days less the gap) and 88
  // at lag 1 (the gap, plus the final day whose D+1 falls outside the window).
  // An index-join would yield 89 at both lags while silently correlating
  // mismatched days — which is precisely how a detector manufactures a
  // relationship that does not exist. Assert the counts, not just a bound.
  const input = generated('steps', (daysAgo) => (daysAgo === 40 ? null : 8000 + (daysAgo % 7) * 500));
  const outcome = generated('sleep_minutes', (daysAgo) => 400 + ((daysAgo % 7) * 500) / 100);
  const findings = detectCrossLag([input], [outcome]);
  assert.equal(findings.find((f) => f.detail.lag === 0)?.n, 89);
  assert.equal(findings.find((f) => f.detail.lag === 1)?.n, 88);
});

test('day-of-week finds a planted weekend effect', () => {
  // 2026-09-07 is a Monday; weekends get markedly less sleep.
  const finding = detectDayOfWeek(generated('sleep_minutes', (daysAgo) => {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    return (weekend ? 300 : 450) + (daysAgo % 4);
  }));
  assert.ok(finding);
  assert.equal(finding.kind, 'day_of_week');
  assert.equal(finding.signature, 'day_of_week:sleep_minutes');
});

test('day-of-week finds nothing convincing when every weekday looks the same', () => {
  // The 4-day value cycle and the 7-day week have lcm 28 across a 90-day
  // window, so weekday means genuinely differ by a hair. The hypothesis was
  // testable and was tested, so a candidate is emitted and counts toward m —
  // it simply has no support behind it.
  const finding = detectDayOfWeek(generated('sleep_minutes', (daysAgo) => 420 + (daysAgo % 4)));
  assert.ok(finding, 'expected a candidate, since the hypothesis was tested');
  assert.ok(finding.pValue !== null && finding.pValue > 0.2);
});

test('day-of-week stays quiet without all seven weekdays covered', () => {
  const finding = detectDayOfWeek(generated('sleep_minutes', (daysAgo) => {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.getUTCDay() === 3 ? null : 420 + (daysAgo % 4);
  }));
  assert.equal(finding, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/detectors.test.ts`
Expected: FAIL — `detectCrossLag` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `lib/insights/detectors.ts` (add `spearman`, `kruskalWallisSevenGroups`
to the `./stats` imports):

```typescript
/**
 * What the user did. Paired against OUTCOME_METRICS only — see the spec section
 * "Why crossLag is directional, not a blind sweep". Widening these lists
 * enlarges the hypothesis family and costs statistical power; do not extend
 * them without redoing that argument.
 */
export const INPUT_METRICS = [
  'whoop_day_strain', 'steps', 'exercise_min', 'distance_m', 'active_energy_kcal',
  'dietary_energy_kcal', 'dietary_protein_g', 'dietary_carbs_g', 'dietary_fat_g',
];

/** How the body responded. */
export const OUTCOME_METRICS = [
  'hrv_sdnn', 'whoop_hrv_rmssd', 'resting_hr', 'whoop_resting_hr',
  'whoop_recovery', 'sleep_minutes', 'whoop_sleep_min', 'whoop_spo2', 'whoop_skin_temp',
];

const CROSS_LAGS = [0, 1];
const MIN_PAIRS = 30;
const MIN_ABS_RHO = 0.35;

const MIN_WEEKS_FOR_DAY_OF_WEEK = 8;

/**
 * Correlates each input on day d with each outcome on day d+lag.
 *
 * Pairs are joined BY DATE, never by array index — a gap in either series must
 * not silently shift the alignment and manufacture a relationship.
 *
 * Returns raw candidates; the effect floor and FDR correction are applied in
 * evidence.ts, not here.
 */
export function detectCrossLag(inputs: MetricSeries[], outcomes: MetricSeries[]): Finding[] {
  const findings: Finding[] = [];

  const indexOf = (series: MetricSeries): Map<string, number> => {
    const map = new Map<string, number>();
    for (const point of series.points) if (point.value !== null) map.set(point.date, point.value);
    return map;
  };

  const shiftDate = (date: string, days: number): string => {
    const [y, m, d] = date.split('-').map(Number);
    const shifted = new Date(Date.UTC(y, m - 1, d));
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };

  for (const input of inputs) {
    const inputByDate = indexOf(input);
    if (inputByDate.size < MIN_PAIRS) continue;

    for (const outcome of outcomes) {
      const outcomeByDate = indexOf(outcome);
      if (outcomeByDate.size < MIN_PAIRS) continue;

      for (const lag of CROSS_LAGS) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [date, inputValue] of inputByDate) {
          const outcomeValue = outcomeByDate.get(shiftDate(date, lag));
          if (outcomeValue === undefined) continue;
          xs.push(inputValue);
          ys.push(outcomeValue);
        }
        if (xs.length < MIN_PAIRS) continue;

        // Every pair we could test is a hypothesis and MUST be emitted, even
        // when rho is tiny. Dropping unimpressive pairs here would shrink the
        // family size m that evidence.ts corrects over — and because |rho| and
        // the p-value move together, that selection makes Benjamini-Hochberg
        // anti-conservative. The MIN_PAIRS check above is different in kind: a
        // pair with too little overlap was never testable, so it is genuinely
        // not part of the family.
        const { rho, pValue, n } = spearman(xs, ys);

        const direction = rho < 0 ? 'down' : 'up';
        findings.push({
          kind: 'cross_lag',
          signature: `cross_lag:${input.metric}:${outcome.metric}:${lag}:${direction}`,
          metrics: [input.metric, outcome.metric],
          effect: rho,
          effectLabel: `${direction === 'down' ? 'inverse' : 'positive'} (rho ${rho.toFixed(2)})`,
          n,
          pValue,
          detail: { lag, rho: Number(rho.toFixed(3)), pairs: n, input: input.metric, outcome: outcome.metric },
        });
      }
    }
  }

  return findings;
}

/**
 * Kruskal–Wallis across the seven weekdays. Requires all seven represented
 * (which fixes df at 6 — see stats.ts) and at least 8 weeks of coverage.
 */
export function detectDayOfWeek(series: MetricSeries): Finding | null {
  const groups: number[][] = Array.from({ length: 7 }, () => []);
  let observed = 0;

  for (const point of series.points) {
    if (point.value === null) continue;
    const [y, m, d] = point.date.split('-').map(Number);
    groups[new Date(Date.UTC(y, m - 1, d)).getUTCDay()].push(point.value);
    observed += 1;
  }

  if (observed < MIN_WEEKS_FOR_DAY_OF_WEEK * 7) return null;
  if (groups.some((group) => group.length === 0)) return null;

  const { h, pValue, n } = kruskalWallisSevenGroups(groups);
  if (h === 0) return null;

  const dayMeans = groups.map((group) => group.reduce((a, b) => a + b, 0) / group.length);
  const highest = dayMeans.indexOf(Math.max(...dayMeans));
  const lowest = dayMeans.indexOf(Math.min(...dayMeans));
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    kind: 'day_of_week',
    signature: `day_of_week:${series.metric}`,
    metrics: [series.metric],
    effect: dayMeans[highest] - dayMeans[lowest],
    effectLabel: `${names[lowest]} lowest, ${names[highest]} highest`,
    n,
    pValue,
    detail: {
      highestDay: names[highest],
      lowestDay: names[lowest],
      highestMean: Number(dayMeans[highest].toFixed(1)),
      lowestMean: Number(dayMeans[lowest].toFixed(1)),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/detectors.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/detectors.ts lib/insights/detectors.test.ts
git commit -m "feat(insights): detect directional cross-lag and day-of-week effects"
```

---

## Task 9: The evidence gate

**Files:**
- Create: `lib/insights/evidence.ts`
- Test: `lib/insights/evidence.test.ts`

**Interfaces:**
- Consumes: `benjaminiHochberg` (Task 2); `Finding` (Task 3).
- Produces: `FDR_Q = 0.10`, `MIN_LEVEL_SHIFT_SD = 0.8`, `applyEvidenceGate(findings: Finding[], establishedMetrics: Set<string>): Finding[]`, and in `lib/insights/series.ts`: `establishedMetrics(userId: string): Promise<Set<string>>`.

**Where the established set comes from.** `baselines` carries a per-metric
`established` boolean — that is the source, *not* `getCalibration`, which only
covers `hrv_sdnn`, `resting_hr`, and `sleep_minutes` and answers a different
question. Add to `lib/insights/series.ts`:

```typescript
/** Metrics with enough history for the engine to reason about, per `baselines`. */
export async function establishedMetrics(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ metric: schema.baselines.metric })
    .from(schema.baselines)
    .where(and(eq(schema.baselines.user_id, userId), eq(schema.baselines.established, true)));
  return new Set(rows.map((row) => row.metric));
}
```

A metric with no `baselines` row is treated as not established. That is the
conservative and correct default.

⚠️ **Verify before building on it:** check which metrics `recomputeBaselines` is
actually called with (`lib/brain/baselines.ts` and its callers). If in practice
only the three calibration metrics ever get baseline rows, the engine will be
near-silent no matter how good the statistics are, and extending
`recomputeBaselines` to cover `INPUT_METRICS` + `OUTCOME_METRICS` becomes a
prerequisite. **Report that as a finding — do not work around it by dropping the
established gate.**

This is the module that makes the feature trustworthy. Four rules, in order:

1. **Established baselines only.** A finding whose metrics aren't all established is dropped. Reuses the existing calibration notion rather than inventing a second one.
2. **Effect floor, independent of significance.** With enough observations a trivially small effect becomes "significant". A finding must be both unlikely by chance *and* big enough to matter — both gates, not either.
3. **FDR across the hypothesis family.** `level_shift`, `trend`, `cross_lag`, `day_of_week` are corrected together, once per run, at q = 0.10.
4. **Rule-shaped findings bypass the family.** `cadence_break` has `pValue: null` and must never be added to the BH vector — including a null would corrupt the ranks for every real p-value.

Findings that fail are **dropped, not downgraded**.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyEvidenceGate } from './evidence';
import type { Finding } from './types';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: 'level_shift',
    signature: 'level_shift:hrv_sdnn:down',
    metrics: ['hrv_sdnn'],
    effect: -1.5,
    effectLabel: '1.5 SD below baseline',
    n: 35,
    pValue: 0.001,
    detail: {},
    ...overrides,
  };
}

const established = new Set(['hrv_sdnn', 'resting_hr', 'sleep_minutes', 'whoop_day_strain', 'whoop_recovery']);

test('drops findings whose metrics are not established', () => {
  const kept = applyEvidenceGate([finding({ metrics: ['vo2_max'] })], established);
  assert.deepEqual(kept, []);
});

test('drops a cross-lag finding when only one of its two metrics is established', () => {
  const kept = applyEvidenceGate(
    [finding({ kind: 'cross_lag', metrics: ['whoop_day_strain', 'vo2_max'], effect: -0.6 })],
    established,
  );
  assert.deepEqual(kept, []);
});

test('keeps a large, significant, established finding', () => {
  assert.equal(applyEvidenceGate([finding()], established).length, 1);
});

test('drops a significant but trivially small level shift', () => {
  // Significance without magnitude is what large n manufactures.
  const kept = applyEvidenceGate([finding({ effect: -0.2, pValue: 0.0001 })], established);
  assert.deepEqual(kept, []);
});

test('drops large findings whose p-values look like pure noise', () => {
  // Uniform p-values are the null distribution — the shape a sweep over
  // unrelated metrics produces. Every one of these has a big effect, and none
  // should survive.
  const noise = Array.from({ length: 40 }, (_, i) =>
    finding({ signature: `level_shift:hrv_sdnn:${i}`, effect: -1.2, pValue: (i + 1) / 40 }),
  );
  assert.deepEqual(applyEvidenceGate(noise, established), []);
});

test('cadence_break bypasses the FDR family and survives alone', () => {
  const kept = applyEvidenceGate(
    [finding({ kind: 'cadence_break', signature: 'cadence_break:exercise_min', metrics: ['whoop_day_strain'], effect: 5, pValue: null })],
    established,
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].kind, 'cadence_break');
});

test('a cadence_break does not dilute the correction for real p-values', () => {
  const withRule = applyEvidenceGate(
    [finding(), finding({ kind: 'cadence_break', signature: 'c', metrics: ['whoop_day_strain'], effect: 5, pValue: null })],
    established,
  );
  const withoutRule = applyEvidenceGate([finding()], established);
  assert.equal(withRule.filter((f) => f.kind === 'level_shift').length, withoutRule.length);
});

test('an empty input yields an empty output', () => {
  assert.deepEqual(applyEvidenceGate([], established), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/evidence.test.ts`
Expected: FAIL — cannot find module `./evidence`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { MIN_ABS_RHO } from './detectors';
import { benjaminiHochberg } from './stats';
import type { Finding } from './types';

/** False-discovery rate for the hypothesis family. */
export const FDR_Q = 0.10;

/** Minimum |effect| per finding kind, applied independently of significance. */
export const MIN_LEVEL_SHIFT_SD = 0.8;
/** Single source of truth lives in detectors.ts — do not fork this threshold. */
export const MIN_CROSS_LAG_RHO = MIN_ABS_RHO;
export const MIN_DAY_OF_WEEK_SPREAD = 0;   // magnitude is metric-specific; significance carries this one
/**
 * Trend slopes are standardised to SD-per-week by detectTrend, so this floor is
 * comparable across metrics. 0.15 SD/week is roughly 0.65 SD/month — enough
 * movement to be worth a person's attention. Without a floor here, a
 * statistically significant but clinically meaningless drift ("your resting
 * heart rate is trending up", meaning 0.2 bpm across a month) reaches the user
 * as an insight. level_shift and cross_lag have always had such a floor; trend
 * did not, which was an asymmetry rather than a decision.
 */
export const MIN_TREND_SD_PER_WEEK = 0.15;

function passesEffectFloor(finding: Finding): boolean {
  switch (finding.kind) {
    case 'level_shift': return Math.abs(finding.effect) >= MIN_LEVEL_SHIFT_SD;
    case 'cross_lag':   return Math.abs(finding.effect) >= MIN_CROSS_LAG_RHO;
    case 'day_of_week': return Math.abs(finding.effect) > MIN_DAY_OF_WEEK_SPREAD;
    case 'trend':       return Math.abs(finding.effect) >= MIN_TREND_SD_PER_WEEK;
    case 'cadence_break': return true;      // the rule itself is the threshold
    default: return false;
  }
}

/**
 * The gate that makes this feature trustworthy.
 *
 * Order matters: establishment, then effect floor, then FDR across only the
 * hypothesis-shaped findings. `cadence_break` carries pValue: null and is
 * deliberately excluded from the BH vector — a null in that vector would
 * corrupt the ranks for every genuine p-value in the family.
 *
 * Anything that fails is dropped. There is no low-confidence tier, because a
 * low-confidence tier eventually gets spoken aloud.
 */
export function applyEvidenceGate(findings: Finding[], establishedMetrics: Set<string>): Finding[] {
  // Establishment is a VALIDITY filter: a metric with no established baseline
  // was never a testable hypothesis, so it never belonged to the family and
  // removing it does not bias the correction.
  const eligible = findings.filter((f) => f.metrics.every((metric) => establishedMetrics.has(metric)));

  const hypotheses = eligible.filter((f) => f.pValue !== null);
  const rules = eligible.filter((f) => f.pValue === null);

  if (hypotheses.length === 0) return rules.filter(passesEffectFloor);

  // ORDER IS LOAD-BEARING: correct over the FULL family first, then apply the
  // effect floor to the survivors. Applying the floor first would shrink m by
  // selecting on a quantity that moves with the p-value, which makes
  // Benjamini-Hochberg anti-conservative — the precise failure it exists to
  // prevent. Never reorder these two steps.
  const rejected = benjaminiHochberg(hypotheses.map((f) => f.pValue as number), FDR_Q);
  const survivors = hypotheses.filter((_, index) => rejected[index]).filter(passesEffectFloor);

  return [...rules.filter(passesEffectFloor), ...survivors];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/evidence.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/evidence.ts lib/insights/evidence.test.ts
git commit -m "feat(insights): gate findings on establishment, effect size, and FDR"
```

---

## Task 9A: Autocorrelation correction (effective sample size)

**Added mid-execution.** The null-data canary (Task 10) was run against the
engine as built and certified **51–79% of findings on pure noise**: `trend`
565/720, `level_shift` 485/720, `cross_lag` 3325/6480, with 40/40 synthetic
users receiving a finding. `day_of_week` scored 0/720 and `cadence_break` never
fired.

**Root cause.** Every failing detector uses a parametric test that assumes
independent observations. Ninety consecutive daily health measurements are not
ninety independent ones — body mass is nearly a random walk, HRV and resting
heart rate are strongly serially correlated. Regressing an autocorrelated series
on time, or correlating two of them, produces spuriously significant results.
`day_of_week` is immune because Kruskal–Wallis across weekday buckets tests
nothing time-ordered, which corroborates the diagnosis.

This is an engine defect, not a harsh null. Real health data is autocorrelated
too, so the engine would over-report on real users — less visibly, which is
worse.

**Files:**
- Modify: `lib/insights/stats.ts` (add three helpers; add `t` to `SlopeResult`)
- Modify: `lib/insights/detectors.ts` (thread the correction into three detectors)
- Test: `lib/insights/stats.test.ts`, `lib/insights/detectors.test.ts` (append)

**Interfaces:**
- Produces: `lag1Autocorrelation(xs: number[]): number`, `effectiveSampleSize(n: number, r: number): number`, `effectiveSampleSizePair(n: number, rx: number, ry: number): number`; `SlopeResult` gains `t: number`.

**Acceptance criterion: the Task 10 canary must pass**, including its third test
(a genuinely planted effect is still found). Over-correcting into muteness is a
failure too.

- [ ] **Step 1: Write the failing tests for the helpers**

```typescript
import { lag1Autocorrelation, effectiveSampleSize, effectiveSampleSizePair } from './stats';

test('lag-1 autocorrelation is ~0 for alternating data and high for a random walk', () => {
  const alternating = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : -1));
  assert.ok(lag1Autocorrelation(alternating) < 0.05); // negative r clamps to 0

  let value = 0;
  const walk = Array.from({ length: 200 }, (_, i) => { value += ((i * 37) % 11) - 5; return value; });
  assert.ok(lag1Autocorrelation(walk) > 0.8);
});

test('lag-1 autocorrelation is 0 for degenerate input', () => {
  assert.equal(lag1Autocorrelation([1, 2]), 0);
  assert.equal(lag1Autocorrelation([5, 5, 5, 5, 5]), 0);
});

test('effective sample size collapses as autocorrelation approaches 1', () => {
  assert.equal(effectiveSampleSize(90, 0), 90);           // i.i.d.: no penalty
  assert.ok(Math.abs(effectiveSampleSize(90, 0.5) - 30) < 0.001);
  assert.ok(effectiveSampleSize(90, 0.99) < 1.5 || effectiveSampleSize(90, 0.99) === 3);
  assert.ok(effectiveSampleSize(90, 0.99) >= 3);          // floored, never below 3
});

test('paired effective sample size penalises only when BOTH series are autocorrelated', () => {
  assert.equal(effectiveSampleSizePair(90, 0, 0.9), 90);  // one i.i.d. series: no penalty
  assert.ok(effectiveSampleSizePair(90, 0.9, 0.9) < 25);
  assert.ok(effectiveSampleSizePair(90, 0.9, 0.9) >= 3);
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `node --import tsx --test lib/insights/stats.test.ts`
Expected: FAIL — `lag1Autocorrelation` is not exported.

- [ ] **Step 3: Implement the helpers in `lib/insights/stats.ts`**

```typescript
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
```

Also add `t` to `SlopeResult` and populate it in `olsSlope`, so callers can
re-evaluate the slope against corrected degrees of freedom:

```typescript
export interface SlopeResult { slope: number; pValue: number; n: number; t: number }
```

Return `t: 0` on every degenerate path, and `t: slope / standardError` on the
normal path. The perfect-fit path (`residualSumSquares === 0`) keeps
`pValue: slope === 0 ? 1 : 0` and reports `t: 0`.

- [ ] **Step 4: Run and confirm the helper tests pass**

- [ ] **Step 5: Thread the correction into the three parametric detectors**

`detectTrend` — after `olsSlope`, recompute the p-value against corrected df:

```typescript
  const { slope, pValue: rawP, n, t } = olsSlope(xs, ys);
  if (slope === 0) return null;

  // Ninety daily observations are not ninety independent ones; see
  // effectiveSampleSize. Without this, regressing an autocorrelated series on
  // time produces spuriously significant slopes (the classic spurious
  // regression), which is what made the null-data canary certify 79% of noise.
  const nEff = effectiveSampleSize(n, lag1Autocorrelation(ys));
  const pValue = t === 0 ? rawP : studentTTwoSidedP(t, Math.max(1, nEff - 2));
```

`detectLevelShift` — estimate `r` once over the whole window (the 7-day recent
slice is too short to estimate it) and inflate both variances:

```typescript
  const r = lag1Autocorrelation([...baseline, ...recent]);
  const nRecentEff = effectiveSampleSize(recent.length, r);
  const nBaselineEff = effectiveSampleSize(baseline.length, r);

  const varRecent = sd(recent) ** 2 / nRecentEff;
  const varBaseline = baselineSd ** 2 / nBaselineEff;
```

and compute the Welch degrees of freedom from `nRecentEff` / `nBaselineEff`
rather than the raw counts:

```typescript
  const df =
    (varRecent + varBaseline) ** 2 /
    (varRecent ** 2 / Math.max(1, nRecentEff - 1) + varBaseline ** 2 / Math.max(1, nBaselineEff - 1));
```

`detectCrossLag` — recompute the p-value from `rho` against the paired
effective sample size:

```typescript
        const { rho, n } = spearman(xs, ys);
        const nEff = effectiveSampleSizePair(n, lag1Autocorrelation(xs), lag1Autocorrelation(ys));
        const pValue = Math.abs(rho) >= 1
          ? 0
          : studentTTwoSidedP(rho * Math.sqrt((nEff - 2) / (1 - rho * rho)), Math.max(1, nEff - 2));
```

Keep emitting every tested pair. **This changes p-values only — no detector may
start filtering on effect size or significance.** That separation is what keeps
the FDR family size honest (see Task 9).

- [ ] **Step 5b: Standardise `detectTrend`'s effect to SD-per-week**

A raw OLS slope is in the metric's own units, so no cross-metric floor can be
written against it — which is why `trend` alone had no effect floor while
`level_shift` (0.8 SD) and `cross_lag` (0.35 ρ) both did. Standardise it:

```typescript
  const windowSd = sd(ys);
  if (windowSd === 0) return null;          // no variation: nothing to trend against
  const effect = (slope * 7) / windowSd;    // SD per week, comparable across metrics
```

Report `effect` as that standardised value, and keep the raw slope in `detail`:

```typescript
    effect,
    effectLabel: `${effect > 0 ? '+' : ''}${effect.toFixed(2)} SD per week`,
    detail: {
      slopePerDay: Number(slope.toFixed(4)),
      slopePerWeek: Number((slope * 7).toFixed(2)),
      sdPerWeek: Number(effect.toFixed(3)),
      observedDays: n,
    },
```

Existing tests assert only the sign of `effect` and the `trend:<metric>:<dir>`
signature, both preserved. The planted-decline fixture yields roughly
−0.9 SD/week, comfortably clear of the 0.15 floor.

- [ ] **Step 6: Update the affected detector tests**

The existing detector tests assert on effect sizes and directions, which are
unchanged. Where a test asserts a p-value threshold, the corrected p-value will
be **larger** (more conservative). Re-run and report any test whose assertion no
longer holds — **do not weaken an assertion.** The planted-effect tests use data
with strong real signal and should survive; if a planted effect stops being
detected, that is over-correction and must be reported, not accommodated.

- [ ] **Step 7: Run the full insights suite, then the canary**

Run: `node --import tsx --test lib/insights/*.test.ts`
Then the canary specifically. **The canary passing is this task's acceptance
criterion**, including its planted-effect test.

- [ ] **Step 8: Commit**

```bash
git add lib/insights/stats.ts lib/insights/stats.test.ts lib/insights/detectors.ts lib/insights/detectors.test.ts
git commit -m "fix(insights): correct p-values for serial dependence

Daily health observations are not independent, and the parametric
detectors treated them as if they were. The null-data canary certified
51-79% of findings on pure random walks as a result.

Applies a Bartlett/Bretherton effective-sample-size correction to trend,
level-shift, and cross-lag p-values. A random walk collapses n_eff and
the p-value goes to 1; i.i.d. data is unaffected."
```

---

## Task 10: The null-data canary

**Files:**
- Create: `lib/insights/nullCanary.test.ts`

**Interfaces:**
- Consumes: every detector (Tasks 6–8) and `applyEvidenceGate` (Task 9).
- Produces: no source code. This task is a test only.

**This is the most important test in the feature.** It runs the full battery
against pure random walks — data containing no real pattern by construction —
and asserts the false-positive rate stays under the FDR target.

It is the test that keeps "smart" from decaying into "confidently wrong". If a
future change loosens a threshold, widens `INPUT_METRICS`, or drops the BH
correction, this test is what fails. **Anyone who makes this test pass by
relaxing its assertion has removed the feature's reason to exist.** Say so in a
comment at the top of the file.

The generator is seeded and deterministic — a flaky canary gets muted, and a
muted canary protects nothing.

- [ ] **Step 1: Write the test**

```typescript
/**
 * NULL-DATA CANARY — the most important test in the insight engine.
 *
 * Runs the complete battery over synthetic users whose data contains no real
 * pattern by construction (seeded random walks), and asserts that almost
 * nothing survives the evidence gate.
 *
 * If this test starts failing, the engine has begun inventing patterns. Fix the
 * engine. DO NOT relax the assertion — an engine that reports findings from
 * noise is worse than no engine, because its users cannot tell the difference.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectCadenceBreak, detectCrossLag, detectDayOfWeek, detectLevelShift, detectTrend,
  INPUT_METRICS, OUTCOME_METRICS,
} from './detectors';
import { applyEvidenceGate } from './evidence';
import type { MetricSeries } from './types';

/** Deterministic PRNG (mulberry32) — a flaky canary gets muted, and a muted canary protects nothing. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 90-day random walk with no trend, no shift, and no cross-metric structure. */
function randomWalk(metric: string, random: () => number): MetricSeries {
  const points = [];
  let value = 50;
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let daysAgo = 89; daysAgo >= 0; daysAgo -= 1) {
    value += (random() - 0.5) * 4;
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    points.push({ date: d.toISOString().slice(0, 10), value });
  }
  return { metric, points };
}

const ALL_METRICS = [...INPUT_METRICS, ...OUTCOME_METRICS];
const established = new Set(ALL_METRICS);

test('the full battery reports almost nothing on pure noise', () => {
  const USERS = 40;
  let usersWithAnyFinding = 0;
  let totalFindings = 0;

  for (let user = 0; user < USERS; user += 1) {
    const random = makeRandom(1000 + user);
    const byMetric = new Map(ALL_METRICS.map((m) => [m, randomWalk(m, random)]));

    const candidates = [
      ...detectCrossLag(
        INPUT_METRICS.map((m) => byMetric.get(m)!),
        OUTCOME_METRICS.map((m) => byMetric.get(m)!),
      ),
    ];
    for (const metric of ALL_METRICS) {
      const series = byMetric.get(metric)!;
      const shift = detectLevelShift(series); if (shift) candidates.push(shift);
      const trend = detectTrend(series);      if (trend) candidates.push(trend);
      const dow = detectDayOfWeek(series);    if (dow) candidates.push(dow);
      const cadence = detectCadenceBreak(series); if (cadence) candidates.push(cadence);
    }

    const certified = applyEvidenceGate(candidates, established);
    if (certified.length > 0) usersWithAnyFinding += 1;
    totalFindings += certified.length;
  }

  // A random walk genuinely drifts, so a small number of level_shift/trend
  // findings are real statements about that walk and are not failures. What
  // must NOT happen is the engine finding something for most users.
  // Bound deliberately tight. The observed value is 0/40, and the mutations
  // this guards against produce 3689 (correction removed) and 198 (BH removed)
  // findings — so there is no legitimate pressure on this bound, and slack here
  // only buys a blind spot. An earlier 35% bar would have let a regression at
  // 10/40 users pass silently, which is a canary certifying safety falsely.
  assert.ok(
    usersWithAnyFinding / USERS < 0.10,
    `engine spoke for ${usersWithAnyFinding}/${USERS} pure-noise users (${totalFindings} findings) — it is inventing patterns`,
  );
});

test('the cross-lag sweep in particular finds almost nothing on noise', () => {
  const USERS = 40;
  let crossLagFindings = 0;

  for (let user = 0; user < USERS; user += 1) {
    const random = makeRandom(7000 + user);
    const inputs = INPUT_METRICS.map((m) => randomWalk(m, random));
    const outcomes = OUTCOME_METRICS.map((m) => randomWalk(m, random));
    crossLagFindings += applyEvidenceGate(detectCrossLag(inputs, outcomes), established).length;
  }

  // This is the sweep that would confabulate hardest without BH control:
  // ~150 hypotheses per user, ~6000 across the batch.
  // Same reasoning: observed 0, mutation produces 3689. Tight by design.
  assert.ok(
    crossLagFindings / USERS < 0.1,
    `cross-lag produced ${crossLagFindings} findings across ${USERS} noise users — the FDR correction is not holding`,
  );
});

test('the battery still finds a genuinely planted effect', () => {
  // The canary must not pass merely because the engine is mute.
  const random = makeRandom(42);
  const strain = randomWalk('whoop_day_strain', random);
  const recovery: MetricSeries = {
    metric: 'whoop_recovery',
    points: strain.points.map((point, index) => ({
      date: point.date,
      value: index === 0 ? 70 : 100 - (strain.points[index - 1].value as number),
    })),
  };

  const certified = applyEvidenceGate(detectCrossLag([strain], [recovery]), established);
  assert.ok(certified.length > 0, 'planted cross-lag effect was not detected — the engine is mute, not safe');
});

test('the battery finds a MODERATE, realistic effect buried in noise', () => {
  // The test above plants a near-perfect relationship (rho ~ -1), which no real
  // health data ever shows. This is the power test: after the autocorrelation
  // correction the null battery certifies exactly 0 of 4375, and an engine that
  // only speaks for perfect relationships is the "statistically impeccable and
  // permanently silent" failure the spec warns about. A real coaching signal —
  // yesterday's training load explaining roughly half the variance in today's
  // recovery, on top of genuine day-to-day noise — must survive.
  const random = makeRandom(4242);
  const strain = randomWalk('whoop_day_strain', random);

  const recovery: MetricSeries = {
    metric: 'whoop_recovery',
    points: strain.points.map((point, index) => ({
      date: point.date,
      // Noise amplitude 15 (uniform, sd 4.33) is chosen to MATCH the signal's
      // sd, giving R^2 ~ 0.5 and |rho| ~ 0.7. An earlier version used 40
      // (sd 11.55), which claimed R^2 ~ 0.5 in its comment but actually planted
      // R^2 ~ 0.12 — the finding then died at the 0.35 rho floor and the test
      // looked like an over-correction failure when it was a bad fixture.
      value: index === 0
        ? 70
        : 70 - 0.7 * (strain.points[index - 1].value as number) + (random() - 0.5) * 15,
    })),
  };

  const certified = applyEvidenceGate(detectCrossLag([strain], [recovery]), established);
  assert.ok(
    certified.length > 0,
    'a moderate real effect was not detected — the correction is over-conservative and the engine cannot do its job',
  );
});
```

- [ ] **Step 2: Run the canary**

Run: `node --import tsx --test lib/insights/nullCanary.test.ts`
Expected: PASS, 3 tests.

If the noise tests fail, **do not loosen the assertions.** Investigate in this
order: is `cadence_break` leaking into the BH vector? Is the effect floor
applied before the correction? Is `detectCrossLag` joining by date rather than
index?

- [ ] **Step 3: Commit**

```bash
git add lib/insights/nullCanary.test.ts
git commit -m "test(insights): add the null-data canary against confabulation"
```

---

## Task 11: Cross-run confirmation

**Files:**
- Create: `lib/insights/confirmation.ts`
- Test: `lib/insights/confirmation.test.ts`

**Interfaces:**
- Consumes: `schema.insight_findings` (Task 4); `Finding`, `CertifiedFinding` (Task 3).
- Produces: `confirmAgainstPreviousRun(findings: Finding[], previousSignatures: Set<string>): CertifiedFinding[]`, `recordFindings(userId: string, localDay: string, findings: Finding[]): Promise<void>`, `previousRunSignatures(userId: string, localDay: string): Promise<Set<string>>`.

**Why this exists:** the battery runs daily, which is itself repeated testing. A
borderline finding will eventually surface by chance given enough days, and the
within-run FDR correction does nothing about that. Requiring a finding to appear
on **two consecutive runs** collapses the day-shopping problem — noise rarely
repeats, real effects persist. It costs one day of latency on every nudge, which
is the right trade.

`confirmAgainstPreviousRun` is pure and directly testable; the two DB functions
are thin wrappers. Test the pure function.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmAgainstPreviousRun } from './confirmation';
import type { Finding } from './types';

function finding(signature: string): Finding {
  return {
    kind: 'level_shift', signature, metrics: ['hrv_sdnn'], effect: -1.5,
    effectLabel: '1.5 SD below baseline', n: 35, pValue: 0.001, detail: {},
  };
}

test('confirms a finding that also appeared on the previous run', () => {
  const confirmed = confirmAgainstPreviousRun([finding('a')], new Set(['a']));
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].confirmedOnRuns, 2);
});

test('drops a finding seen for the first time today', () => {
  assert.deepEqual(confirmAgainstPreviousRun([finding('a')], new Set(['b'])), []);
});

test('drops everything when there was no previous run', () => {
  assert.deepEqual(confirmAgainstPreviousRun([finding('a')], new Set()), []);
});

test('confirms only the overlapping subset', () => {
  const confirmed = confirmAgainstPreviousRun(
    [finding('a'), finding('b'), finding('c')],
    new Set(['b', 'c', 'z']),
  );
  assert.deepEqual(confirmed.map((f) => f.signature), ['b', 'c']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/confirmation.test.ts`
Expected: FAIL — cannot find module `./confirmation`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { and, eq } from 'drizzle-orm';

import { db, schema } from '@/db';
import { previousDayKey } from '@/lib/localDay';
import type { CertifiedFinding, Finding } from './types';

// Day-before arithmetic lives in lib/localDay.ts and is already tested there
// for year, month, leap-day, and DST boundaries. Do not reimplement it here —
// an untested duplicate of a tested date utility is how the two silently drift
// apart.

/**
 * Keeps only findings that also survived yesterday's run.
 *
 * Running the battery daily is repeated testing: the within-run FDR correction
 * says nothing about a borderline finding eventually surfacing across many
 * days. Requiring two consecutive runs collapses that — noise rarely repeats,
 * real effects persist. The cost is one day of latency on every nudge.
 */
export function confirmAgainstPreviousRun(
  findings: Finding[],
  previousSignatures: Set<string>,
): CertifiedFinding[] {
  return findings
    .filter((finding) => previousSignatures.has(finding.signature))
    .map((finding) => ({ ...finding, confirmedOnRuns: 2 }));
}

/** Signatures this user's battery produced on the previous local day. */
export async function previousRunSignatures(userId: string, localDay: string): Promise<Set<string>> {
  const rows = await db
    .select({ signature: schema.insight_findings.signature })
    .from(schema.insight_findings)
    .where(and(
      eq(schema.insight_findings.user_id, userId),
      eq(schema.insight_findings.computed_for, previousDayKey(localDay)),
    ));
  return new Set(rows.map((row) => row.signature));
}

/**
 * Records every gate-surviving finding for this run, whether or not it is ever
 * spoken aloud — tomorrow's confirmation depends on the ones we stayed quiet
 * about. Idempotent per (user, signature, day) so a worker retry is safe.
 */
export async function recordFindings(
  userId: string,
  localDay: string,
  findings: Finding[],
): Promise<void> {
  if (findings.length === 0) return;
  await db
    .insert(schema.insight_findings)
    .values(findings.map((finding) => ({
      user_id: userId,
      signature: finding.signature,
      kind: finding.kind,
      computed_for: localDay,
      payload: {
        effect: finding.effect,
        effectLabel: finding.effectLabel,
        n: finding.n,
        pValue: finding.pValue,
        metrics: finding.metrics,
        detail: finding.detail,
      },
    })))
    .onConflictDoNothing();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/confirmation.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/confirmation.ts lib/insights/confirmation.test.ts
git commit -m "feat(insights): require a finding to persist across two runs"
```

---

## Task 12: The arbiter

**Files:**
- Create: `lib/insights/arbiter.ts`
- Test: `lib/insights/arbiter.test.ts`

**Interfaces:**
- Consumes: `CertifiedFinding` (Task 3).
- Produces: `SHORTLIST_SIZE = 3`, `COOLDOWN_DAYS = 14`, `shortlist(findings: CertifiedFinding[], context: ArbiterContext): CertifiedFinding[]`, `interface ArbiterContext { goal: string | null; recentKinds: Map<string, number> }`.

Ranking stays **deterministic and in code**. The model's judgment is applied
downstream, to a set that has already been certified — that way selection is
auditable and a bad nudge can be traced to a rule rather than a mood.

`recentKinds` maps a finding *kind* to days since it was last sent. Anything
inside the 14-day cooldown is removed before ranking.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { shortlist } from './arbiter';
import type { CertifiedFinding } from './types';

function certified(overrides: Partial<CertifiedFinding> = {}): CertifiedFinding {
  return {
    kind: 'level_shift', signature: 'level_shift:hrv_sdnn:down', metrics: ['hrv_sdnn'],
    effect: -1.5, effectLabel: '1.5 SD below baseline', n: 35, pValue: 0.001,
    detail: {}, confirmedOnRuns: 2, ...overrides,
  };
}

const noHistory = { goal: null, recentKinds: new Map<string, number>() };

test('returns at most three findings', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    certified({ signature: `s${i}`, effect: -(1 + i / 10) }),
  );
  assert.equal(shortlist(many, noHistory).length, 3);
});

test('ranks a cadence break above a marginal statistical finding', () => {
  const ranked = shortlist(
    [certified({ signature: 'shift', effect: -0.9 }),
     certified({ kind: 'cadence_break', signature: 'cadence', effect: 5, pValue: null })],
    noHistory,
  );
  assert.equal(ranked[0].kind, 'cadence_break');
});

test('drops a kind still inside its cooldown', () => {
  const ranked = shortlist(
    [certified({ kind: 'cadence_break', signature: 'cadence', effect: 5, pValue: null })],
    { goal: null, recentKinds: new Map([['cadence_break', 3]]) },
  );
  assert.deepEqual(ranked, []);
});

test('allows a kind whose cooldown has expired', () => {
  const ranked = shortlist(
    [certified({ kind: 'cadence_break', signature: 'cadence', effect: 5, pValue: null })],
    { goal: null, recentKinds: new Map([['cadence_break', 20]]) },
  );
  assert.equal(ranked.length, 1);
});

test('prefers a larger effect within the same kind', () => {
  const ranked = shortlist(
    [certified({ signature: 'small', effect: -0.9 }), certified({ signature: 'big', effect: -2.4 })],
    noHistory,
  );
  assert.equal(ranked[0].signature, 'big');
});

test('is deterministic across repeated calls', () => {
  const findings = Array.from({ length: 6 }, (_, i) => certified({ signature: `s${i}`, effect: -(1 + i / 10) }));
  assert.deepEqual(
    shortlist(findings, noHistory).map((f) => f.signature),
    shortlist(findings, noHistory).map((f) => f.signature),
  );
});

test('breaks genuine score ties on signature, independent of input order', () => {
  // The test above uses six distinct effects, so every score differs and the
  // signature tie-break never fires — delete that half of the comparator and it
  // still passes. This one constructs a real tie (same kind, same |effect|, no
  // goal match, no history) and feeds it in both orders. Without the tie-break
  // the comparator returns 0 and the result depends on sort stability rather
  // than on a rule, so the two orders would disagree.
  const a = certified({ signature: 'aaa', effect: -1.5 });
  const b = certified({ signature: 'bbb', effect: -1.5 });
  assert.deepEqual(shortlist([b, a], noHistory).map((f) => f.signature), ['aaa', 'bbb']);
  assert.deepEqual(shortlist([a, b], noHistory).map((f) => f.signature), ['aaa', 'bbb']);
});

test('returns empty for no findings', () => {
  assert.deepEqual(shortlist([], noHistory), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/arbiter.test.ts`
Expected: FAIL — cannot find module `./arbiter`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { CertifiedFinding, FindingKind } from './types';

export const SHORTLIST_SIZE = 3;
export const COOLDOWN_DAYS = 14;

export interface ArbiterContext {
  goal: string | null;
  /** finding kind -> days since it was last sent. Absent means never sent. */
  recentKinds: Map<string, number>;
}

/**
 * Base weight per kind. A broken training cadence outranks a statistical
 * curiosity because it is the thing the user actually asked to hear about, and
 * because it is the only finding that implies a question rather than a fact.
 */
const KIND_WEIGHT: Record<FindingKind, number> = {
  cadence_break: 100,
  level_shift: 60,
  cross_lag: 45,
  trend: 40,
  day_of_week: 20,
};

/** Goal keyword -> metrics that matter more for it. */
const GOAL_METRICS: Record<string, string[]> = {
  weight_loss: ['body_mass_kg', 'dietary_energy_kcal', 'active_energy_kcal', 'steps'],
  muscle: ['dietary_protein_g', 'exercise_min', 'whoop_recovery'],
  endurance: ['distance_m', 'exercise_min', 'whoop_day_strain', 'vo2_max'],
  general: [],
};

function score(finding: CertifiedFinding, context: ArbiterContext): number {
  let value = KIND_WEIGHT[finding.kind] ?? 0;

  // Effect size, normalised per kind so a rho and an SD aren't compared raw.
  const magnitude = finding.kind === 'cadence_break'
    ? Math.min(finding.effect / 7, 3)
    : Math.min(Math.abs(finding.effect), 3);
  value += magnitude * 10;

  // Relevance to the user's stated goal.
  const goalMetrics = context.goal ? GOAL_METRICS[context.goal] ?? [] : [];
  if (finding.metrics.some((metric) => goalMetrics.includes(metric))) value += 15;

  // Novelty: a kind not raised for a long time edges out one raised recently.
  const daysSince = context.recentKinds.get(finding.kind);
  if (daysSince !== undefined) value += Math.min(daysSince - COOLDOWN_DAYS, 10);

  return value;
}

/**
 * Deterministic top-N. Selection stays in code so a bad nudge traces to a rule;
 * the model's judgment is applied afterwards, over an already-certified set.
 * Ties break on signature so repeated calls agree.
 */
export function shortlist(
  findings: CertifiedFinding[],
  context: ArbiterContext,
): CertifiedFinding[] {
  return findings
    .filter((finding) => {
      const daysSince = context.recentKinds.get(finding.kind);
      return daysSince === undefined || daysSince >= COOLDOWN_DAYS;
    })
    .map((finding) => ({ finding, value: score(finding, context) }))
    .sort((a, b) =>
      b.value - a.value || a.finding.signature.localeCompare(b.finding.signature))
    .slice(0, SHORTLIST_SIZE)
    .map((entry) => entry.finding);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/arbiter.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/arbiter.ts lib/insights/arbiter.test.ts
git commit -m "feat(insights): rank certified findings deterministically"
```

---

## Task 13: The voice layer

**Files:**
- Create: `lib/insights/voice.ts`
- Test: `lib/insights/voice.test.ts`

**Interfaces:**
- Consumes: `CertifiedFinding` (Task 3).
- Produces: `buildVoiceRequest(findings: CertifiedFinding[], context: VoiceContext): { system: string; content: string }`, `parseNudge(raw: string, allowedSignatures: string[]): Nudge | null`, `interface Nudge { signature: string; title: string; body: string; openingMessage: string }`, `interface VoiceContext { goal: string | null; facts: string[]; recentlySaid: string[] }`.

**The safety property lives in the prompt shape, not in prompt wording.** The
model receives only certified findings — no raw series — and is told to select,
never to discover. `parseNudge` then enforces that its chosen `signature` is one
we actually gave it; anything else returns `null` and the run sends nothing.

`title` and `body` are the APNs alert. `openingMessage` is what appears as the
coach's first chat message when the user taps (Task 15).

Follow the existing prompt/parse conventions in
`lib/proactiveAnalysisGeneration.ts` and `lib/proactiveAnalysisSchema.ts` rather
than inventing new ones.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVoiceRequest, parseNudge } from './voice';
import type { CertifiedFinding } from './types';

const finding: CertifiedFinding = {
  kind: 'cadence_break', signature: 'cadence_break:exercise_min', metrics: ['exercise_min'],
  effect: 4, effectLabel: '4 days since the last session', n: 28, pValue: null,
  detail: { daysSinceLast: 4, sessionsPerWeek: 5.5 }, confirmedOnRuns: 2,
};

const context = { goal: 'endurance', facts: ['Prefers Nepali food'], recentlySaid: [] };

test('the request carries the finding but never a raw series', () => {
  const request = buildVoiceRequest([finding], context);
  assert.ok(request.content.includes('cadence_break:exercise_min'));
  assert.ok(request.content.includes('4 days since the last session'));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(request.content), 'daily datapoints must not reach the model');
});

test('the system prompt tells the model to select, not to discover', () => {
  const request = buildVoiceRequest([finding], context);
  assert.match(request.system, /select/i);
  assert.match(request.system, /do not|never/i);
});

test('parses a well-formed response', () => {
  const nudge = parseNudge(JSON.stringify({
    signature: 'cadence_break:exercise_min',
    title: 'Four days off',
    body: "You've been steady at five a week. What happened?",
    openingMessage: "You've been training about five times a week, and it's been four days. What's going on?",
  }), ['cadence_break:exercise_min']);
  assert.ok(nudge);
  assert.equal(nudge.signature, 'cadence_break:exercise_min');
});

test('rejects a signature we never offered', () => {
  // The model inventing its own finding is the failure this guards.
  const nudge = parseNudge(JSON.stringify({
    signature: 'cross_lag:invented:whoop_recovery:1:down',
    title: 'x', body: 'y', openingMessage: 'z',
  }), ['cadence_break:exercise_min']);
  assert.equal(nudge, null);
});

test('rejects malformed JSON rather than throwing', () => {
  assert.equal(parseNudge('not json at all', ['cadence_break:exercise_min']), null);
});

test('rejects a response missing required fields', () => {
  assert.equal(
    parseNudge(JSON.stringify({ signature: 'cadence_break:exercise_min', title: 'x' }), ['cadence_break:exercise_min']),
    null,
  );
});

test('rejects empty or whitespace-only copy', () => {
  assert.equal(
    parseNudge(JSON.stringify({
      signature: 'cadence_break:exercise_min', title: '  ', body: 'y', openingMessage: 'z',
    }), ['cadence_break:exercise_min']),
    null,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/voice.test.ts`
Expected: FAIL — cannot find module `./voice`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { stripCompleteJsonFence } from '@/lib/proactiveAnalysisGrounding';
import type { CertifiedFinding } from './types';

export interface Nudge {
  signature: string;
  title: string;
  body: string;
  openingMessage: string;
}

export interface VoiceContext {
  goal: string | null;
  facts: string[];          // active ontology facts, already filtered to status = 'active'
  recentlySaid: string[];   // openings from recent nudges, so the coach doesn't repeat itself
}

const SYSTEM = `You are the user's coach, writing a short check-in notification.

You will be given a small list of findings that have ALREADY been established as
statistically real. Your job is to SELECT the single most useful one and say it
like a coach who knows this person.

Rules:
- Select one finding from the list. Do not invent a finding, and do not combine
  two findings into a claim neither supports.
- Never state a number that is not present in the finding you selected.
- The notification body is one or two sentences. Speak to the person, not about
  the data.
- If a finding is a broken training cadence, ask a real question rather than
  asserting why it happened. You do not know why.
- The openingMessage is what you will say first when they open the chat. It may
  be slightly longer, and it should invite an answer.

Respond with JSON only:
{"signature": "...", "title": "...", "body": "...", "openingMessage": "..."}`;

/**
 * Builds the request from certified findings only.
 *
 * The safety property is structural, not a matter of wording: the model never
 * receives a raw series, so it has nothing to pattern-match on. It is choosing
 * among established facts, which is a task it is good at.
 */
export function buildVoiceRequest(
  findings: CertifiedFinding[],
  context: VoiceContext,
): { system: string; content: string } {
  const lines: string[] = ['Established findings (select exactly one):', ''];

  for (const finding of findings) {
    const detail = Object.entries(finding.detail)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    lines.push(
      `- signature: ${finding.signature}`,
      `  what: ${finding.kind} on ${finding.metrics.join(' + ')}`,
      `  magnitude: ${finding.effectLabel}`,
      `  supporting: ${detail} (n=${finding.n})`,
      '',
    );
  }

  if (context.goal) lines.push(`The user's stated goal: ${context.goal}`, '');
  if (context.facts.length > 0) {
    lines.push('What you know about them:', ...context.facts.map((fact) => `- ${fact}`), '');
  }
  if (context.recentlySaid.length > 0) {
    lines.push('You recently said (do not repeat yourself):',
      ...context.recentlySaid.map((said) => `- ${said}`), '');
  }

  return { system: SYSTEM, content: lines.join('\n') };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parses the model's response and enforces that its chosen signature is one we
 * actually offered. A model that invents a finding gets discarded entirely —
 * the run then sends nothing, which is the correct outcome.
 */
export function parseNudge(raw: string, allowedSignatures: string[]): Nudge | null {
  // Strip a markdown fence before parsing. A model told "respond with JSON
  // only" still sometimes wraps its output in ```json ... ```, and this repo
  // already paid for that once — see stripCompleteJsonFence's use in
  // parseAnalysisText. Without it a fenced reply is indistinguishable from
  // malformed JSON, so the run silently sends nothing: safe, but it degrades
  // the whole feature to zero nudges while looking perfectly healthy.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCompleteJsonFence(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (!nonEmpty(record.signature) || !allowedSignatures.includes(record.signature)) return null;
  if (!nonEmpty(record.title) || !nonEmpty(record.body) || !nonEmpty(record.openingMessage)) return null;

  return {
    signature: record.signature,
    title: record.title.trim(),
    body: record.body.trim(),
    openingMessage: record.openingMessage.trim(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/voice.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/insights/voice.ts lib/insights/voice.test.ts
git commit -m "feat(insights): voice a certified finding without exposing raw data"
```

---

## Task 14: Worker orchestration, delivery caps, and the dry-run flag

**Files:**
- Create: `lib/insights/nudgeWorker.ts`
- Test: `lib/insights/nudgeWorker.test.ts`
- Modify: `scripts/proactive-health-worker.ts`

**Interfaces:**
- Consumes: every prior module.
- Produces: `withinDeliveryCaps(history: SentNudge[], now: Date, kind: string): boolean`, `insightsEnabled(env: NodeJS.ProcessEnv): 'off' | 'dry-run' | 'live'`, `runInsightPass(deps: InsightPassDeps): Promise<InsightPassOutcome>`, `interface SentNudge { kind: string; sentAt: Date }`.

Read `scripts/proactive-health-worker.ts` first. `tick()` already sequences
stages via `reportStage`; add one stage rather than standing up a second worker
process. Deep links use the `vital://` scheme and push payloads carry
`{ type, id, deepLink }` — follow `analysisAlert` exactly.

**The dry-run flag is how this ships safely.** `VITAL_INSIGHTS_MODE` reads
`off` (default), `dry-run` (compute and log, deliver nothing), or `live`. Run a
week in `dry-run` and read what it *would* have said before letting it say
anything. Follow the env-var-as-kill-switch pattern already used by
`PROACTIVE_NOTIFICATION_FRESHNESS_HOURS`.

Test the two pure functions directly. `runInsightPass` takes its dependencies as
an argument so the orchestration is testable without a database — mirror the
`WorkerRepository` interface style in `lib/proactiveHealthWorker.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import { insightsEnabled, withinDeliveryCaps } from './nudgeWorker';

const now = new Date('2026-09-07T15:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

test('mode defaults to off when unset', () => {
  assert.equal(insightsEnabled({}), 'off');
});

test('mode reads dry-run and live, and rejects anything else', () => {
  assert.equal(insightsEnabled({ VITAL_INSIGHTS_MODE: 'dry-run' }), 'dry-run');
  assert.equal(insightsEnabled({ VITAL_INSIGHTS_MODE: 'live' }), 'live');
  assert.equal(insightsEnabled({ VITAL_INSIGHTS_MODE: 'nonsense' }), 'off');
});

test('allows a nudge with no history', () => {
  assert.equal(withinDeliveryCaps([], now, 'cadence_break'), true);
});

test('blocks a second nudge on the same day', () => {
  assert.equal(
    withinDeliveryCaps([{ kind: 'trend', sentAt: new Date('2026-09-07T08:00:00Z') }], now, 'cadence_break'),
    false,
  );
});

test('blocks a fourth nudge in a week', () => {
  const history = [
    { kind: 'trend', sentAt: daysAgo(2) },
    { kind: 'level_shift', sentAt: daysAgo(4) },
    { kind: 'cross_lag', sentAt: daysAgo(6) },
  ];
  assert.equal(withinDeliveryCaps(history, now, 'cadence_break'), false);
});

test('blocks the same kind inside its 14-day cooldown', () => {
  assert.equal(
    withinDeliveryCaps([{ kind: 'cadence_break', sentAt: daysAgo(10) }], now, 'cadence_break'),
    false,
  );
});

test('allows the same kind once the cooldown has expired', () => {
  assert.equal(
    withinDeliveryCaps([{ kind: 'cadence_break', sentAt: daysAgo(15) }], now, 'cadence_break'),
    true,
  );
});

test('counts the weekly cap on a rolling window, not a calendar week', () => {
  const history = [
    { kind: 'trend', sentAt: daysAgo(8) },
    { kind: 'level_shift', sentAt: daysAgo(9) },
    { kind: 'cross_lag', sentAt: daysAgo(10) },
  ];
  assert.equal(withinDeliveryCaps(history, now, 'cadence_break'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test lib/insights/nudgeWorker.test.ts`
Expected: FAIL — cannot find module `./nudgeWorker`.

- [ ] **Step 3: Write the pure functions**

```typescript
import { COOLDOWN_DAYS } from './arbiter';

export interface SentNudge { kind: string; sentAt: Date }

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_DAY = 1;
const MAX_PER_WEEK = 3;

/**
 * Rollout control. `off` by default so merging this ships nothing; `dry-run`
 * computes and logs without delivering. Same env-var-as-kill-switch pattern as
 * PROACTIVE_NOTIFICATION_FRESHNESS_HOURS — flip via a Fly secret, no redeploy.
 */
export function insightsEnabled(env: NodeJS.ProcessEnv): 'off' | 'dry-run' | 'live' {
  const value = env.VITAL_INSIGHTS_MODE;
  return value === 'dry-run' || value === 'live' ? value : 'off';
}

/**
 * A coach who notices everything out loud is a nag. These caps are also the
 * last line of defence against a residual false positive: even a finding that
 * slips every statistical gate can only be said once a fortnight.
 */
export function withinDeliveryCaps(history: SentNudge[], now: Date, kind: string): boolean {
  const since = (days: number) => now.getTime() - days * DAY_MS;

  if (history.filter((n) => n.sentAt.getTime() >= since(1)).length >= MAX_PER_DAY) return false;
  if (history.filter((n) => n.sentAt.getTime() >= since(7)).length >= MAX_PER_WEEK) return false;
  if (history.some((n) => n.kind === kind && n.sentAt.getTime() >= since(COOLDOWN_DAYS))) return false;

  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test lib/insights/nudgeWorker.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add `runInsightPass` and wire it into the worker**

In the same file, add `runInsightPass(deps)` sequencing:
`loadSeries` → detectors → `applyEvidenceGate` → `recordFindings` →
`previousRunSignatures` + `confirmAgainstPreviousRun` → `shortlist` →
`buildVoiceRequest` / `parseNudge` → caps check → insert into `pending_nudges`
with `finding_kind` set → deliver via the injected APNs sender.

Every one of these must produce **no nudge and no error**: no established
baselines, no candidates, nothing confirmed, an empty shortlist, a null parse,
or caps exceeded. In `dry-run`, stop before delivery and
`console.log(JSON.stringify({ stage: 'insight-dry-run', userId, nudge }))` —
matching the existing structured worker logging in
`lib/proactiveHealthWorkerSupport.ts`.

Then in `scripts/proactive-health-worker.ts`, inside `tick()`, after the
existing stages:

```typescript
  if (insightsEnabled(process.env) !== 'off') {
    reportStage('insight-pass');
    await runDueInsightPasses(now);
  }
```

Push payload for a nudge, following `analysisAlert`'s shape:
`{ type: 'coach_nudge', id: <pendingNudgeId>, deepLink: 'vital://coach-nudge/<pendingNudgeId>' }`.

- [ ] **Step 6: Verify the whole suite and the build**

Run: `npm test`
Expected: PASS, including the null-data canary.
Run: `npx tsc --noEmit && npm run build:worker`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/insights/nudgeWorker.ts lib/insights/nudgeWorker.test.ts scripts/proactive-health-worker.ts
git commit -m "feat(insights): run the insight pass behind a dry-run flag"
```

---

## Task 15: Coach chat accepts a finding

**Files:**
- Modify: `app/api/coach/route.ts`
- Test: extend the nearest existing coach route test

**Interfaces:**
- Consumes: `schema.pending_nudges`, `schema.insight_findings`.
- Produces: `/api/coach` accepts an optional `findingId`.

When the user taps a nudge, the chat must open already knowing what the coach
asked about. `findingId` is the `pending_nudges.id` from the deep link; the
route loads that nudge's finding and passes it into context assembly so the
coach can discuss it instead of asking the user to re-explain.

Read `lib/brain/context.ts` before changing the shape — follow how existing
context is assembled rather than bolting on a parallel path.

- [ ] **Step 1: Write the failing test**

Assert three behaviours:
1. A request with a valid `findingId` includes the finding's `effectLabel` in the assembled context.
2. A `findingId` belonging to **another user** is ignored entirely — no context, no error leak. (This is an IDOR; the nudge id is a UUID but must still be scoped by `user_id`.)
3. A malformed or unknown `findingId` degrades to a normal chat rather than failing the request.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test <the coach route test path>`

- [ ] **Step 3: Implement**

Parse `findingId` from the request body. Look up the nudge with
`and(eq(pending_nudges.id, findingId), eq(pending_nudges.user_id, userId))` —
**the user_id predicate is required, not optional.** On a hit, add the stored
finding summary to the assembled context; on a miss, proceed as a normal chat.

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/coach/route.ts lib/brain/context.ts
git commit -m "feat(coach): open a chat with the nudge's finding in context"
```

---

## Task 16: iOS — the nudge opens a seeded chat

**Files:**
- Modify: `ios/Vital/Sources/Core/ProactiveNotifications.swift`
- Modify: `ios/Vital/Sources/App/RootView.swift`
- Test: `ios/Vital/Tests/ProactiveNotificationsTests.swift`

**Interfaces:**
- Consumes: the `coach_nudge` push payload from Task 14.
- Produces: `PushRoute.coachNudge(String)`.

`PushRoute` already parses `userInfo["deepLink"]` and switches on the payload
`type` (see the `workoutAnalysis` / `sleepAnalysis` / `morningBrief` cases).
Add one case, matching the existing style exactly.

**This task is why the feature is worth building.** PR #120 shipped a proactive
notification whose tap opened a no-op sheet. A nudge that asks "what happened?"
and then refuses to listen is worse than silence.

- [ ] **Step 1: Write the failing test**

In `ProactiveNotificationsTests.swift`, following the existing `PushRoute` test
style:

```swift
func testParsesCoachNudgeRoute() {
    let userInfo: [AnyHashable: Any] = [
        "type": "coach_nudge",
        "id": "abc-123",
        "deepLink": "vital://coach-nudge/abc-123",
    ]
    XCTAssertEqual(PushRoute(userInfo: userInfo), .coachNudge("abc-123"))
}

func testRejectsCoachNudgeWithMismatchedHost() {
    let userInfo: [AnyHashable: Any] = [
        "type": "coach_nudge",
        "id": "abc-123",
        "deepLink": "vital://something-else/abc-123",
    ]
    XCTAssertNil(PushRoute(userInfo: userInfo))
}
```

- [ ] **Step 2: Run it and watch it fail**

Run the iOS test suite. Expected: compile failure — `coachNudge` is not a member
of `PushRoute`.

⚠️ Simulator builds in this repo need an **explicit device UUID**; a plain
`-destination 'platform=iOS Simulator,name=...,OS=latest'` fails on the
OS-version mismatch. Use `xcrun simctl list devices available` and pass the UUID.

- [ ] **Step 3: Implement**

Add to `PushRoute`:

```swift
case coachNudge(String)
```

Add to the `id` switch:

```swift
case .coachNudge(let id): "nudge:\(id)"
```

Add to the parsing switch, alongside the existing cases:

```swift
case "coach_nudge" where url.host == "coach-nudge": self = .coachNudge(id)
```

Then in `RootView.swift`, handle `.coachNudge(let id)` by selecting the coach
tab and passing the id through to the chat, which sends it as `findingId` on its
first `/api/coach` call (Task 15) and renders the nudge's `openingMessage` as
the coach's first message.

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/Vital/Sources/Core/ProactiveNotifications.swift ios/Vital/Sources/App/RootView.swift ios/Vital/Tests/ProactiveNotificationsTests.swift
git commit -m "feat(ios): open the coach chat from a nudge, pre-seeded"
```

---

## Done criteria

- [ ] `npm test` passes, including the null-data canary.
- [ ] `npx tsc --noEmit` and `npm run build:worker` are clean.
- [ ] The generated migration contains no `DROP` statements.
- [ ] iOS suite passes.
- [ ] `VITAL_INSIGHTS_MODE` is unset (or `off`) at merge — **the feature ships dark.**
- [ ] Open a PR against `main`. Do not merge; the user reviews.

## Known deferred risk — read before scaling the worker

`runDueInsightPasses` uses an **in-memory** per-user-per-day gate to avoid
re-running the pass on every ~15s tick. That gate is process-local, and
`withinDeliveryCaps` is check-then-act with no uniqueness constraint on
`pending_nudges`. On a single worker machine (today's `fly.toml`, which sets no
explicit count) this is fine.

**If the `worker` process group is ever scaled past one machine**, two replicas
would each pass their own gate for the same user on the same day, each make a
separate model call, and could each deliver — producing two nudges in a day and
defeating the "one per day" promise this feature is built around. Every other
queue in this worker (`workout_analyses`, `sleep_analyses`,
`morning_notification_slots`) uses atomic claim-with-lease in the database for
exactly this reason.

Making it durable is the prerequisite for scaling: add a `local_day` column to
`pending_nudges` with a unique index on `(user_id, local_day)`, so the daily cap
is a database invariant rather than a racy read. Not done now because the
deployment is single-machine and the consequence is a duplicate notification,
not an incorrect health claim.

## Blockers before `VITAL_INSIGHTS_MODE=live`

The final whole-branch review found five issues that do not block merge (the
feature ships dark) but **must be resolved before any real user is nudged**.
Listed in the order I'd take them.

1. **The nudge's prose is ungrounded.** `parseNudge` validates the chosen
   signature and that three strings are non-empty. Nothing checks the words. The
   rule "never state a number not present in the finding" is prompt-only. This
   repo already owns `lib/proactiveAnalysisGrounding.ts`, which validates output
   against its evidence — `voice.ts` imports it, but only for fence-stripping.
   Wire up real grounding validation.

2. **The chat elaboration has no guardrail at all.** `lib/brain/context.ts`
   injects the finding's `kind`, `effectLabel`, and raw `detail` under an
   instruction to "discuss it directly", with nothing saying that a `cross_lag`
   finding is *correlational*. The push notification is at least authored under
   `voice.ts`'s system rules; the chat turn the user actually reads is authored
   under none of them. This is precisely where a certified rho becomes a causal
   story about someone's body.

3. **Storage-unit numbers reach both prompts unlabelled and unconverted.**
   `distance_m` is metres, `whoop_skin_temp` is °C, `body_mass_kg` is kg — and
   they are interpolated raw as `recentMean=8432`. `CoachContext.unitSystem`
   exists and every other numeric prompt section routes through
   `formatDistance`/`formatWeight`. This is the same class as the shipped
   imperial/metric incident.

4. **The canary tests the wrong null.** It builds random walks (lag-1 r ≈ 0.89),
   which is the regime `effectiveSampleSize` annihilates — hence 0/40. Real
   health metrics sit far closer to i.i.d., which is the adversarial direction
   for BH rather than for the autocorrelation correction. Add a low-φ / i.i.d.
   arm. Also note its bound (0.10) is numerically identical to `FDR_Q`, so it
   cannot distinguish "controlling correctly" from "saturated at the design
   limit".

5. **Cross-run confirmation is weaker than designed** — see the spec's amended
   section. Consecutive runs share 89 of 90 days, so confirmation removes ~25–40%
   of false positives rather than an order of magnitude. Either make the second
   test genuinely independent, or accept the residual rate and let the dry-run
   measure it on real data.

## After merge

1. Set the Fly secret `VITAL_INSIGHTS_MODE=dry-run`.
2. Leave it for a week. Read the `insight-dry-run` log lines: what would it have
   said, and would you have wanted to hear it?
3. Tune thresholds against that log, not against intuition. The defaults in
   Global Constraints are starting points.
4. Only then set `VITAL_INSIGHTS_MODE=live`.
