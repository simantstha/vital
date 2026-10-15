import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessWeightSignals,
  formatWeightSignalsSection,
  SIGNAL_MAX_WEIGH_IN_AGE_DAYS,
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

/** `n` consecutive daily readings from `startDate` on a straight line of `kgPerWeek` (negative = losing); raw == trend. */
function rawLine(startDate: string, n: number, startKg: number, kgPerWeek: number): WeightTrendDay[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const kg = Math.round((startKg + (kgPerWeek / 7) * i) * 1000) / 1000;
    return { day, rawKg: kg, trendKg: kg };
  });
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

test('too_fast_loss: fires (info) above 1.0%/wk, off the pace of the raw weigh-ins', () => {
  // A week flat, then falling 1.6 kg/wk: the 21-day least-squares pace is about -1.4%/wk, and the pace a week earlier was under 1%.
  const days = rawLine('2026-08-01', 22, 100, 0).map((d, i) => {
    const kg = Math.round((100 - (1.6 / 7) * Math.max(0, i - 6)) * 1000) / 1000;
    return { ...d, rawKg: kg, trendKg: kg };
  });
  const signals = assessWeightSignals({ trend: trendResult(days), dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  const sig = signals.find(s => s.kind === 'too_fast_loss');
  assert.ok(sig, 'too_fast_loss should fire');
  assert.equal(sig!.severity, 'info');
  assert.equal(sig!.facts.sustained, 'no');
  assert.ok((sig!.facts.pctPerWeek as number) > 1 && (sig!.facts.pctPerWeek as number) < 1.5);
  assert.ok((sig!.facts.rateKgPerWeek as number) < -1);
});

test('too_fast_loss: the quoted rate IS the pace of the raw weigh-ins (a straight 1.2 kg/wk line reads -1.2)', () => {
  const signals = assessWeightSignals({
    trend: trendResult(rawLine('2026-08-01', 22, 100, -1.2)), dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  });
  const sig = signals.find(s => s.kind === 'too_fast_loss');
  assert.ok(sig);
  assert.equal(sig!.facts.rateKgPerWeek, -1.2);
  assert.equal(sig!.facts.pctPerWeek, 1.2);
});

test('too_fast_loss: a pace under 1.0%/wk does NOT fire', () => {
  const trend = trendResult(rawLine('2026-08-01', 22, 100, -0.9));
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  assert.equal(signals.find(s => s.kind === 'too_fast_loss'), undefined);
});

test('too_fast_loss: escalates to watch above 1.5%/wk', () => {
  const trend = trendResult(rawLine('2026-08-01', 22, 100, -1.6));
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  const sig = signals.find(s => s.kind === 'too_fast_loss');
  assert.ok(sig);
  assert.equal(sig!.severity, 'watch');
  assert.ok(sig!.facts.pctPerWeek as number > TOO_FAST_LOSS_WATCH_PCT_PER_WEEK);
});

test('too_fast_loss: escalates to watch when sustained (the pace a week earlier was also over 1.0%/wk) even under 1.5%/wk', () => {
  const trend = trendResult(rawLine('2026-08-01', 36, 100, -1.2));
  const signals = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' });

  const sig = signals.find(s => s.kind === 'too_fast_loss');
  assert.ok(sig);
  assert.equal(sig!.severity, 'watch');
  assert.equal(sig!.facts.sustained, 'yes');
});

test('too_fast_loss: a pace needs 6 weigh-ins over 14 days of the last 21 — a steep week of 5 readings is not a pace', () => {
  const week = trendResult(rawLine('2026-08-01', 5, 100, -4));
  assert.equal(assessWeightSignals({ trend: week, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' }).find(s => s.kind === 'too_fast_loss'), undefined);
  // 8 readings, but they only span 7 days.
  const short = trendResult(rawLine('2026-08-01', 8, 100, -4));
  assert.equal(assessWeightSignals({ trend: short, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' }).find(s => s.kind === 'too_fast_loss'), undefined);
});

test('too_fast_loss: a drop across a 12-day gap in weigh-ins is not called while fewer than 3 weigh-ins are back', () => {
  // 15 daily weigh-ins losing 0.5 kg/wk, 12 days with no weigh-in, then the scale reads 1.5 kg lower.
  const before = rawLine('2026-08-01', 15, 100, -0.5);
  const lastBefore = before[before.length - 1].rawKg;
  const back = (n: number): WeightTrendDay[] => rawLine('2026-08-28', n, lastBefore - 2.6, -0.5);
  const run = (n: number) => assessWeightSignals({
    trend: trendResult([...before, ...back(n)]), dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  }).find(s => s.kind === 'too_fast_loss');
  assert.equal(run(1), undefined, 'first weigh-in back');
  assert.equal(run(2), undefined, 'second weigh-in back');
  assert.ok(run(3), 'three weigh-ins back: the pace may be called again');
});

test('too_fast_loss: a goal under 3 weeks old is an early read — no too_fast_loss; its start day is the gate', () => {
  const trend = trendResult(rawLine('2026-08-01', 17, 100, -2));
  const base = { trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss', todayKey: '2026-08-17' };
  assert.ok(assessWeightSignals(base).find(s => s.kind === 'too_fast_loss'), 'no goal start: only the data minimums apply');
  assert.equal(assessWeightSignals({ ...base, goalStartDay: '2026-08-01' }).find(s => s.kind === 'too_fast_loss'), undefined);
  assert.ok(assessWeightSignals({ ...base, goalStartDay: '2026-07-01' }).find(s => s.kind === 'too_fast_loss'));
});

test('too_fast_loss: never fires on a gain (positive pace)', () => {
  const trend = trendResult(rawLine('2026-08-01', 22, 100, 1.6));
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

/** Flat raw weigh-ins around `kg`: `perWeek` of them in each of `weeks` weeks ending on `endDay` (a Sunday). */
function flatWeeks(endDay: string, weeks: number, perWeek: number, kg: number, drift = 0): WeightTrendDay[] {
  const end = new Date(`${endDay}T00:00:00Z`).getTime();
  const out: WeightTrendDay[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    for (let i = 0; i < perWeek; i++) {
      const day = new Date(end - (w * 7 + (6 - i)) * 86_400_000).toISOString().slice(0, 10);
      const v = Math.round((kg + drift * (weeks - 1 - w)) * 100) / 100;
      out.push({ day, rawKg: v, trendKg: v });
    }
  }
  return out;
}

test('plateau: three flat weeks of RAW weekly means fire, with the weekly mean in the facts', () => {
  const trend = trendResult(flatWeeks('2026-08-30', 3, 4, 89.5));
  const sig = assessWeightSignals({ trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss', todayKey: '2026-08-30' })
    .find(s => s.kind === 'plateau');
  assert.ok(sig, 'plateau should fire');
  assert.equal(sig!.facts.weeklyMeanKg, 89.5);
  assert.equal(sig!.facts.weeks, 3);
});

test('plateau: needs 3+ weigh-ins in each of the three weeks', () => {
  const sparse = trendResult(flatWeeks('2026-08-30', 3, 2, 89.5));
  assert.equal(assessWeightSignals({ trend: sparse, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' }).find(s => s.kind === 'plateau'), undefined);
  const enough = trendResult(flatWeeks('2026-08-30', 3, 3, 89.5));
  assert.ok(assessWeightSignals({ trend: enough, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' }).find(s => s.kind === 'plateau'));
});

test('plateau: weekly means more than 0.2 kg apart are not a plateau; 0.2 kg is', () => {
  const drifting = trendResult(flatWeeks('2026-08-30', 3, 4, 89.5, -0.25));
  assert.equal(assessWeightSignals({ trend: drifting, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' }).find(s => s.kind === 'plateau'), undefined);
  const edge = trendResult(flatWeeks('2026-08-30', 3, 4, 89.5, -0.1));
  assert.ok(assessWeightSignals({ trend: edge, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' }).find(s => s.kind === 'plateau'));
});

test('plateau: the lagging trend no longer decides it — a flat raw scale fires even while the smoothed trend still slopes', () => {
  // Trend still falling at 0.3%/wk (the old 14-day test bottomed out above 0.1%/wk and never fired), raw weekly means flat.
  const days = flatWeeks('2026-08-30', 3, 4, 89.5).map((d, i, all) => ({ ...d, trendKg: Math.round((90.2 - (0.7 * i) / (all.length - 1)) * 100) / 100 }));
  const sig = assessWeightSignals({ trend: trendResult(days), dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss' })
    .find(s => s.kind === 'plateau');
  assert.ok(sig);
  assert.equal(sig!.facts.weeklyMeanKg, 89.5);
});

test('plateau: needs a goal at least 28 days old when the goal start is known', () => {
  const trend = trendResult(flatWeeks('2026-08-30', 3, 4, 89.5));
  const base = { trend, dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss', todayKey: '2026-08-30' };
  assert.equal(assessWeightSignals({ ...base, goalStartDay: '2026-08-10' }).find(s => s.kind === 'plateau'), undefined, 'goal is 21 days old');
  assert.ok(assessWeightSignals({ ...base, goalStartDay: '2026-08-02' }).find(s => s.kind === 'plateau'), 'goal is 29 days old');
});

// ── freshness: plateau / too_fast_loss need a weigh-in within the last 4 days ─

const TODAY = '2026-08-30';

/** A flat/steady trend of `spanDays + 1` days ending `ageDays` before TODAY. */
function trendEndingAgo(ageDays: number, spanDays: number, startKg: number, endKg: number): WeightTrendResult {
  const end = new Date(`${TODAY}T00:00:00Z`).getTime() - ageDays * 86_400_000;
  const start = new Date(end - spanDays * 86_400_000).toISOString().slice(0, 10);
  return trendResult(daysSpanning(start, spanDays, startKg, endKg));
}

test('plateau: needs a weigh-in within 4 days of TODAY (look back from today, not the last weigh-in)', () => {
  const kinds = (age: number) => assessWeightSignals({
    trend: trendEndingAgo(age, 20, 90, 90), dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss', todayKey: TODAY,
  }).map(s => s.kind);
  assert.deepEqual(kinds(0), ['plateau']);
  assert.deepEqual(kinds(4), ['plateau']);
  assert.deepEqual(kinds(5), []);
  assert.deepEqual(kinds(30), []);
});

test('too_fast_loss: needs a weigh-in within 4 days of TODAY', () => {
  const run = (age: number) => assessWeightSignals({
    trend: trendEndingAgo(age, 21, 106, 100),
    dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss', todayKey: TODAY,
  }).map(s => s.kind);
  assert.deepEqual(run(2), ['too_fast_loss']);
  assert.deepEqual(run(4), ['too_fast_loss']);
  assert.deepEqual(run(5), []);
  assert.deepEqual(run(21), []);
});

test('without todayKey the newest weigh-in stands in for today (no freshness check)', () => {
  const old = assessWeightSignals({
    trend: trendEndingAgo(60, 20, 90, 90), dailyIntakeKcal: noIntake(), floorKcal: DEFAULT_FLOOR, goal: 'weight_loss',
  });
  assert.ok(old.some(s => s.kind === 'plateau'));
  assert.equal(SIGNAL_MAX_WEIGH_IN_AGE_DAYS, 4);
});

// ── prompt rendering: small imperial rates keep a decimal ────────────────────

test('formatWeightSignalsSection: a 0.4 lb/wk rate is not rendered as "0 lb/wk"', () => {
  const days = daysSpanning('2026-08-01', 20, 80, 79.82); // ~0.06 kg/wk
  const trend = trendResult(days);
  const imperial = formatWeightSignalsSection(trend, [], 'imperial').join('\n');
  assert.match(imperial, /\(0\.\d lb\/wk loss\)/);
  assert.doesNotMatch(imperial, /\(0 lb\/wk/);
  // A rate of a pound or more stays whole.
  const fast = trendResult(daysSpanning('2026-08-01', 20, 80, 78));
  assert.match(formatWeightSignalsSection(fast, [], 'imperial').join('\n'), /\(\d+ lb\/wk loss\)/);
  assert.match(formatWeightSignalsSection(trend, [], 'metric').join('\n'), /\(0\.\d kg\/wk loss\)/);
});

// ── the coach's weight-trend line quotes the shared pace, and never a stale one ──

test('formatWeightSignalsSection: the quoted rate is the pace of the raw weigh-ins, not a lagging trend slope', () => {
  // The smoothed trend still reads flat (80.0 throughout) while the scale has been falling 0.9 kg/wk.
  const days = rawLine('2026-08-01', 22, 85, -0.9).map(d => ({ ...d, trendKg: 80 }));
  const lines = formatWeightSignalsSection(trendResult(days), [], 'metric', '2026-08-22');
  assert.match(lines.join('\n'), /- Trend weight: 80\.0 kg \(0\.9 kg\/wk loss\)/);
});

test('formatWeightSignalsSection: never quotes a rate when the newest weigh-in is more than 7 days old', () => {
  const trend = trendResult(rawLine('2026-08-01', 22, 85, -0.9));
  const fresh = formatWeightSignalsSection(trend, [], 'metric', '2026-08-29'); // newest weigh-in 7 days ago
  assert.match(fresh.join('\n'), /kg\/wk loss\)/);
  const stale = formatWeightSignalsSection(trend, [], 'metric', '2026-08-30').join('\n'); // 8 days ago
  assert.doesNotMatch(stale, /kg\/wk/);
  assert.match(stale, /last weigh-in 8 days ago — do not quote a weekly rate/);
});

test('formatWeightSignalsSection: no pace yet (under 6 weigh-ins over 14 days) says so instead of inventing a rate', () => {
  const lines = formatWeightSignalsSection(trendResult(rawLine('2026-08-01', 10, 85, -0.9)), [], 'metric', '2026-08-10').join('\n');
  assert.doesNotMatch(lines, /kg\/wk/);
  assert.match(lines, /weekly rate not available yet — do not quote one/);
});
