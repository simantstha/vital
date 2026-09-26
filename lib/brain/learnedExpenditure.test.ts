import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeLearnedExpenditure,
  WINDOW_DAYS,
  MIN_LOGGED_DAYS,
  KCAL_PER_KG,
  CLAMP_FRACTION,
  MAX_WEEKLY_MOVE_FRACTION,
  type DailyIntakeKcalPoint,
} from './learnedExpenditure';
import type { WeightTrendDay, WeightTrendResult } from '../weightTrend';

// ── Fixture builders (mirrors weightSignals.test.ts's style) ────────────────

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Linear trend from startTrendKg to endTrendKg over `days` calendar days (inclusive), starting at `startDate`. */
function trendSpanning(startDate: string, days: number, startTrendKg: number, endTrendKg: number): WeightTrendResult {
  const n = days + 1;
  const trendDays: WeightTrendDay[] = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(startDate, i);
    const trendKg = n === 1 ? startTrendKg : startTrendKg + ((endTrendKg - startTrendKg) * i) / (n - 1);
    trendDays.push({ day, rawKg: trendKg, trendKg });
  }
  return {
    days: trendDays,
    delta7dKgPerWeek: null,
    delta30dKgPerWeek: null,
    established: true,
  };
}

/** `n` consecutive logged days at `kcal`, starting at `startDate`. */
function loggedDays(startDate: string, n: number, kcal: number): DailyIntakeKcalPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    day: addDays(startDate, i),
    kcal,
    source: 'logged' as const,
  }));
}

const START = '2026-08-01';

// ── Stable weight → learned TDEE ≈ intake ───────────────────────────────────

test('stable weight: learned TDEE lands close to average logged intake', () => {
  const intake = loggedDays(START, 28, 2200);
  const trend = trendSpanning(START, 27, 80, 80); // no weight change
  const result = computeLearnedExpenditure(intake, trend, 2200);

  assert.equal(result.confidence, 'medium');
  assert.equal(result.method, 'learned');
  assert.ok(Math.abs(result.tdee - 2200) <= 5, `expected ~2200, got ${result.tdee}`);
});

// ── Losing 0.5 kg/wk on 1,800 kcal → ~2,350 ────────────────────────────────

test('losing 0.5 kg/wk on 1,800 kcal/day intake yields TDEE around 2,350', () => {
  const intake = loggedDays(START, 28, 1800);
  // 0.5 kg/wk over 27 days ≈ 27/7 * 0.5 = 1.9286 kg lost.
  const totalLossKg = (27 / 7) * 0.5;
  const trend = trendSpanning(START, 27, 85, 85 - totalLossKg);
  const result = computeLearnedExpenditure(intake, trend, 1800);

  // learnedTDEE = avgIntake - (deltaKg * 7700 / days) = 1800 + (0.5*7700/7) ≈ 2350
  assert.equal(result.confidence, 'medium');
  assert.ok(Math.abs(result.tdee - 2350) <= 15, `expected ~2350, got ${result.tdee}`);
});

// ── Sparse logging → confidence none ────────────────────────────────────────

test('sparse logging (few days) yields confidence none and falls back to formula', () => {
  const intake = loggedDays(START, 5, 2000); // well under MIN_LOGGED_DAYS
  const trend = trendSpanning(START, 27, 80, 79);
  const result = computeLearnedExpenditure(intake, trend, 2400);

  assert.equal(result.confidence, 'none');
  assert.equal(result.method, 'formula');
  assert.equal(result.tdee, 2400);
});

test('too few logged days relative to window (low fraction) yields confidence none', () => {
  // 10 logged days (meets MIN_LOGGED_DAYS) but scattered across a much wider
  // span by leaving gaps — simulate via non-consecutive days far apart.
  const intake: DailyIntakeKcalPoint[] = [];
  let day = START;
  for (let i = 0; i < MIN_LOGGED_DAYS; i++) {
    intake.push({ day, kcal: 2000, source: 'logged' });
    day = addDays(day, 5); // sparse — big gaps between logged days
  }
  const trend = trendSpanning(START, 60, 80, 78);
  const result = computeLearnedExpenditure(intake, trend, 2400);

  assert.equal(result.confidence, 'none');
  assert.equal(result.method, 'formula');
});

test('trend span under the minimum yields confidence none even with dense logging', () => {
  const intake = loggedDays(START, 28, 2000);
  const trend = trendSpanning(START, 8, 80, 79); // span < MIN_TREND_SPAN_DAYS (14)
  const result = computeLearnedExpenditure(intake, trend, 2400);

  assert.equal(result.confidence, 'none');
});

// ── Partial-log days excluded ───────────────────────────────────────────────

test('partial-log days (under 50% of formula TDEE) are excluded from the average, not treated as real low intake', () => {
  const formulaTdee = 2400;
  const goodDays = loggedDays(START, 20, 2000);
  const partialDays: DailyIntakeKcalPoint[] = Array.from({ length: 8 }, (_, i) => ({
    day: addDays(START, 20 + i),
    kcal: 100, // well under 50% of 2400 — a "logged only coffee" day
    source: 'logged' as const,
  }));
  const intake = [...goodDays, ...partialDays];
  const trend = trendSpanning(START, 27, 80, 79.5);

  const result = computeLearnedExpenditure(intake, trend, formulaTdee);

  // Only the 20 good days should count as loggedDays.
  assert.equal(result.loggedDays, 20);
  assert.ok(result.notes.some(n => n.includes('partial')));
});

// ── Clamping ────────────────────────────────────────────────────────────────

test('an extreme implied TDEE is clamped to within CLAMP_FRACTION of the formula estimate', () => {
  const formulaTdee = 2000;
  // Enormous, implausible weight loss over the window to force a huge raw
  // learned TDEE (avgIntake - hugely negative surplus).
  const intake = loggedDays(START, 28, 1800);
  const trend = trendSpanning(START, 27, 100, 70); // 30kg lost in 27 days — not realistic
  const result = computeLearnedExpenditure(intake, trend, formulaTdee);

  const clampHigh = formulaTdee * (1 + CLAMP_FRACTION);
  assert.ok(result.tdee <= Math.round(clampHigh) + 1, `expected <= ~${clampHigh}, got ${result.tdee}`);
  assert.ok(result.notes.some(n => n.includes('clamped')));
});

test('never returns a TDEE below the absolute floor', () => {
  const formulaTdee = 900;
  const intake = loggedDays(START, 28, 500);
  const trend = trendSpanning(START, 27, 60, 65); // gaining while eating very little — implausible, forces a low raw estimate
  const result = computeLearnedExpenditure(intake, trend, formulaTdee);

  assert.ok(result.tdee >= 800);
});

// ── Blend at low confidence ──────────────────────────────────────────────────

test('low confidence blends toward the formula estimate rather than using pure learned', () => {
  // Meets minimums (10 logged days, 60% fraction, 14+ day trend span) but
  // below MEDIUM thresholds (18 logged days / 21 day span).
  const intake = loggedDays(START, 16, 1800); // 16 logged days, < MEDIUM_MIN_LOGGED_DAYS (18)
  const trend = trendSpanning(START, 15, 85, 84.5); // span 15 days, >= MIN_TREND_SPAN_DAYS (14)
  const formulaTdee = 2400;
  const result = computeLearnedExpenditure(intake, trend, formulaTdee);

  assert.equal(result.confidence, 'low');
  assert.equal(result.method, 'blend');
  // Blend must land strictly between the raw learned number and the formula,
  // not equal to the formula, since some learned signal is applied.
  assert.notEqual(result.tdee, formulaTdee);
});

test('medium confidence uses the learned number directly (no blend)', () => {
  const intake = loggedDays(START, 22, 2100); // >= MEDIUM_MIN_LOGGED_DAYS (18), < HIGH_MIN_LOGGED_DAYS (25)
  const trend = trendSpanning(START, 21, 82, 81.5); // span 21 days, >= MEDIUM_MIN_SPAN_DAYS, < HIGH_MIN_SPAN_DAYS (28)
  const result = computeLearnedExpenditure(intake, trend, 2400);

  assert.equal(result.confidence, 'medium');
  assert.equal(result.method, 'learned');
});

// ── Week-to-week movement cap ─────────────────────────────────────────────

test('caps how far the learned TDEE can move from a previous value', () => {
  const intake = loggedDays(START, 28, 1500); // would imply a much lower TDEE than before
  const trend = trendSpanning(START, 27, 90, 89.8);
  const previousTdee = 2500;
  const result = computeLearnedExpenditure(intake, trend, 2400, { previousTdee });

  const maxDelta = previousTdee * MAX_WEEKLY_MOVE_FRACTION;
  assert.ok(result.tdee >= previousTdee - maxDelta - 1);
  assert.ok(result.notes.some(n => n.includes('Capped movement')));
});

test('does not cap when the new estimate is already within the allowed movement', () => {
  const intake = loggedDays(START, 28, 2200);
  const trend = trendSpanning(START, 27, 80, 80);
  const previousTdee = 2210; // very close already
  const result = computeLearnedExpenditure(intake, trend, 2200, { previousTdee });

  assert.ok(!result.notes.some(n => n.includes('Capped movement')));
});

test('previousTdee with no previousTdeeAt is treated as a full week elapsed (full cap applies)', () => {
  const intake = loggedDays(START, 28, 1500);
  const trend = trendSpanning(START, 27, 90, 89.8);
  const previousTdee = 2500;
  const withNoAt = computeLearnedExpenditure(intake, trend, 2400, { previousTdee });
  const withFullWeekAt = computeLearnedExpenditure(intake, trend, 2400, {
    previousTdee,
    previousTdeeAt: new Date('2026-07-01T00:00:00Z'), // 7+ days before `now` default
    now: new Date('2026-07-08T00:00:00Z'),
  });

  assert.equal(withNoAt.tdee, withFullWeekAt.tdee);
});

test('elapsed-time scaling: a call minutes after the previous one allows almost no movement', () => {
  const intake = loggedDays(START, 28, 1500); // implies a much lower raw learned TDEE
  const trend = trendSpanning(START, 27, 90, 89.8);
  const previousTdee = 2500;
  const now = new Date('2026-08-15T12:05:00Z');
  const previousTdeeAt = new Date('2026-08-15T12:00:00Z'); // 5 minutes earlier

  const result = computeLearnedExpenditure(intake, trend, 2400, { previousTdee, previousTdeeAt, now });

  // 5 minutes / (7 days) is a tiny fraction of MAX_WEEKLY_MOVE_FRACTION —
  // the result must stay essentially pinned to previousTdee.
  assert.ok(Math.abs(result.tdee - previousTdee) <= 1, `expected ~no movement, got ${result.tdee} vs previous ${previousTdee}`);
});

test('elapsed-time scaling: a call a full week later allows the full MAX_WEEKLY_MOVE_FRACTION', () => {
  const intake = loggedDays(START, 28, 1500);
  const trend = trendSpanning(START, 27, 90, 89.8);
  const previousTdee = 2500;
  const now = new Date('2026-08-22T12:00:00Z');
  const previousTdeeAt = new Date('2026-08-15T12:00:00Z'); // exactly 7 days earlier

  const result = computeLearnedExpenditure(intake, trend, 2400, { previousTdee, previousTdeeAt, now });

  const maxDelta = previousTdee * MAX_WEEKLY_MOVE_FRACTION;
  assert.ok(Math.abs(result.tdee - previousTdee) <= maxDelta + 1);
  // And it should have moved close to the full allowed amount, since the
  // raw target (well below 2500) is far enough away to keep pulling.
  assert.ok(previousTdee - result.tdee >= maxDelta - 2, `expected close to the full weekly cap, got delta ${previousTdee - result.tdee} vs max ${maxDelta}`);
});

test('elapsed-time scaling: more than a week elapsed is still capped at exactly one week\'s worth, no catch-up', () => {
  const intake = loggedDays(START, 28, 1500);
  const trend = trendSpanning(START, 27, 90, 89.8);
  const previousTdee = 2500;
  const oneWeekLater = computeLearnedExpenditure(intake, trend, 2400, {
    previousTdee,
    previousTdeeAt: new Date('2026-08-15T12:00:00Z'),
    now: new Date('2026-08-22T12:00:00Z'), // +7 days
  });
  const threeWeeksLater = computeLearnedExpenditure(intake, trend, 2400, {
    previousTdee,
    previousTdeeAt: new Date('2026-08-15T12:00:00Z'),
    now: new Date('2026-09-05T12:00:00Z'), // +21 days
  });

  assert.equal(oneWeekLater.tdee, threeWeeksLater.tdee, 'movement should not compound past one week\'s worth in a single call');
});

// ── Window trimming ──────────────────────────────────────────────────────

test('only the trailing WINDOW_DAYS of intake are considered', () => {
  const staleDays = loggedDays('2026-01-01', 10, 5000); // way outside the window, extreme value
  const recentDays = loggedDays(START, 28, 2200);
  const intake = [...staleDays, ...recentDays];
  const trend = trendSpanning(START, 27, 80, 80);
  const result = computeLearnedExpenditure(intake, trend, 2200);

  assert.ok(Math.abs(result.tdee - 2200) <= 5);
});

// ── Empty input ──────────────────────────────────────────────────────────

test('empty intake returns the formula estimate with confidence none', () => {
  const trend = trendSpanning(START, 27, 80, 80);
  const result = computeLearnedExpenditure([], trend, 2300);

  assert.equal(result.confidence, 'none');
  assert.equal(result.tdee, 2300);
  assert.equal(result.daysUsed, 0);
});

test('WINDOW_DAYS constant is 28 and KCAL_PER_KG is the Wishnofsky 7700 approximation', () => {
  assert.equal(WINDOW_DAYS, 28);
  assert.equal(KCAL_PER_KG, 7700);
});
