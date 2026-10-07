import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeWeeklyReview,
  lastCompletedWeekStart,
  REVIEW_HEADLINE_MAX_CHARS,
  type WeeklyReview,
  type WeeklyReviewInput,
} from './weeklyReview';
import { liftChange4w } from './liftChange';
import type { WeightReading } from './weightTrend';
import type { ProgressionSummary } from './workoutRepository';

// Tuesday 2026-10-06 → last completed week is Mon 2026-09-28 … Sun 2026-10-04.
const WEEK_START = '2026-09-28';
const PREV_START = '2026-09-21';
const WEEK = Array.from({ length: 7 }, (_, i) => addDays(WEEK_START, i));
const PREV = Array.from({ length: 7 }, (_, i) => addDays(PREV_START, i));

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weigh(days: string[], kgAt: (i: number) => number): WeightReading[] {
  return days.map((day, i) => ({ measuredAt: `${day}T07:00:00.000Z`, valueKg: kgAt(i), source: 'manual' as const, localDay: day }));
}

function intake(days: string[], kcal: number[], protein = 150) {
  return days.map((day, i) => ({ day, kcal: kcal[i] ?? null, proteinG: kcal[i] == null ? null : protein, source: 'logged' as const }));
}

function base(over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  return {
    goal: 'weight_loss',
    weekStart: WEEK_START,
    verdict: 'on_track',
    weightReadings: [],
    intakeDays: [],
    budget: { targetKcal: 2000, proteinG: 150, floorKcal: 1500, formulaTdee: null, learnedTdee: null, tdeeConfidence: null },
    trainingDays: [],
    workouts: [],
    progression: {},
    restingHr: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    weeklySessionsTarget: null,
    unitSystem: 'metric',
    ...over,
  };
}

function statByLabel(r: WeeklyReview, label: string) {
  return r.stats.find(s => s.label === label);
}

function assertWellFormed(r: WeeklyReview): void {
  assert.ok(r.headline.length <= REVIEW_HEADLINE_MAX_CHARS, `headline too long: ${r.headline}`);
  assert.ok(r.stats.length <= 4);
  assert.equal(r.weekStart, WEEK_START);
  assert.equal(r.weekEnd, '2026-10-04');
  assert.ok(r.nextWeek.length > 0);
}

test('lastCompletedWeekStart: Tuesday, Monday and Sunday all review the week that just ended', () => {
  assert.equal(lastCompletedWeekStart('2026-10-06'), WEEK_START); // Tue
  assert.equal(lastCompletedWeekStart('2026-10-05'), WEEK_START); // Mon
  assert.equal(lastCompletedWeekStart('2026-10-04'), PREV_START); // Sun — week not complete yet
});

// ── weight loss ─────────────────────────────────────────────────────────────

const weightLossInput = (over: Partial<WeeklyReviewInput> = {}) =>
  base({
    weightReadings: weigh([...PREV, ...WEEK], i => 82 - i * 0.07),
    intakeDays: intake([...PREV, ...WEEK], [
      2300, 2250, 2400, 2300, 2350, 2500, 2450, // prior week
      1900, 1950, 2000, 1850, 2050, 2450, 2500, // this week: 5/7 in budget, weekend over
    ]),
    trainingDays: [WEEK[1], WEEK[3], WEEK[5], PREV[2]],
    ...over,
  });

test('weight_loss: weight change, days in budget, avg kcal, workouts, weekend nextWeek', () => {
  const r = computeWeeklyReview(weightLossInput());
  assertWellFormed(r);
  assert.equal(r.goal, 'weight_loss');
  assert.equal(r.verdict, 'on_track');
  assert.deepEqual(r.stats.map(s => s.label), ['Weight trend', 'Days in budget', 'Avg calories', 'Workouts']);
  const weight = statByLabel(r, 'Weight trend')!;
  assert.match(weight.value, /^−\d\.\d kg$/);
  assert.equal(weight.tone, 'good');
  const budget = statByLabel(r, 'Days in budget')!;
  assert.equal(budget.value, '5/7');
  assert.equal(budget.tone, 'good');
  assert.match(statByLabel(r, 'Avg calories')!.comparison ?? '', /vs last week/);
  assert.equal(statByLabel(r, 'Workouts')!.value, '3');
  assert.match(r.headline, /^Down \d\.\d kg, in budget 5 of 7 days$/);
  assert.ok(r.win);
  assert.match(r.slip ?? '', /Weekends ran \+\d+ kcal/);
  assert.equal(r.nextWeek, "Plan Saturday's dinner ahead so the weekend lands closer to your weekday average.");
  assert.notEqual(r.nextWeek, r.slip);
  assert.equal(r.dataSufficiency.sufficient, true);
});

test('weight_loss: omits stats it lacks data for (no budget logging, no weigh-ins)', () => {
  const r = computeWeeklyReview(base({
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    intakeDays: intake(WEEK.slice(0, 4), [2000, 2000, 2000, 2000]),
  }));
  // no weigh-ins → no weight stat; 4 logged days → budget + avg shown; sessions shown
  assert.equal(statByLabel(r, 'Weight trend'), undefined);
  assert.ok(statByLabel(r, 'Days in budget'));
  assert.equal(statByLabel(r, 'Days in budget')!.comparison, '4 days logged');
  assert.ok(r.stats.every(s => s.value.length > 0));
});

// ── muscle ──────────────────────────────────────────────────────────────────

test('muscle: sessions vs target, best lift change, protein days, weight', () => {
  const progression: ProgressionSummary = {
    'Bench Press': [
      { weekStart: PREV_START, bestEstimatedOneRepMaxKg: 100, volumeKg: 3000, totalSets: 9, totalReps: 45 },
      { weekStart: WEEK_START, bestEstimatedOneRepMaxKg: 102.5, volumeKg: 3200, totalSets: 10, totalReps: 50 },
    ],
    Squat: [{ weekStart: WEEK_START, bestEstimatedOneRepMaxKg: 140, volumeKg: 5000, totalSets: 12, totalReps: 60 }],
  };
  const r = computeWeeklyReview(base({
    goal: 'muscle',
    verdict: 'progressing',
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4], WEEK[5], PREV[1]],
    progression,
    intakeDays: intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
    weightReadings: weigh([...PREV, ...WEEK], i => 75 + i * 0.03),
  }));
  assertWellFormed(r);
  assert.deepEqual(r.stats.map(s => s.label), ['Sessions', 'Bench Press est. 1RM', 'Protein days hit', 'Weight trend']);
  const sessions = statByLabel(r, 'Sessions')!;
  assert.equal(sessions.value, '4');
  assert.equal(sessions.comparison, 'target 4 for the week');
  assert.equal(sessions.tone, 'good');
  assert.equal(statByLabel(r, 'Bench Press est. 1RM')!.value, '+2.5 kg');
  assert.equal(statByLabel(r, 'Protein days hit')!.value, '7/7');
  assert.match(statByLabel(r, 'Weight trend')!.value, /^\+/);
  assert.match(r.headline, /^4 of 4 sessions, Bench Press up 2\.5 kg$/);
});

test('muscle: missed session target becomes the slip and drives nextWeek', () => {
  const r = computeWeeklyReview(base({
    goal: 'muscle',
    verdict: 'behind' as never,
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[3]],
    intakeDays: intake(WEEK, [2800, 2800, 2800, 2800, 2800, 2800, 2800], 160),
  }));
  const sessions = statByLabel(r, 'Sessions')!;
  assert.equal(sessions.tone, 'watch');
  assert.equal(r.slip, '2 of 4 planned sessions done.');
  assert.equal(r.nextWeek, 'Put 4 sessions on the calendar now, before the week fills up.');
  assert.notEqual(r.nextWeek, r.slip);
});

// ── endurance ───────────────────────────────────────────────────────────────

test('endurance: sessions, km volume vs last week, resting HR trend, sleep avg', () => {
  const r = computeWeeklyReview(base({
    goal: 'endurance',
    verdict: 'building',
    trainingDays: [WEEK[0], WEEK[2], WEEK[5], PREV[0], PREV[3]],
    workouts: [
      { day: WEEK[0], durationMin: 40, distanceKm: 8 },
      { day: WEEK[2], durationMin: 45, distanceKm: 9 },
      { day: WEEK[5], durationMin: 80, distanceKm: 16 },
      { day: PREV[0], durationMin: 40, distanceKm: 8 },
      { day: PREV[3], durationMin: 50, distanceKm: 12 },
    ],
    restingHr: [...WEEK.map(day => ({ day, value: 50 })), ...PREV.map(day => ({ day, value: 53 }))],
    sleepMinutes: WEEK.map(day => ({ day, value: 450 })),
  }));
  assertWellFormed(r);
  assert.deepEqual(r.stats.map(s => s.label), ['Sessions', 'Volume', 'Resting HR', 'Avg sleep']);
  assert.equal(statByLabel(r, 'Volume')!.value, '33 km');
  assert.equal(statByLabel(r, 'Volume')!.comparison, '+65% vs last week');
  assert.equal(statByLabel(r, 'Volume')!.tone, 'good');
  const hr = statByLabel(r, 'Resting HR')!;
  assert.equal(hr.value, '50 bpm');
  assert.equal(hr.comparison, '−3 bpm vs last week');
  assert.equal(hr.tone, 'good');
  assert.equal(statByLabel(r, 'Avg sleep')!.value, '7h 30m');
  assert.match(r.headline, /^3 sessions, 33 km, \+65% vs last week$/);
});

test('endurance: falls back to minutes when no distance is recorded', () => {
  const r = computeWeeklyReview(base({
    goal: 'endurance',
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    workouts: [
      { day: WEEK[0], durationMin: 30, distanceKm: null },
      { day: WEEK[2], durationMin: 40, distanceKm: null },
      { day: WEEK[4], durationMin: 50, distanceKm: null },
    ],
  }));
  assert.equal(statByLabel(r, 'Volume')!.value, '120 min');
  assert.equal(statByLabel(r, 'Volume')!.comparison, 'for the week');
});

// ── general ─────────────────────────────────────────────────────────────────

test('general: active days, sleep-goal nights, logging days', () => {
  const r = computeWeeklyReview(base({
    goal: 'general',
    verdict: 'holding',
    trainingDays: [WEEK[0], WEEK[1], WEEK[3], WEEK[4]],
    sleepMinutes: WEEK.map((day, i) => ({ day, value: i < 5 ? 470 : 360 })),
    intakeDays: intake(WEEK.slice(0, 6), [2100, 2200, 2000, 2100, 2300, 2000]),
  }));
  assertWellFormed(r);
  assert.deepEqual(r.stats.map(s => s.label), ['Active days', 'Sleep-goal nights', 'Logging days']);
  assert.equal(statByLabel(r, 'Active days')!.value, '4');
  assert.equal(statByLabel(r, 'Sleep-goal nights')!.value, '5/7');
  assert.equal(statByLabel(r, 'Logging days')!.value, '6/7');
  assert.equal(r.headline, '4 active days, slept to goal 5 of 7 nights');
});

// ── insufficient data ───────────────────────────────────────────────────────

test('insufficient data: returns a gentle not-enough-data review with no stats and no invented numbers', () => {
  for (const goal of ['weight_loss', 'muscle', 'endurance', 'general'] as const) {
    const r = computeWeeklyReview(base({ goal, verdict: 'insufficient_data', trainingDays: [WEEK[2]] }));
    assert.equal(r.headline, 'Not enough data for a weekly review yet');
    assert.deepEqual(r.stats, []);
    assert.equal(r.win, null);
    assert.equal(r.slip, null);
    assert.match(r.nextWeek, /Log meals, weigh-ins or workouts/);
    assert.equal(r.dataSufficiency.sufficient, false);
    assert.equal(r.verdict, 'insufficient_data');
    assert.doesNotMatch(r.nextWeek, /\d/);
  }
});

test('insufficient data: three data days but fewer than two stats is still not enough', () => {
  const r = computeWeeklyReview(base({
    goal: 'general',
    trainingDays: [WEEK[0], WEEK[1], WEEK[2]],
  }));
  assert.equal(r.dataSufficiency.sufficient, false);
  assert.equal(r.dataSufficiency.daysWithData, 3);
});

// ── unit system ─────────────────────────────────────────────────────────────

test('imperial users see lb and miles; metric users see kg and km', () => {
  const metric = computeWeeklyReview(weightLossInput());
  const imperial = computeWeeklyReview(weightLossInput({ unitSystem: 'imperial' }));
  assert.match(statByLabel(metric, 'Weight trend')!.value, / kg$/);
  assert.match(statByLabel(imperial, 'Weight trend')!.value, / lb$/);
  assert.match(imperial.headline, / lb,/);
  assert.doesNotMatch(imperial.headline, /kg/);

  const run = (unitSystem: 'metric' | 'imperial') => computeWeeklyReview(base({
    goal: 'endurance',
    unitSystem,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    workouts: WEEK.slice(0, 3).map(day => ({ day, durationMin: 40, distanceKm: 10 })),
  }));
  assert.equal(statByLabel(run('metric'), 'Volume')!.value, '30 km');
  assert.equal(statByLabel(run('imperial'), 'Volume')!.value, '18.6 mi');
});

test('headline never exceeds 80 chars, even with a long lift name', () => {
  const r = computeWeeklyReview(base({
    goal: 'muscle',
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[1], WEEK[2], WEEK[3]],
    progression: {
      'Romanian Deadlift With Straps And Paused Eccentric Variation': [
        { weekStart: PREV_START, bestEstimatedOneRepMaxKg: 100, volumeKg: 1, totalSets: 3, totalReps: 9 },
        { weekStart: WEEK_START, bestEstimatedOneRepMaxKg: 105, volumeKg: 1, totalSets: 3, totalReps: 9 },
      ],
    },
  }));
  assert.ok(r.headline.length <= REVIEW_HEADLINE_MAX_CHARS);
});

// ── lift stat uses the shared 4-week definition ─────────────────────────────

const liftWk = (weekStart: string, e: number, sets = 6) => ({ weekStart, bestEstimatedOneRepMaxKg: e, volumeKg: 1, totalSets: sets, totalReps: 30 });

test('muscle: best-lift stat says "vs 4 weeks ago" when that window has data', () => {
  // anchor = WEEK_START (2026-09-28): recent {09-28, 09-21}, baseline {08-31, 08-24}
  const progression: ProgressionSummary = {
    'Bench Press': [liftWk('2026-08-31', 100), liftWk('2026-09-21', 104), liftWk(WEEK_START, 103)],
  };
  const r = computeWeeklyReview(base({
    goal: 'muscle', verdict: 'progressing', weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    progression,
    intakeDays: intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
  }));
  const lift = statByLabel(r, 'Bench Press est. 1RM')!;
  assert.equal(lift.value, '+4 kg'); // best(104, 103) - 100
  assert.equal(lift.comparison, 'vs 4 weeks ago');
});

test('muscle: without 4-weeks-ago data the lift stat is labelled "vs last trained week"', () => {
  const progression: ProgressionSummary = { 'Bench Press': [liftWk(PREV_START, 100), liftWk(WEEK_START, 102.5)] };
  const r = computeWeeklyReview(base({
    goal: 'muscle', verdict: 'progressing', weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    progression,
    intakeDays: intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
  }));
  assert.equal(statByLabel(r, 'Bench Press est. 1RM')!.comparison, 'vs last trained week');
});

test('weekly-review lift stat equals the shared definition for the same fixture', () => {
  const progression: ProgressionSummary = {
    'Bench Press': [liftWk('2026-08-31', 100), liftWk('2026-09-28', 106.2), liftWk('2026-10-05', 105)],
  };
  const review = computeWeeklyReview(base({
    goal: 'muscle', weekStart: '2026-10-05', verdict: 'progressing', weeklySessionsTarget: 3,
    trainingDays: ['2026-10-05', '2026-10-07', '2026-10-09'],
    progression,
    intakeDays: intake(Array.from({ length: 7 }, (_, i) => addDays('2026-10-05', i)), [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
  }));
  assert.equal(statByLabel(review, 'Bench Press est. 1RM')!.value, '+6.2 kg');
  assert.equal(liftChange4w(progression['Bench Press'], '2026-10-05')!.changeKg, 6.2);
});

// ── recovery-aware next week ────────────────────────────────────────────────

function enduranceRecovery(over: Partial<WeeklyReviewInput>): WeeklyReviewInput {
  return base({
    goal: 'endurance',
    verdict: 'on_track',
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    workouts: WEEK.slice(0, 3).map(day => ({ day, durationMin: 40, distanceKm: 8 })),
    ...over,
  });
}

test('nextWeek: 2 poor recovery signals → lighter week, never "repeat this week"', () => {
  const r = computeWeeklyReview(enduranceRecovery({
    restingHr: [...PREV.map(day => ({ day, value: 50 })), ...WEEK.map(day => ({ day, value: 56 }))],
    hrv: [...PREV.map(day => ({ day, value: 70 })), ...WEEK.map(day => ({ day, value: 55 }))],
  }));
  assert.match(r.nextWeek, /^Go lighter next week and put sleep first/);
  assert.match(r.nextWeek, /HRV ran below your normal and resting heart rate rose/);
  assert.doesNotMatch(r.nextWeek, /Repeat this week/);
});

test('nextWeek: short sleep + low HRV also triggers the lighter week', () => {
  const r = computeWeeklyReview(enduranceRecovery({
    hrv: [...PREV.map(day => ({ day, value: 70 })), ...WEEK.map(day => ({ day, value: 60 }))],
    sleepMinutes: WEEK.map(day => ({ day, value: 340 })),
  }));
  assert.match(r.nextWeek, /sleep averaged short/);
  assert.match(r.nextWeek, /^Go lighter/);
});

test('nextWeek: a single poor recovery signal still repeats a good week', () => {
  const r = computeWeeklyReview(enduranceRecovery({
    sleepMinutes: WEEK.map(day => ({ day, value: 340 })),
  }));
  assert.equal(r.nextWeek.startsWith('Go lighter'), false);
});

test('nextWeek is never a copy of the slip, for every goal fixture', () => {
  const goals = ['weight_loss', 'muscle', 'endurance', 'general'] as const;
  const inputs: WeeklyReviewInput[] = [weightLossInput()];
  for (const goal of goals) {
    inputs.push(base({
      goal,
      weeklySessionsTarget: 4,
      trainingDays: [WEEK[0]],
      // Over budget on few logged days, low protein, short sleep.
      intakeDays: intake(WEEK.slice(0, 3), [2600, 2700, 2650], 40),
      sleepMinutes: WEEK.map(day => ({ day, value: 300 })),
    }));
  }
  let withSlip = 0;
  for (const input of inputs) {
    const r = computeWeeklyReview(input);
    assert.ok(r.nextWeek.length > 0);
    if (r.slip != null) {
      withSlip++;
      assert.notEqual(r.nextWeek, r.slip, `${input.goal}: nextWeek repeats the slip`);
      assert.doesNotMatch(r.nextWeek, /\d+ of \d+/, `${input.goal}: nextWeek restates the slip's numbers`);
    }
  }
  assert.ok(withSlip > 0, 'fixtures should exercise at least one slip');
});
