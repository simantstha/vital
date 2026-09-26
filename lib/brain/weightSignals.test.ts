import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessWeightSignals,
  TOO_FAST_LOSS_PCT_PER_WEEK,
  TOO_FAST_LOSS_WATCH_PCT_PER_WEEK,
  RATE_RELIABLE_MIN_SPAN_DAYS,
  PLATEAU_MIN_SPAN_DAYS,
  PARTIAL_LOG_KCAL_THRESHOLD,
  type DailyIntakeKcalPoint,
} from './weightSignals';
import type { WeightTrendDay, WeightTrendResult } from '../weightTrend';

/** Builds a fake WeightTrendResult day array: `spanDays + 1` consecutive days
 *  from `startDate`, with trendKg linearly interpolated from `startTrendKg`
 *  to `endTrendKg` — precise enough to hit the %/wk thresholds under test. */
function daysSpanning(startDate: string, spanDays: number, startTrendKg: number, endTrendKg: number): WeightTrendDay[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const days: WeightTrendDay[] = [];
  const n = spanDays + 1;
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    const trendKg = n === 1 ? startTrendKg : startTrendKg + ((endTrendKg - startTrendKg) * i) / (n - 1);
    days.push({ day, rawKg: trendKg, trendKg });
  }
  return days;
}

function trendResult(days: WeightTrendDay[], opts: {
  delta7dKgPerWeek?: number | null;
  delta30dKgPerWeek?: number | null;
  established?: boolean;
} = {}): WeightTrendResult {
  return {
    days,
    delta7dKgPerWeek: opts.delta7dKgPerWeek ?? null,
    delta30dKgPerWeek: opts.delta30dKgPerWeek ?? null,
    established: opts.established ?? true,
  };
}

function noIntake(): DailyIntakeKcalPoint[] {
  return [];
}

const DEFAULT_FLOOR = 1200;

// ── too_fast_loss ────────────────────────────────────────────────────────

test('too_fast_loss: fires (info) just above the 1.0%/wk threshold, established + span >= 7', () => {
  const days = daysSpanning('2026-08-01', 10, 100, 100); // trendKg=100 throughout, span=10
  const trend = trendResult(days, { delta7dKgPerWeek: -1.2, delta30dKgPerWeek: -0.5 });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  const sig = signals.find(s => s.kind === 'too_fast_loss');
  assert.ok(sig, 'too_fast_loss should fire');
  assert.equal(sig!.severity, 'info');
  assert.equal(sig!.facts.rateKgPerWeek, -1.2);
  assert.equal(sig!.facts.pctPerWeek, 1.2);
});

test('too_fast_loss: exactly 1.0%/wk does NOT fire (strictly greater-than)', () => {
  const days = daysSpanning('2026-08-01', 10, 100, 100);
  const trend = trendResult(days, { delta7dKgPerWeek: -1.0, delta30dKgPerWeek: null });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  assert.equal(signals.find(s => s.kind === 'too_fast_loss'), undefined);
});

test('too_fast_loss: escalates to watch above 1.5%/wk', () => {
  const days = daysSpanning('2026-08-01', 10, 100, 100);
  const trend = trendResult(days, { delta7dKgPerWeek: -1.6, delta30dKgPerWeek: -0.5 });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  const sig = signals.find(s => s.kind === 'too_fast_loss');
  assert.ok(sig);
  assert.equal(sig!.severity, 'watch');
  assert.ok(sig!.facts.pctPerWeek as number > TOO_FAST_LOSS_WATCH_PCT_PER_WEEK);
});

test('too_fast_loss: escalates to watch when sustained (both 7d and 30d rates > 1.0%/wk) even under 1.5%/wk', () => {
  const days = daysSpanning('2026-08-01', 35, 100, 100);
  const trend = trendResult(days, { delta7dKgPerWeek: -1.2, delta30dKgPerWeek: -1.1 });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  const sig = signals.find(s => s.kind === 'too_fast_loss');
  assert.ok(sig);
  assert.equal(sig!.severity, 'watch');
  assert.equal(sig!.facts.sustained, 'yes');
});

test('too_fast_loss: never fires on a gain (positive delta)', () => {
  const days = daysSpanning('2026-08-01', 10, 100, 100);
  const trend = trendResult(days, { delta7dKgPerWeek: 1.6, delta30dKgPerWeek: 1.6 });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  assert.equal(signals.find(s => s.kind === 'too_fast_loss'), undefined);
});

test('too_fast_loss: never fires when the trend is not established', () => {
  const days = daysSpanning('2026-08-01', 10, 100, 100);
  const trend = trendResult(days, { delta7dKgPerWeek: -1.6, delta30dKgPerWeek: -1.6, established: false });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  assert.equal(signals.length, 0);
});

// ── plateau ──────────────────────────────────────────────────────────────

test('plateau: fires (info) when the goal is weight_loss, span >= 14, and the 14-day change is flat', () => {
  // trendKg constant across the whole span -> 14-day change is exactly 0%.
  const days = daysSpanning('2026-08-01', 20, 90, 90);
  const trend = trendResult(days);
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  const sig = signals.find(s => s.kind === 'plateau');
  assert.ok(sig, 'plateau should fire');
  assert.equal(sig!.severity, 'info');
});

test('plateau: a non-weight-loss goal suppresses the signal even with a flat trend', () => {
  const days = daysSpanning('2026-08-01', 20, 90, 90);
  const trend = trendResult(days);

  for (const goal of ['muscle', 'endurance', 'general']) {
    const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal });
    assert.equal(signals.find(s => s.kind === 'plateau'), undefined, `goal=${goal} must not plateau`);
  }
});

test('plateau: does not fire with span under 14 days even if flat', () => {
  const days = daysSpanning('2026-08-01', 10, 90, 90);
  const trend = trendResult(days);
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  assert.equal(signals.find(s => s.kind === 'plateau'), undefined);
  assert.equal(PLATEAU_MIN_SPAN_DAYS, 14);
});

test('plateau: a real ongoing loss (well above 0.1%/wk over 14d) does not fire', () => {
  const days = daysSpanning('2026-08-01', 20, 95, 90); // steadily dropping
  const trend = trendResult(days);
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  assert.equal(signals.find(s => s.kind === 'plateau'), undefined);
});

// ── under_eating ─────────────────────────────────────────────────────────

const ESTABLISHED_TREND: WeightTrendResult = trendResult(daysSpanning('2026-08-01', 20, 80, 80));

test('under_eating: fires (watch) when >= 3 of 7 days have data and the average is under the floor', () => {
  const intake: DailyIntakeKcalPoint[] = [
    { day: '2026-08-10', kcal: 1000, source: 'logged' },
    { day: '2026-08-11', kcal: 1100, source: 'logged' },
    { day: '2026-08-12', kcal: 900, source: 'healthkit' },
    { day: '2026-08-13', kcal: null, source: 'none' },
    { day: '2026-08-14', kcal: null, source: 'none' },
    { day: '2026-08-15', kcal: null, source: 'none' },
    { day: '2026-08-16', kcal: null, source: 'none' },
  ];
  const signals = assessWeightSignals({
    trend: ESTABLISHED_TREND, dailyIntakeKcal: intake, floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  });

  const sig = signals.find(s => s.kind === 'under_eating');
  assert.ok(sig, 'under_eating should fire');
  assert.equal(sig!.severity, 'watch');
  assert.equal(sig!.facts.daysCounted, 3);
  assert.equal(sig!.facts.excludedPartialLogs, 0);
  assert.equal(sig!.facts.avgKcal, 1000);
});

test('under_eating: does not fire with fewer than 3 non-none days', () => {
  const intake: DailyIntakeKcalPoint[] = [
    { day: '2026-08-10', kcal: 900, source: 'logged' },
    { day: '2026-08-11', kcal: 900, source: 'logged' },
    { day: '2026-08-12', kcal: null, source: 'none' },
  ];
  const signals = assessWeightSignals({
    trend: ESTABLISHED_TREND, dailyIntakeKcal: intake, floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  });

  assert.equal(signals.find(s => s.kind === 'under_eating'), undefined);
});

test('under_eating: does not fire when the average is at/above the floor', () => {
  const intake: DailyIntakeKcalPoint[] = [
    { day: '2026-08-10', kcal: 1400, source: 'logged' },
    { day: '2026-08-11', kcal: 1500, source: 'logged' },
    { day: '2026-08-12', kcal: 1300, source: 'healthkit' },
  ];
  const signals = assessWeightSignals({
    trend: ESTABLISHED_TREND, dailyIntakeKcal: intake, floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  });

  assert.equal(signals.find(s => s.kind === 'under_eating'), undefined);
});

test('under_eating: excludes likely-partial logged days (< 300 kcal, source logged) from the average, and reports the exclusion count', () => {
  assert.equal(PARTIAL_LOG_KCAL_THRESHOLD, 300);
  const intake: DailyIntakeKcalPoint[] = [
    { day: '2026-08-10', kcal: 200, source: 'logged' },   // partial log -> excluded
    { day: '2026-08-11', kcal: 1100, source: 'logged' },
    { day: '2026-08-12', kcal: 1000, source: 'logged' },
    { day: '2026-08-13', kcal: 900, source: 'healthkit' }, // <300 but not 'logged' -> NOT excluded... (not the case here, kept for clarity)
  ];
  const signals = assessWeightSignals({
    trend: ESTABLISHED_TREND, dailyIntakeKcal: intake, floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  });

  const sig = signals.find(s => s.kind === 'under_eating');
  assert.ok(sig, 'under_eating should fire');
  assert.equal(sig!.facts.excludedPartialLogs, 1);
  assert.equal(sig!.facts.daysCounted, 3);
  // avg of 1100, 1000, 900 = 1000
  assert.equal(sig!.facts.avgKcal, 1000);
});

test('under_eating: a HealthKit day under the partial-log threshold is NOT excluded (only source=logged is)', () => {
  const intake: DailyIntakeKcalPoint[] = [
    { day: '2026-08-10', kcal: 100, source: 'healthkit' },
    { day: '2026-08-11', kcal: 100, source: 'healthkit' },
    { day: '2026-08-12', kcal: 100, source: 'healthkit' },
  ];
  const signals = assessWeightSignals({
    trend: ESTABLISHED_TREND, dailyIntakeKcal: intake, floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  });

  const sig = signals.find(s => s.kind === 'under_eating');
  assert.ok(sig);
  assert.equal(sig!.facts.excludedPartialLogs, 0);
  assert.equal(sig!.facts.daysCounted, 3);
});

test('under_eating: does not depend on the weight trend at all (fires even when not established)', () => {
  const unestablished = trendResult([], { established: false });
  const intake: DailyIntakeKcalPoint[] = [
    { day: '2026-08-10', kcal: 900, source: 'logged' },
    { day: '2026-08-11', kcal: 900, source: 'logged' },
    { day: '2026-08-12', kcal: 900, source: 'logged' },
  ];
  const signals = assessWeightSignals({
    trend: unestablished, dailyIntakeKcal: intake, floorKcal: DEFAULT_FLOOR, goal: 'general',
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'under_eating');
});

// ── rate_not_yet_reliable ────────────────────────────────────────────────

test('rate_not_yet_reliable: fires (info) when established but span is under 7 days (span=6)', () => {
  const days = daysSpanning('2026-08-01', 6, 80, 79);
  const trend = trendResult(days);
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'general' });

  const sig = signals.find(s => s.kind === 'rate_not_yet_reliable');
  assert.ok(sig, 'rate_not_yet_reliable should fire at span=6');
  assert.equal(sig!.severity, 'info');
  assert.equal(sig!.facts.spanDays, 6);
});

test('rate_not_yet_reliable: does not fire once span reaches 7 days', () => {
  const days = daysSpanning('2026-08-01', 7, 80, 79);
  const trend = trendResult(days, { delta7dKgPerWeek: -0.5 });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'general' });

  assert.equal(signals.find(s => s.kind === 'rate_not_yet_reliable'), undefined);
  assert.equal(RATE_RELIABLE_MIN_SPAN_DAYS, 7);
});

test('rate_not_yet_reliable: does not fire when the trend is not established at all', () => {
  const days = daysSpanning('2026-08-01', 2, 80, 79); // short, unestablished history
  const trend = trendResult(days, { established: false });
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'general' });

  assert.equal(signals.length, 0);
});

test('sanity: TOO_FAST_LOSS_PCT_PER_WEEK constant matches the documented 1.0%/wk threshold', () => {
  assert.equal(TOO_FAST_LOSS_PCT_PER_WEEK, 1.0);
});

// ── weekend_overeating ───────────────────────────────────────────────────

/** 2026-08-03 is a Monday — builds `days` consecutive local days from there with `weekdayKcal` Mon-Fri and `weekendKcal` Sat/Sun, all 'logged'. */
function weekendWindow(startDate: string, days: number, weekdayKcal: number, weekendKcal: number): DailyIntakeKcalPoint[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const out: DailyIntakeKcalPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    out.push({ day, kcal: isWeekend ? weekendKcal : weekdayKcal, source: 'logged' });
  }
  return out;
}

const MONDAY_START = '2026-08-03';
const NO_TREND = trendResult(daysSpanning('2026-08-01', 2, 80, 80), { established: false });

test('weekend_overeating: fires when weekend avg exceeds weekday avg by both > 25% and > 400 kcal', () => {
  // Weekday 2000 kcal, weekend 2800 kcal: +800 kcal (+40%) — clears both bars.
  const weekendPatternIntakeKcal = weekendWindow(MONDAY_START, 28, 2000, 2800);
  const signals = assessWeightSignals({
    trend: NO_TREND,
    dailyIntakeKcal: noIntake(),
    floorKcal: DEFAULT_FLOOR,
    goal: 'weight_loss',
    weekendPatternIntakeKcal,
  });

  const sig = signals.find(s => s.kind === 'weekend_overeating');
  assert.ok(sig, 'weekend_overeating should fire');
  assert.equal(sig!.severity, 'info');
  assert.equal(sig!.facts.weekdayAvgKcal, 2000);
  assert.equal(sig!.facts.weekendAvgKcal, 2800);
  assert.equal(sig!.facts.diffKcal, 800);
  assert.equal(sig!.facts.diffPct, 40);
});

test('weekend_overeating: does not fire when the % difference is above threshold but the absolute kcal gap is not', () => {
  // Weekday 1000, weekend 1400: +400 kcal exactly (+40%), diff must be > 400, not >=.
  const weekendPatternIntakeKcal = weekendWindow(MONDAY_START, 28, 1000, 1400);
  const signals = assessWeightSignals({
    trend: NO_TREND,
    dailyIntakeKcal: noIntake(),
    floorKcal: DEFAULT_FLOOR,
    goal: 'weight_loss',
    weekendPatternIntakeKcal,
  });

  assert.equal(signals.find(s => s.kind === 'weekend_overeating'), undefined);
});

test('weekend_overeating: does not fire when the absolute kcal gap is above threshold but the % difference is not', () => {
  // Weekday 3000, weekend 3450: +450 kcal but only 15% — must clear BOTH bars.
  const weekendPatternIntakeKcal = weekendWindow(MONDAY_START, 28, 3000, 3450);
  const signals = assessWeightSignals({
    trend: NO_TREND,
    dailyIntakeKcal: noIntake(),
    floorKcal: DEFAULT_FLOOR,
    goal: 'weight_loss',
    weekendPatternIntakeKcal,
  });

  assert.equal(signals.find(s => s.kind === 'weekend_overeating'), undefined);
});

test('weekend_overeating: does not fire with too few logged weekday days', () => {
  // Only 4 logged weekday days total (below WEEKEND_PATTERN_MIN_WEEKDAY_DAYS).
  const weekendPatternIntakeKcal: DailyIntakeKcalPoint[] = [
    { day: '2026-08-03', kcal: 2000, source: 'logged' }, // Mon
    { day: '2026-08-04', kcal: 2000, source: 'logged' }, // Tue
    { day: '2026-08-05', kcal: 2000, source: 'logged' }, // Wed
    { day: '2026-08-06', kcal: 2000, source: 'logged' }, // Thu
    { day: '2026-08-01', kcal: 2900, source: 'logged' }, // Sat
    { day: '2026-08-02', kcal: 2900, source: 'logged' }, // Sun
    { day: '2026-08-08', kcal: 2900, source: 'logged' }, // Sat
    { day: '2026-08-09', kcal: 2900, source: 'logged' }, // Sun
  ];
  const signals = assessWeightSignals({
    trend: NO_TREND,
    dailyIntakeKcal: noIntake(),
    floorKcal: DEFAULT_FLOOR,
    goal: 'weight_loss',
    weekendPatternIntakeKcal,
  });

  assert.equal(signals.find(s => s.kind === 'weekend_overeating'), undefined);
});

test('weekend_overeating: does not fire with too few logged weekend days', () => {
  const weekendPatternIntakeKcal = weekendWindow(MONDAY_START, 12, 2000, 2900).filter(
    d => !(d.day === '2026-08-08' || d.day === '2026-08-09'), // drop one weekend
  );
  const signals = assessWeightSignals({
    trend: NO_TREND,
    dailyIntakeKcal: noIntake(),
    floorKcal: DEFAULT_FLOOR,
    goal: 'weight_loss',
    weekendPatternIntakeKcal,
  });

  assert.equal(signals.find(s => s.kind === 'weekend_overeating'), undefined);
});

test('weekend_overeating: is skipped entirely when weekendPatternIntakeKcal is omitted', () => {
  const signals = assessWeightSignals({
    trend: NO_TREND,
    dailyIntakeKcal: noIntake(),
    floorKcal: DEFAULT_FLOOR,
    goal: 'weight_loss',
  });

  assert.equal(signals.find(s => s.kind === 'weekend_overeating'), undefined);
});

test('weekend_overeating: excludes partial/no-data days from both averages', () => {
  const base = weekendWindow(MONDAY_START, 28, 2000, 2800);
  // Sprinkle in some 'none' days that should be excluded, not counted as 0.
  const weekendPatternIntakeKcal: DailyIntakeKcalPoint[] = base.map((d, i) =>
    i % 10 === 0 ? { ...d, kcal: null, source: 'none' as const } : d,
  );
  const signals = assessWeightSignals({
    trend: NO_TREND,
    dailyIntakeKcal: noIntake(),
    floorKcal: DEFAULT_FLOOR,
    goal: 'weight_loss',
    weekendPatternIntakeKcal,
  });

  const sig = signals.find(s => s.kind === 'weekend_overeating');
  assert.ok(sig, 'weekend_overeating should still fire ignoring none-days');
  assert.equal(sig!.facts.weekdayAvgKcal, 2000);
  assert.equal(sig!.facts.weekendAvgKcal, 2800);
});
