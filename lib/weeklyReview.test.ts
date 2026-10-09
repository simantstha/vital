import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExerciseDisplay,
  signupLocalDay,
  computeWeeklyReview as computeWeeklyReviewRaw,
  lastCompletedWeekStart,
  REVIEW_HEADLINE_MAX_CHARS,
  type WeeklyReview,
  type WeeklyReviewInput,
} from './weeklyReview';
import { NBSP, plainSpaces } from './displayText';
import { computeGoalProgress, type GoalProgressInput } from './goalProgress';
import { liftChange4w, pickHeadlineLift } from './liftChange';
import type { WeightReading } from './weightTrend';
import type { ProgressionSummary } from './workoutRepository';

/**
 * Display copy glues numbers to their units (and "a → b" pairs) with U+00A0 so
 * a narrow line never wraps mid-value. Most tests read the copy with plain
 * spaces through this wrapper; the NBSP tests assert `computeWeeklyReviewRaw`.
 */
function computeWeeklyReview(input: WeeklyReviewInput): WeeklyReview {
  return JSON.parse(plainSpaces(JSON.stringify(computeWeeklyReviewRaw(input)))) as WeeklyReview;
}

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
  assert.deepEqual(r.stats.map(s => s.label), ['Weekly avg weight', 'Days in budget', 'Avg calories', 'Workouts']);
  const weight = statByLabel(r, 'Weekly avg weight')!;
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
  assert.equal(statByLabel(r, 'Weekly avg weight'), undefined);
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
  assert.deepEqual(r.stats.map(s => s.label), ['Sessions', 'Bench Press est. 1RM', 'Protein days hit', 'Weekly avg weight']);
  const sessions = statByLabel(r, 'Sessions')!;
  assert.equal(sessions.value, '4');
  assert.equal(sessions.comparison, 'target 4 for the week');
  assert.equal(sessions.tone, 'good');
  assert.equal(statByLabel(r, 'Bench Press est. 1RM')!.value, '+3 kg');
  assert.equal(statByLabel(r, 'Protein days hit')!.value, '7/7');
  assert.match(statByLabel(r, 'Weekly avg weight')!.value, /^\+/);
  assert.match(r.headline, /^4 of 4 sessions, Bench Press est\. 1RM \+3 kg vs last trained wk$/);
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
  // The week's one gap drives the Slip and Next week: two sessions short, put them back on the calendar.
  assert.deepEqual(r.weekGap, { kind: 'sessions', done: 2, target: 4 });
  assert.equal(r.slip, '2 of 4 sessions — two short');
  assert.equal(r.nextWeek, 'Book 4 sessions — lock in the missed ones now, starting with Saturday.');
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
  assert.match(statByLabel(metric, 'Weekly avg weight')!.value, / kg$/);
  assert.match(statByLabel(imperial, 'Weekly avg weight')!.value, / lb$/);
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
  assert.equal(statByLabel(review, 'Bench Press est. 1RM')!.value, '+6 kg');
  assert.equal(liftChange4w(progression['Bench Press'], '2026-10-05')!.changeKg, 6.2);
});

test('muscle: weekly review names the same headline lift as the goal card, labelled over 4 wks', () => {
  const progression: ProgressionSummary = {
    'Bench Press': [liftWk('2026-08-31', 99.2, 30), liftWk(WEEK_START, 107.9, 30)],
    Squat: [liftWk('2026-08-31', 120, 6), liftWk(WEEK_START, 140.4, 6)],
  };
  const r = computeWeeklyReview(base({
    goal: 'muscle', verdict: 'progressing', weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    progression,
    intakeDays: intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
  }));
  assert.equal(statByLabel(r, 'Squat est. 1RM')!.value, '+20 kg');
  assert.equal(statByLabel(r, 'Bench Press est. 1RM'), undefined);
  assert.equal(r.headline, '3 of 4 sessions, Squat est. 1RM +20 kg over 4 wks');
  assert.equal(pickHeadlineLift(progression, WEEK_START)!.exercise, 'Squat');
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

// ── verdict consistency ─────────────────────────────────────────────────────

test('partial logging: "in budget 3 of 3 logged days", not 3 of 7', () => {
  const r = computeWeeklyReview(base({
    weightReadings: weigh([...PREV, ...WEEK], i => 82 - i * 0.07),
    intakeDays: intake(WEEK.slice(0, 3), [1900, 1950, 2000]),
    trainingDays: [WEEK[1], WEEK[3]],
  }));
  const budget = statByLabel(r, 'Days in budget')!;
  assert.equal(budget.value, '3/3');
  assert.equal(budget.comparison, '3 days logged');
  assert.match(r.headline, /in budget 3 of 3 logged days/);
});

test('signupDay: days before signup do not count toward the data gate or the logged-day stats', () => {
  const backfilled = base({
    // HealthKit backfill: resting HR + workouts + sleep on days before the user signed up.
    restingHr: WEEK.map(day => ({ day, value: 55 })),
    sleepMinutes: WEEK.map(day => ({ day, value: 450 })),
    workouts: WEEK.map(day => ({ day, durationMin: 40, distanceKm: null })),
    trainingDays: WEEK,
    goal: 'general',
  });
  assert.equal(computeWeeklyReview(backfilled).dataSufficiency.sufficient, true);
  const signedUpSunday = computeWeeklyReview({ ...backfilled, signupDay: WEEK[6] });
  assert.equal(signedUpSunday.dataSufficiency.daysWithData, 1);
  assert.equal(signedUpSunday.dataSufficiency.sufficient, false);
});

test('lift names are display-cased in the stat and win text', () => {
  const r = computeWeeklyReview(base({
    goal: 'muscle',
    verdict: 'progressing',
    weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    progression: {
      'bench press': [
        { weekStart: '2026-08-31', bestEstimatedOneRepMaxKg: 100, volumeKg: 3000, totalSets: 9, totalReps: 45 },
        { weekStart: WEEK_START, bestEstimatedOneRepMaxKg: 105, volumeKg: 3200, totalSets: 10, totalReps: 50 },
      ],
    },
  }));
  const lift = r.stats.find(s => s.label.endsWith('est. 1RM'))!;
  assert.equal(lift.label, 'Bench Press est. 1RM');
});

test('a deload week with a lower e1RM is "Lighter week" and never a slip', () => {
  const mk = (weekStart: string, e: number, volumeKg: number) => ({ weekStart, bestEstimatedOneRepMaxKg: e, volumeKg, totalSets: 8, totalReps: 40 });
  const progression: ProgressionSummary = {
    'bench press': [
      mk('2026-08-24', 100, 3000), mk('2026-08-31', 100, 3000), mk('2026-09-07', 100, 3000),
      mk('2026-09-14', 100, 3000), mk('2026-09-21', 97, 3000), mk(WEEK_START, 96, 1200),
    ],
  };
  const lighter = computeWeeklyReview(base({
    goal: 'muscle', verdict: 'stalled', weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]], progression,
  }));
  const stat = lighter.stats.find(s => s.label.endsWith('est. 1RM'))!;
  assert.equal(stat.tone, 'neutral');
  assert.match(stat.comparison ?? '', /^Lighter week/);
  assert.doesNotMatch(lighter.slip ?? '', /estimated 1RM is down/);

  // Same drop at normal volume is still a slip.
  const normal = computeWeeklyReview(base({
    goal: 'muscle', verdict: 'stalled', weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    progression: { 'bench press': progression['bench press'].map(w => (w.weekStart === WEEK_START ? { ...w, volumeKg: 3000 } : w)) },
  }));
  assert.match(normal.slip ?? '', /Bench Press estimated 1RM is down/);
});

test('buildExerciseDisplay maps key to first non-empty display name', () => {
  const map = buildExerciseDisplay([
    { exercise: 'bench press', exercise_display: 'Bench Press' },
    { exercise: 'bench press', exercise_display: 'bench' },
    { exercise: 'squat', exercise_display: '  ' },
  ]);
  assert.deepEqual(map, { 'bench press': 'Bench Press' });
});

test('signupLocalDay uses the user timezone', () => {
  const at = new Date('2026-03-02T03:00:00Z');
  assert.equal(signupLocalDay(at, 'America/Los_Angeles'), '2026-03-01');
  assert.equal(signupLocalDay(at, 'UTC'), '2026-03-02');
  assert.equal(signupLocalDay(null, 'UTC'), null);
});

// ── weekRating: rates THIS week, never the 4-week goal verdict ──────────────

const run = (day: string, distanceKm: number | null, type: string | null = 'Running') => ({ day, durationMin: 45, distanceKm, type });

function muscleWeek(over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  return base({
    goal: 'muscle',
    verdict: 'progressing',
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4], WEEK[5]],
    intakeDays: intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
    ...over,
  });
}

test('weekRating muscle: sessions vs the weekly target — target good, target-1 mixed, fewer tough', () => {
  const rate = (days: string[]) => computeWeeklyReview(muscleWeek({ trainingDays: days })).weekRating;
  assert.equal(rate([WEEK[0], WEEK[2], WEEK[4], WEEK[5]]), 'good'); // 4 of 4
  assert.equal(rate([WEEK[0], WEEK[2], WEEK[4]]), 'mixed'); // 3 of 4
  assert.equal(rate([WEEK[0], WEEK[2]]), 'tough'); // 2 of 4
  assert.equal(rate([WEEK[0]]), 'tough'); // 1 of 4
});

test('weekRating muscle: 3 of 4 sessions is "mixed" even when the 4-week goal verdict is good (headline and pill agree)', () => {
  const progression: ProgressionSummary = {
    Squat: [liftWk('2026-08-31', 120, 6), liftWk(WEEK_START, 140.4, 6)],
  };
  const r = computeWeeklyReview(muscleWeek({ verdict: 'progressing', trainingDays: [WEEK[0], WEEK[2], WEEK[4]], progression }));
  assert.equal(r.headline, '3 of 4 sessions, Squat est. 1RM +20 kg over 4 wks');
  assert.equal(r.verdict, 'progressing');
  assert.equal(r.weekRating, 'mixed');
});

test('weekRating muscle: ignores the goal verdict in both directions', () => {
  // "Sessions behind" over the last 4 weeks, but this week hit every planned session.
  const behindButGoodWeek = computeWeeklyReview(muscleWeek({ verdict: 'behind' }));
  assert.equal(behindButGoodWeek.verdict, 'behind');
  assert.equal(behindButGoodWeek.weekRating, 'good');
  // A "progressing" goal verdict does not rescue a week with one session.
  const progressingButToughWeek = computeWeeklyReview(muscleWeek({ verdict: 'progressing', trainingDays: [WEEK[3]] }));
  assert.equal(progressingButToughWeek.weekRating, 'tough');
  // And the verdict never changes the rating for identical week stats.
  for (const verdict of ['on_track', 'ahead', 'too_fast', 'behind', 'stalled', 'progressing', 'building', 'holding', 'insufficient_data'] as const) {
    assert.equal(computeWeeklyReview(muscleWeek({ verdict })).weekRating, 'good', verdict);
  }
});

test('weekRating muscle: protein hit on under half the logged days pulls the week down one level', () => {
  const lowProtein = intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 40); // 0 of 7 days hit 150 g * 0.9
  assert.equal(computeWeeklyReview(muscleWeek({ intakeDays: lowProtein })).weekRating, 'mixed'); // 4 of 4 -> mixed
  assert.equal(computeWeeklyReview(muscleWeek({ intakeDays: lowProtein, trainingDays: [WEEK[0], WEEK[2], WEEK[4]] })).weekRating, 'tough'); // 3 of 4 -> tough
  // Strong protein never upgrades a missed-session week.
  assert.equal(computeWeeklyReview(muscleWeek({ trainingDays: [WEEK[0], WEEK[2], WEEK[4]] })).weekRating, 'mixed');
  // Fewer than 3 logged days: protein is not judged.
  const twoDays = computeWeeklyReview(muscleWeek({
    intakeDays: intake(WEEK.slice(0, 2), [2800, 2800], 40),
    weightReadings: weigh([...PREV, ...WEEK], i => 75 + i * 0.03), // keeps the review sufficient without a protein stat
  }));
  assert.equal(statByLabel(twoDays, 'Protein days hit'), undefined);
  assert.equal(twoDays.weekRating, 'good');
});

test('weekRating muscle: no weekly sessions target -> null (nothing honest to rate against)', () => {
  const r = computeWeeklyReview(muscleWeek({ weeklySessionsTarget: null }));
  assert.equal(r.dataSufficiency.sufficient, true);
  assert.equal(r.weekRating, null);
});

test('weekRating muscle: zero sessions is tough even for a 1-a-week target', () => {
  const r = computeWeeklyReview(muscleWeek({
    weeklySessionsTarget: 1,
    trainingDays: [PREV[1]], // trained last week only
    progression: { 'bench press': [liftWk(PREV_START, 100), liftWk(WEEK_START, 100)] },
  }));
  assert.equal(r.weekRating, 'tough');
});

test('weekRating muscle: a deliberate lighter week (volume < 60% of the prior 4-week average) is "light"', () => {
  const mk = (weekStart: string, volumeKg: number) => ({ weekStart, bestEstimatedOneRepMaxKg: 100, volumeKg, totalSets: 8, totalReps: 40 });
  const prior = [mk('2026-08-31', 3000), mk('2026-09-07', 3000), mk('2026-09-14', 3000), mk('2026-09-21', 3000)];
  const lighter: ProgressionSummary = { 'bench press': [...prior, mk(WEEK_START, 1200)] };
  const normal: ProgressionSummary = { 'bench press': [...prior, mk(WEEK_START, 2800)] };

  assert.equal(computeWeeklyReview(muscleWeek({ progression: lighter })).weekRating, 'light'); // 4 of 4
  assert.equal(computeWeeklyReview(muscleWeek({ progression: lighter, trainingDays: [WEEK[0], WEEK[2], WEEK[4]] })).weekRating, 'light'); // 3 of 4: still showed up
  assert.equal(computeWeeklyReview(muscleWeek({ progression: normal })).weekRating, 'good');
  // Low volume with most sessions missed is a missed week, not a deload.
  assert.equal(computeWeeklyReview(muscleWeek({ progression: lighter, trainingDays: [WEEK[0]] })).weekRating, 'tough');
  // No logged volume this week is "no data", not a deload.
  assert.equal(computeWeeklyReview(muscleWeek({ progression: { 'bench press': prior } })).weekRating, 'good');
});

test('weekRating weight_loss: in-budget share of logged days — 5/7 good, 3/7 mixed, below tough', () => {
  const rate = (kcal: number[]) => computeWeeklyReview(weightLossInput({
    intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, ...kcal]),
  })).weekRating;
  assert.equal(rate([1900, 1950, 2000, 1850, 2050, 2450, 2500]), 'good'); // 5 of 7
  assert.equal(rate([1900, 1950, 2000, 2400, 2450, 2500, 2450]), 'mixed'); // 3 of 7
  assert.equal(rate([1900, 1950, 2400, 2400, 2450, 2500, 2450]), 'tough'); // 2 of 7
});

test('weekRating weight_loss: scales to partial logging (3 of 3 logged days in budget is good)', () => {
  const r = computeWeeklyReview(base({
    weightReadings: weigh([...PREV, ...WEEK], i => 82 - i * 0.07),
    intakeDays: intake(WEEK.slice(0, 3), [1900, 1950, 2000]),
    trainingDays: [WEEK[1], WEEK[3]],
  }));
  assert.equal(r.weekRating, 'good');
});

test('weekRating weight_loss: weight moving the wrong way pulls the week down one level', () => {
  const r = computeWeeklyReview(weightLossInput({
    weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.1),
  }));
  assert.equal(statByLabel(r, 'Days in budget')!.value, '5/7');
  assert.equal(statByLabel(r, 'Weekly avg weight')!.tone, 'watch');
  assert.equal(r.weekRating, 'mixed'); // 5/7 in budget would be good
});

test('weekRating weight_loss: without usable budget days the weight direction alone rates the week', () => {
  const lossOnly = (kgAt: (i: number) => number) => computeWeeklyReview(base({
    weightReadings: weigh([...PREV, ...WEEK], kgAt),
    trainingDays: [WEEK[1], WEEK[3]],
  }));
  const down = lossOnly(i => 82 - i * 0.07);
  assert.equal(statByLabel(down, 'Days in budget'), undefined);
  assert.equal(down.weekRating, 'good');
  assert.equal(lossOnly(() => 82).weekRating, 'mixed'); // flat
  assert.equal(lossOnly(i => 80 + i * 0.1).weekRating, 'tough'); // up
});

test('weekRating endurance: running distance vs the weekly target — 90% good, 60% mixed, below tough', () => {
  const rate = (km: number[], over: Partial<WeeklyReviewInput> = {}) => computeWeeklyReview(base({
    goal: 'endurance',
    verdict: 'building',
    weeklyDistanceKmTarget: 30,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    workouts: km.map((k, i) => run(WEEK[i * 2], k)),
    ...over,
  })).weekRating;
  assert.equal(rate([10, 10, 10]), 'good'); // 100%
  assert.equal(rate([9, 9, 9]), 'good'); // exactly 90%
  assert.equal(rate([8, 8, 8.5]), 'mixed'); // 24.5 of 30 = 82%
  assert.equal(rate([6, 6, 6]), 'mixed'); // exactly 60%
  assert.equal(rate([5, 5, 5]), 'tough'); // 50%
});

test('weekRating endurance: only running distance counts toward the target', () => {
  const r = computeWeeklyReview(base({
    goal: 'endurance',
    weeklyDistanceKmTarget: 30,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    workouts: [run(WEEK[0], 10), run(WEEK[2], 40, 'Cycling'), run(WEEK[4], 40, null)],
  }));
  assert.equal(r.weekRating, 'tough'); // 10 of 30 km running
});

test('weekRating endurance: a week with no run is 0 km only when the week before had distance', () => {
  const noRunThisWeek = (prevKm: number | null) => computeWeeklyReview(base({
    goal: 'endurance',
    weeklyDistanceKmTarget: 30,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    workouts: [
      ...(prevKm == null ? [] : [run(PREV[1], prevKm)]),
      { day: WEEK[0], durationMin: 40, distanceKm: null, type: 'Walking' },
      { day: WEEK[2], durationMin: 40, distanceKm: null, type: 'Walking' },
      { day: WEEK[4], durationMin: 40, distanceKm: null, type: 'Walking' },
    ],
  }));
  assert.equal(noRunThisWeek(20).weekRating, 'tough');
  assert.equal(noRunThisWeek(null).weekRating, null); // nothing measured, no sessions target
});

test('weekRating endurance: a tough sessions count pulls a distance rating down; with no distance target sessions decide', () => {
  const week = (over: Partial<WeeklyReviewInput>) => computeWeeklyReview(base({
    goal: 'endurance',
    trainingDays: [WEEK[0]],
    workouts: [run(WEEK[0], 32), { day: WEEK[2], durationMin: 30, distanceKm: null, type: 'Yoga' }, { day: WEEK[3], durationMin: 30, distanceKm: null, type: 'Yoga' }],
    ...over,
  }));
  // One 32 km long run vs a 30 km target: distance good, but 1 of 4 sessions is tough -> mixed.
  assert.equal(week({ weeklyDistanceKmTarget: 30, weeklySessionsTarget: 4 }).weekRating, 'mixed');
  assert.equal(week({ weeklyDistanceKmTarget: 30 }).weekRating, 'good');
  // No distance target: sessions vs target decide.
  assert.equal(week({ weeklySessionsTarget: 4 }).weekRating, 'tough');
  assert.equal(week({ weeklySessionsTarget: 1 }).weekRating, 'good');
  assert.equal(week({}).weekRating, null);
});

test('weekRating general: active days — 3+ good, 2 mixed, else tough', () => {
  const rate = (days: string[]) => computeWeeklyReview(base({
    goal: 'general',
    verdict: 'building',
    trainingDays: days,
    sleepMinutes: WEEK.map(day => ({ day, value: 470 })),
    intakeDays: intake(WEEK.slice(0, 6), [2100, 2200, 2000, 2100, 2300, 2000]),
  })).weekRating;
  assert.equal(rate([WEEK[0], WEEK[2], WEEK[4], WEEK[5]]), 'good');
  assert.equal(rate([WEEK[0], WEEK[3]]), 'mixed');
  assert.equal(rate([WEEK[0]]), 'tough');
});

test('weekRating is null for the not-enough-data review and always present in the payload', () => {
  for (const goal of ['weight_loss', 'muscle', 'endurance', 'general'] as const) {
    const r = computeWeeklyReview(base({ goal, verdict: 'insufficient_data', trainingDays: [WEEK[2]] }));
    assert.equal(r.dataSufficiency.sufficient, false);
    assert.equal(r.weekRating, null);
    const parsed = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
    assert.ok('weekRating' in parsed, 'null survives JSON so clients can tell "no rating" from an old row');
    assert.equal(parsed.weekRating, null);
  }
  const rated = JSON.parse(JSON.stringify(computeWeeklyReview(muscleWeek()))) as Record<string, unknown>;
  assert.equal(rated.weekRating, 'good');
});

// ── muscle sessions are strength-only (same definition as goal progress) ─────

test('muscle: a run is not a session — Sessions stat, headline and weekRating count strength days only', () => {
  // 3 strength days + a Friday run: all 4 are "training days", only 3 are strength sessions.
  const strengthDays = [WEEK[0], WEEK[2], WEEK[4]];
  const withRun = muscleWeek({ trainingDays: [...strengthDays, WEEK[5]], strengthDays });
  const r = computeWeeklyReview(withRun);
  assert.equal(statByLabel(r, 'Sessions')!.value, '3');
  assert.equal(statByLabel(r, 'Sessions')!.comparison, 'target 4 for the week');
  assert.match(r.headline, /^3 of 4 sessions/);
  assert.equal(r.weekRating, 'mixed'); // 4 would have read "good"

  // Without strengthDays (older callers) every training day still counts.
  const legacy = computeWeeklyReview(muscleWeek({ trainingDays: [...strengthDays, WEEK[5]] }));
  assert.equal(statByLabel(legacy, 'Sessions')!.value, '4');
  assert.equal(legacy.weekRating, 'good');
});

test('muscle: a week with only a run has 0 sessions and is tough', () => {
  const r = computeWeeklyReview(muscleWeek({ trainingDays: [WEEK[3]], strengthDays: [] }));
  assert.equal(statByLabel(r, 'Sessions')!.value, '0');
  assert.match(r.headline, /^0 of 4 sessions/);
  assert.equal(r.weekRating, 'tough');
  assert.equal(r.slip, '0 of 4 sessions — none done');
});

test("muscle: last week's comparison is strength-only too (no weekly target)", () => {
  const r = computeWeeklyReview(muscleWeek({
    weeklySessionsTarget: null,
    trainingDays: [PREV[0], PREV[1], PREV[2], WEEK[0], WEEK[2]],
    strengthDays: [PREV[0], WEEK[0], WEEK[2]], // two of last week's three training days were runs
  }));
  const sessions = statByLabel(r, 'Sessions')!;
  assert.equal(sessions.value, '2');
  assert.equal(sessions.comparison, '1 last week');
  assert.equal(sessions.tone, 'good'); // 2, up from 1
});

test('strengthDays only changes the muscle goal; other goals keep counting every training day', () => {
  const trainingDays = [WEEK[0], WEEK[2], WEEK[4]];
  const endurance = computeWeeklyReview(base({
    goal: 'endurance',
    trainingDays,
    strengthDays: [],
    workouts: trainingDays.map(day => ({ day, durationMin: 40, distanceKm: 8, type: 'Running' })),
  }));
  assert.equal(statByLabel(endurance, 'Sessions')!.value, '3');
  const weightLoss = computeWeeklyReview(weightLossInput({ strengthDays: [] }));
  assert.equal(statByLabel(weightLoss, 'Workouts')!.value, '3');
  const general = computeWeeklyReview(base({
    goal: 'general',
    trainingDays,
    strengthDays: [],
    sleepMinutes: WEEK.map(day => ({ day, value: 470 })),
    intakeDays: intake(WEEK.slice(0, 6), [2100, 2200, 2000, 2100, 2300, 2000]),
  }));
  assert.equal(statByLabel(general, 'Active days')!.value, '3');
  assert.equal(general.weekRating, 'good');
});

// ── one gap drives the pill, the Slip and Next week ─────────────────────────

/** A lifter 3 of 4 sessions in (strength days), with every meal logged and a squat up 10 kg over 4 weeks; goal card says "Sessions behind". */
function priyaWeek(over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  const strengthDays = [WEEK[0], WEEK[2], WEEK[4]];
  return muscleWeek({
    verdict: 'behind',
    trainingDays: strengthDays,
    strengthDays,
    progression: { Squat: [liftWk('2026-08-31', 153, 6), liftWk(WEEK_START, 163, 6)] },
    ...over,
  });
}

/** Marcus's long-run progress: last long run 14 km, half-marathon peak target 18 km. */
const MARCUS_LONG_RUN = { lastKm: 14, peakKm: 14, targetPeakKm: 18 };

/**
 * The reviewed week's three runs (24.5 km by default) after `prior` km runs the week before.
 * Default prior is 21.9 km, so that week's safe step is round(21.9 x 1.1) = 24 km, under the 30 km goal.
 */
function marcusRuns(prior: number[] = [7, 7, 7.9], cur: number[] = [8, 8, 8.5]) {
  return [
    ...cur.map((km, i) => run(WEEK[i * 2], km)),
    ...prior.map((km, i) => run(PREV[i * 2], km)),
  ];
}

/** A runner on 24.5 of a 30 km weekly target (21.9 km the week before → this week's safe step is 24 km), 3 runs a week. */
function marcusWeek(over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  return base({
    goal: 'endurance',
    verdict: 'building',
    weeklyDistanceKmTarget: 30,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4], PREV[0], PREV[2], PREV[4]],
    workouts: marcusRuns(),
    ...over,
  });
}

/** Marcus's week with NO step below the goal: no running the week before (`[]`) or a 28 km week before (the ~10% step reaches the 30 km goal). */
const marcusAgainstGoal = (prior: number[] = [], over: Partial<WeeklyReviewInput> = {}) => marcusWeek({ workouts: marcusRuns(prior), ...over });

test('mixed lifter (3 of 4 sessions): the Slip names the sessions and Next week closes the gap — no "Repeat"', () => {
  const r = computeWeeklyReview(priyaWeek());
  assert.equal(r.weekRating, 'mixed');
  assert.deepEqual(r.weekGap, { kind: 'sessions', done: 3, target: 4 });
  assert.equal(r.headline, '3 of 4 sessions, Squat est. 1RM +10 kg over 4 wks');
  assert.equal(r.slip, '3 of 4 sessions — one short');
  // Mon / Wed / Fri trained: Saturday is the free day (ties prefer Saturday).
  assert.equal(r.nextWeek, 'Book 4 sessions — put the missed one on Saturday.');
  assert.doesNotMatch(r.nextWeek, /Repeat this week/);
});

test('the day suggested for the missed session is the weekday with the fewest sessions over the two weeks', () => {
  const day = (strengthDays: string[]) => computeWeeklyReview(priyaWeek({ trainingDays: strengthDays, strengthDays })).nextWeek;
  // Saturday and Sunday were both used last week; Thursday is the only empty day over the two weeks.
  assert.match(day([WEEK[0], WEEK[1], WEEK[2], PREV[5], PREV[6], PREV[0], PREV[1], PREV[2], PREV[4]]), /put the missed one on Thursday\.$/);
  // Everything equally used: the Saturday-first tie-break.
  assert.match(day([WEEK[0], WEEK[1], WEEK[2]]), /put the missed one on Saturday\.$/);
  // Saturday already used this week: the next preference, Thursday.
  assert.match(day([WEEK[0], WEEK[1], WEEK[5]]), /put the missed one on Thursday\.$/);
});

test('a good week may "Repeat this week" — and only a good week', () => {
  const good = computeWeeklyReview(muscleWeek({ verdict: 'progressing' }));
  assert.equal(good.weekRating, 'good');
  assert.equal(good.weekGap, null);
  assert.equal(good.nextWeek, 'Repeat this week: same routine, same training days.');
  // Good week but the 4-week goal verdict isn't saying "on track": no blanket "repeat".
  const goodButStalled = computeWeeklyReview(muscleWeek({ verdict: 'stalled' }));
  assert.equal(goodButStalled.weekRating, 'good');
  assert.doesNotMatch(goodButStalled.nextWeek, /Repeat this week/);
  // Unrated week (no sessions target) is not a good week either.
  const unrated = computeWeeklyReview(muscleWeek({ verdict: 'progressing', weeklySessionsTarget: null }));
  assert.equal(unrated.weekRating, null);
  assert.doesNotMatch(unrated.nextWeek, /Repeat this week/);
  // Good week: the existing slip logic is unchanged (a weekend overshoot still surfaces).
  const weekendHeavy = computeWeeklyReview(muscleWeek({
    verdict: 'progressing',
    intakeDays: intake(WEEK, [2500, 2500, 2500, 2500, 2500, 3100, 3100], 160),
  }));
  assert.equal(weekendHeavy.weekRating, 'good');
  assert.match(weekendHeavy.slip ?? '', /^Weekends ran \+\d+ kcal over your weekdays\.$/);
});

test('Marcus (24.5 km after 21.9 km, 30 km goal): graded against this week\'s ~24 km step — good week, no distance Slip', () => {
  const r = computeWeeklyReview(marcusWeek());
  assert.equal(r.weekRating, 'good');
  assert.equal(r.weekGap, null);
  assert.equal(r.headline, '3 sessions, 24.5 of ~24 km — on plan · goal 30 km, +12% vs last week');
  assert.equal(statByLabel(r, 'Volume')!.value, '24.5 km');
  assert.equal(r.slip, null);
  // Still under the 30 km goal, so the build goes on: ~10% over this week, then the goal — never "Repeat this week".
  assert.equal(r.nextWeek, 'Build to ~27 km with mostly easy runs; 30 km the week after.');
  assert.doesNotMatch(r.nextWeek, /Repeat this week/);
  assert.doesNotMatch(r.nextWeek, /long run/i);
});

test('no step below the goal (no running the week before, or a big week before): the full goal is the bar — unchanged', () => {
  for (const prior of [[], [9.5, 9.5, 9]]) {
    const r = computeWeeklyReview(marcusAgainstGoal(prior));
    assert.equal(r.weekRating, 'mixed', `${prior}`);
    assert.deepEqual(r.weekGap, { kind: 'distance', doneKm: 24.5, targetKm: 30 }, `${prior}`);
    assert.match(r.headline, /^3 sessions, 24\.5 of 30 km(,|$)/, r.headline);
    assert.doesNotMatch(r.headline, /~|on plan|goal/);
    assert.equal(r.slip, '24.5 of 30 km target — 5.5 km short');
    // 24.5 -> ~27 km (+10%), spread over easy runs, then the goal — no long-run advice without long-run data.
    assert.equal(r.nextWeek, 'Build to ~27 km with mostly easy runs; 30 km the week after.');
    assert.doesNotMatch(r.nextWeek, /Repeat this week/);
    assert.doesNotMatch(r.nextWeek, /long run/i);
  }
});

test('below this week\'s step the gap is measured against the step, not the goal', () => {
  const week = (cur: number[]) => computeWeeklyReview(marcusWeek({ workouts: marcusRuns(undefined, cur) }));
  // 21 km after 21.9 km (step 24): 87.5% of the step -> mixed.
  const mixed = week([7, 7, 7]);
  assert.equal(mixed.weekRating, 'mixed');
  assert.deepEqual(mixed.weekGap, { kind: 'distance', doneKm: 21, targetKm: 30, stepKm: 24 });
  assert.equal(mixed.headline, '3 sessions, 21 of ~24 km · goal 30 km, −4% vs last week');
  assert.equal(mixed.slip, "21 of ~24 km — 3 km short of this week's step");
  assert.doesNotMatch(mixed.slip ?? '', /30|target/);
  // "Next week" still comes from the shared helper (~10% over what was actually run).
  assert.equal(mixed.nextWeek, 'Build to ~23 km with mostly easy runs; then add ~10% a week toward 30 km.');
  // 12 km is half the step: tough, same step wording.
  const tough = week([4, 4, 4]);
  assert.equal(tough.weekRating, 'tough');
  assert.deepEqual(tough.weekGap, { kind: 'distance', doneKm: 12, targetKm: 30, stepKm: 24 });
  assert.equal(tough.slip, "12 of ~24 km — 12 km short of this week's step");
  // Within 10% of the step (22 of 24 km) is still a good week: no gap, no Slip, no "on plan" claim.
  const near = week([7, 7, 8]);
  assert.equal(near.weekRating, 'good');
  assert.equal(near.weekGap, null);
  assert.equal(near.slip, null);
  assert.equal(near.headline, '3 sessions, 22 of ~24 km · goal 30 km'); // 22 vs 21.9 km: "same as last week", no % to add
  // Reaching the step is the bar: 24 km exactly is on plan.
  const exact = week([8, 8, 8]);
  assert.equal(exact.weekRating, 'good');
  assert.equal(exact.headline, '3 sessions, 24 of ~24 km — on plan · goal 30 km, +10% vs last week');
});

test('graded against the step, a runner who reaches the full goal reads as a plain "30 of 30 km"', () => {
  const r = computeWeeklyReview(marcusWeek({ workouts: marcusRuns([8, 8, 8], [10, 10, 10]) })); // 24 km before: step 26 km; goal hit, no jump
  assert.equal(r.weekRating, 'good');
  assert.equal(r.weekGap, null);
  assert.equal(r.headline, '3 sessions, 30 of 30 km, +25% vs last week');
  assert.equal(r.nextWeek, 'Repeat this week: same routine, same training days.');
});

test('runner distance copy: miles for imperial users, a bigger shortfall needs another run, a hit target is good', () => {
  // On the step: 15.2 mi after 13.6 mi (step 15 mi), goal 18.6 mi.
  const imperial = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial' }));
  assert.equal(imperial.weekRating, 'good');
  assert.equal(imperial.headline, '3 sessions, 15.2 of ~15 mi — on plan · goal 18.6 mi, +12% vs last week');
  assert.equal(imperial.slip, null);
  assert.equal(imperial.nextWeek, 'Build to ~17 mi with mostly easy runs; 18.6 mi the week after.');
  // Below the step, in miles: 13 of ~15 mi.
  const imperialShort = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial', workouts: marcusRuns(undefined, [7, 7, 7]) }));
  assert.equal(imperialShort.weekRating, 'mixed');
  assert.equal(imperialShort.slip, "13 of ~15 mi — 2 mi short of this week's step");
  assert.equal(imperialShort.headline, '3 sessions, 13 of ~15 mi · goal 18.6 mi, −4% vs last week');
  // No step below the goal: the plain goal wording, in miles.
  const imperialGoal = computeWeeklyReview(marcusAgainstGoal([], { unitSystem: 'imperial' }));
  assert.equal(imperialGoal.headline, '3 sessions, 15.2 of 18.6 mi');
  assert.equal(imperialGoal.slip, '15.2 of 18.6 mi target — 3.4 mi short');
  assert.equal(imperialGoal.nextWeek, 'Build to ~17 mi with mostly easy runs; 18.6 mi the week after.');

  const far = computeWeeklyReview(marcusAgainstGoal([14, 14], { workouts: [run(WEEK[0], 6), run(WEEK[2], 6), run(WEEK[4], 6), run(PREV[0], 14), run(PREV[2], 14)] }));
  assert.equal(far.weekRating, 'mixed'); // exactly 60% of the 30 km goal (the 28 km week before lifts the step to the goal)
  // 18 -> 20 km (+10%) is as far as one week goes; the target is several weeks off, so no "30 km the week after".
  assert.equal(far.nextWeek, 'Build to ~20 km with mostly easy runs; then add ~10% a week toward 30 km.');

  const hit = computeWeeklyReview(marcusWeek({ workouts: marcusRuns([8, 8, 8], [10, 10, 10]) }));
  assert.equal(hit.weekRating, 'good');
  assert.equal(hit.weekGap, null);
  assert.equal(hit.headline, '3 sessions, 30 of 30 km, +25% vs last week');
  assert.equal(hit.nextWeek, 'Repeat this week: same routine, same training days.');
});

// ── distance gap: safe progression (≈10% weekly growth, long run +2 km at most, never past the peak target) ──

/** The km figures in a "Next week" line, in order. */
const kmFigures = (text: string): number[] => [...text.matchAll(/(\d+(?:\.\d+)?) km/g)].map(m => Number(m[1]));

test('Marcus (24.5 of 30 km, long run 14 km, peak target 18 km): no 30 km jump, long run +2 km, weekly ~27 km', () => {
  const r = computeWeeklyReview(marcusWeek({ longRun: MARCUS_LONG_RUN }));
  assert.equal(r.weekRating, 'good'); // 24.5 km met this week's ~24 km step...
  assert.equal(r.weekGap, null);
  // ...and the build toward the goal goes on, from the same shared helper as a short week's.
  assert.equal(r.nextWeek, 'Build to ~27 km: long run 16 km, the rest mostly easy runs; 30 km the week after.');
  // The same advice after the same km with no step below the goal (a mixed week).
  const mixed = computeWeeklyReview(marcusAgainstGoal([], { longRun: MARCUS_LONG_RUN }));
  assert.equal(mixed.weekRating, 'mixed');
  assert.deepEqual(mixed.weekGap, { kind: 'distance', doneKm: 24.5, targetKm: 30 });
  assert.equal(mixed.nextWeek, r.nextWeek);
  assert.doesNotMatch(r.nextWeek, /add ~6 km/);
  assert.doesNotMatch(r.nextWeek, /Aim for 30 km/);
  const [weekly, longRun, after] = kmFigures(r.nextWeek);
  assert.ok(longRun <= 16, `long run ${longRun}`);
  assert.ok(longRun - MARCUS_LONG_RUN.lastKm <= 2);
  assert.ok(longRun <= MARCUS_LONG_RUN.targetPeakKm);
  assert.ok(weekly >= 26.5 && weekly <= 27.5, `weekly ${weekly}`); // ≈ 24.5 x 1.10
  assert.ok(weekly / 24.5 <= 1.11, 'weekly growth stays ~10%');
  assert.equal(after, 30);
});

test('already at the long-run peak target: the long run is held and all the growth goes to easy runs', () => {
  const atPeak = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 18, peakKm: 18, targetPeakKm: 18 } }));
  assert.equal(atPeak.nextWeek, 'Build to ~27 km: hold your long run at 18 km and put the growth into easy runs; 30 km the week after.');
  // Past the peak (a 20 km run): still never suggests more than the target.
  const past = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 20, peakKm: 20, targetPeakKm: 18 } }));
  assert.equal(past.nextWeek, 'Build to ~27 km: hold your long run at 18 km and put the growth into easy runs; 30 km the week after.');
  // One km below the peak: the step is limited to the room left (+1, not +2).
  const near = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 17, peakKm: 17, targetPeakKm: 18 } }));
  assert.equal(near.nextWeek, 'Build to ~27 km: long run 18 km, the rest mostly easy runs; 30 km the week after.');
  for (const r of [atPeak, past, near]) assert.ok(kmFigures(r.nextWeek)[1] <= 18, r.nextWeek);
});

test('no long-run data: the long run is not mentioned (absent, null, or a nonsense value)', () => {
  const absent = computeWeeklyReview(marcusWeek());
  const nulled = computeWeeklyReview(marcusWeek({ longRun: null }));
  const zero = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 0, peakKm: 0, targetPeakKm: 18 } }));
  for (const r of [absent, nulled, zero]) {
    assert.equal(r.nextWeek, 'Build to ~27 km with mostly easy runs; 30 km the week after.');
    assert.doesNotMatch(r.nextWeek, /long/i);
  }
});

test('long-run data without a race distance (no peak target): +2 km, uncapped by a peak', () => {
  const r = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 14, peakKm: 14, targetPeakKm: null } }));
  assert.equal(r.nextWeek, 'Build to ~27 km: long run 16 km, the rest mostly easy runs; 30 km the week after.');
});

test('a small gap (growth cap reaches the target): "Aim for 30 km…" with the long run up 2 km at most', () => {
  // 26.9 of 30 km (89.7%, still a mixed week — a 28 km week before puts the step at the goal): 26.9 x 1.10 = 29.6 -> 30, so no staging.
  const week = (over: Partial<WeeklyReviewInput>) => computeWeeklyReview(marcusWeek({
    workouts: [run(WEEK[0], 9), run(WEEK[2], 9), run(WEEK[4], 8.9), run(PREV[0], 9.5), run(PREV[2], 9.5), run(PREV[4], 9)],
    ...over,
  }));
  const small = week({ longRun: MARCUS_LONG_RUN });
  assert.equal(small.weekRating, 'mixed');
  assert.deepEqual(small.weekGap, { kind: 'distance', doneKm: 26.9, targetKm: 30 });
  assert.equal(small.nextWeek, 'Aim for 30 km: long run 16 km, the rest mostly easy runs.');
  assert.doesNotMatch(small.nextWeek, /week after/);
  assert.ok(kmFigures(small.nextWeek)[1] - MARCUS_LONG_RUN.lastKm <= 2);
  assert.equal(week({}).nextWeek, 'Aim for 30 km: add the extra on easy runs.');
  assert.equal(week({ longRun: { lastKm: 18, peakKm: 18, targetPeakKm: 18 } }).nextWeek, 'Aim for 30 km: hold your long run at 18 km and put the growth into easy runs.');
});

test('imperial runner: same rules in miles (weekly ~10%, long run +2 km, never past the peak target)', () => {
  const r = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial', longRun: MARCUS_LONG_RUN }));
  assert.equal(r.weekRating, 'good'); // 15.2 mi met this week's ~15 mi step
  assert.equal(r.slip, null);
  // 15.2 mi x 1.10 = 16.7 -> 17 mi; long run 14 -> 16 km = 9.9 mi (target peak 18 km = 11.2 mi).
  assert.equal(r.nextWeek, 'Build to ~17 mi: long run 9.9 mi, the rest mostly easy runs; 18.6 mi the week after.');
  assert.doesNotMatch(r.nextWeek, /\bkm\b/);
  const atPeak = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial', longRun: { lastKm: 18, peakKm: 18, targetPeakKm: 18 } }));
  assert.equal(atPeak.nextWeek, 'Build to ~17 mi: hold your long run at 11.2 mi and put the growth into easy runs; 18.6 mi the week after.');
  const noLongRun = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial' }));
  assert.equal(noLongRun.nextWeek, 'Build to ~17 mi with mostly easy runs; 18.6 mi the week after.');
});

// ── one target for the week: the review's "Next week" == the goal card's step ──

/** The goal-progress input for the week AFTER the reviewed one, on its Thursday (2026-10-08), over the same runs. */
function goalInputAfter(review: WeeklyReviewInput, thisWeekKm: number): GoalProgressInput {
  const thisMonday = addDays(WEEK_START, 7);
  const workouts = [...review.workouts, run(thisMonday, thisWeekKm)];
  return {
    goal: 'endurance',
    todayKey: addDays(thisMonday, 3),
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: review.weeklyDistanceKmTarget ?? null },
    start: { weightKg: null, startedAt: null },
    weightReadings: [],
    intakeDays: [],
    budget: null,
    progression: {},
    trainingDays: workouts.map(w => w.day),
    workouts,
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    unitSystem: review.unitSystem,
  };
}

test('the review\'s "Next week" km and the goal card\'s this-week step are the same number (metric and miles)', () => {
  // [reviewed week's three runs] -> the 10% step; 26.9 km is within 10% of the 30 km target, so the step IS the target.
  const cases: Array<{ runs: [number, number, number]; stepKm: number }> = [
    { runs: [8, 8, 8.5], stepKm: 27 },
    { runs: [6, 6, 6], stepKm: 20 },
    { runs: [4, 4, 4], stepKm: 13 },
    { runs: [9, 9, 8.9], stepKm: 30 },
  ];
  for (const c of cases) {
    const input = marcusWeek({ workouts: marcusRuns(undefined, c.runs) });
    const review = computeWeeklyReview(input);
    const reviewKm = Number(review.nextWeek.match(/(?:Build to ~|Aim for )(\d+(?:\.\d+)?)/)![1]);
    const progress = computeGoalProgress(goalInputAfter(input, 12));
    assert.equal(reviewKm, c.stepKm, review.nextWeek);
    assert.equal(progress.distance!.stepTargetKm, c.stepKm, `${c.runs}`);
    assert.equal(progress.distance!.stepTargetKm, reviewKm);
  }
  // Miles: whole miles in both (24.5 km = 15.2 mi -> ~17 mi).
  const imperialInput = marcusWeek({ unitSystem: 'imperial' });
  const reviewMi = Number(computeWeeklyReview(imperialInput).nextWeek.match(/Build to ~(\d+) mi/)![1]);
  const stepKm = computeGoalProgress(goalInputAfter(imperialInput, 12)).distance!.stepTargetKm;
  assert.equal(reviewMi, 17);
  assert.equal(Math.round((stepKm / 1.609344) * 10) / 10, reviewMi);
});

// ── spike guard: a jump far over the safe step is not "on plan" ──────────────

test('spike (7 km week, then 20 km): not "on plan" — mixed, a jump Slip, and Next week holds near the STEP', () => {
  const r = computeWeeklyReview(marcusWeek({ workouts: marcusRuns([7], [8, 6, 6]) })); // step round(7 x 1.1) -> 8 km
  assert.equal(r.weekRating, 'mixed');
  assert.deepEqual(r.weekGap, { kind: 'spike', doneKm: 20, stepKm: 8, targetKm: 30 });
  assert.equal(r.headline, '3 sessions, 20 of ~8 km — well above the safe step · goal 30 km');
  assert.doesNotMatch(r.headline, /on plan/);
  assert.equal(r.slip, "Jumped 12 km over this week's step — big jumps raise injury risk");
  // The shared rule applied to the STEP (8 -> 9), not to the spike (20 -> 22): a jump never ratchets the target up.
  assert.equal(r.nextWeek, 'Hold around ~9 km next week, then build ~10% a week toward 30 km.');
  assert.doesNotMatch(r.nextWeek, /Repeat this week|Build to/);
  // With a sessions target the headline still fits the limit untruncated.
  const withTarget = computeWeeklyReview(marcusWeek({ workouts: marcusRuns([7], [8, 6, 6]), weeklySessionsTarget: 4 }));
  assert.equal(withTarget.headline, '3 of 4 sessions, 20 of ~8 km — well above the safe step · goal 30 km');
  assert.ok(withTarget.headline.length <= REVIEW_HEADLINE_MAX_CHARS);
  // A spike past the goal itself is still a spike: 32 km after 21.9 km (step 24, goal 30).
  const pastGoal = computeWeeklyReview(marcusWeek({ workouts: marcusRuns(undefined, [11, 10.5, 10.5]) }));
  assert.equal(pastGoal.weekRating, 'mixed');
  assert.equal(pastGoal.weekGap?.kind, 'spike');
  assert.equal(pastGoal.slip, "Jumped 8 km over this week's step — big jumps raise injury risk");
  assert.equal(pastGoal.nextWeek, 'Hold around ~26 km next week, then build ~10% a week toward 30 km.');
});

test('spike guard needs BOTH more than 30% over the step AND at least 3 km (2 mi) over it; a mild overshoot stays "on plan"', () => {
  const week = (prior: number[] | undefined, cur: number[], over: Partial<WeeklyReviewInput> = {}) =>
    computeWeeklyReview(marcusWeek({ workouts: marcusRuns(prior, cur), ...over }));
  // 24.5 km against a 24 km step: the Marcus case.
  const mild = week(undefined, [8, 8, 8.5]);
  assert.equal(mild.weekRating, 'good');
  assert.match(mild.headline, /^3 sessions, 24\.5 of ~24 km — on plan · goal 30 km/);
  // More than 30% over a small step (10.5 vs 8 = +31%) but only 2.5 km over it: no spike.
  const smallStep = week([7], [3.5, 3.5, 3.5]);
  assert.equal(smallStep.weekRating, 'good');
  assert.equal(smallStep.weekGap, null);
  assert.match(smallStep.headline, /^3 sessions, 10\.5 of ~8 km — on plan · goal 30 km/);
  // 3+ km over, but within 30% of the step (19 vs 15 = +27%): no spike.
  const bigStep = week([14], [6, 6.5, 6.5]);
  assert.equal(bigStep.weekRating, 'good');
  assert.match(bigStep.headline, /^3 sessions, 19 of ~15 km — on plan · goal 30 km/);
  // Both (20 vs 15 = +33%, 5 km over): spike.
  const both = week([14], [6.5, 6.5, 7]);
  assert.equal(both.weekGap?.kind, 'spike');
  // No step below the goal (no week before): going past the goal is just a hit target.
  const noStep = week([], [12, 12, 12]);
  assert.equal(noStep.weekRating, 'good');
  assert.equal(noStep.headline, '3 sessions, 36 of 30 km');
  // A shortfall is never a spike.
  assert.equal(week(undefined, [7, 7, 7]).weekGap?.kind, 'distance');
});

test('spike guard in miles: 2 mi minimum, ~5 mi step, "Hold around" in whole miles', () => {
  const week = (cur: number[]) => computeWeeklyReview(marcusWeek({ unitSystem: 'imperial', workouts: marcusRuns([7], cur) })); // 7 km = 4.3 mi -> step 5 mi
  const spike = week([8, 6, 6]); // 20 km = 12.4 mi
  assert.equal(spike.weekRating, 'mixed');
  assert.deepEqual(spike.weekGap, { kind: 'spike', doneKm: 20, stepKm: 8, targetKm: 30 });
  assert.equal(spike.headline, '3 sessions, 12.4 of ~5 mi — well above the safe step · goal 18.6 mi');
  assert.equal(spike.slip, "Jumped 7.4 mi over this week's step — big jumps raise injury risk");
  assert.equal(spike.nextWeek, 'Hold around ~6 mi next week, then build ~10% a week toward 18.6 mi.');
  assert.doesNotMatch(`${spike.headline} ${spike.slip} ${spike.nextWeek}`, /\bkm\b/);
  // 10.6 km = 6.6 mi: +32% over the step but only 1.6 mi over it: on plan.
  assert.equal(week([3.7, 3.4, 3.5]).weekRating, 'good');
  // 11.5 km = 7.1 mi: 2.2 mi over the step: spike.
  assert.equal(week([4, 3.8, 3.7]).weekGap?.kind, 'spike');
});

test('the step the review grades the finished week against is the step the goal card showed WHILE that week was under way (metric and miles)', () => {
  // The goal card on the reviewed week's Thursday: its step comes from the week before, exactly like the review's.
  const duringWeek = (review: WeeklyReviewInput): GoalProgressInput => {
    const todayKey = WEEK[3];
    const workouts = review.workouts.filter(w => w.day <= todayKey);
    return { ...goalInputAfter(review, 0), todayKey, workouts, trainingDays: workouts.map(w => w.day) };
  };
  const cases: Array<{ prior: number[]; unit: 'metric' | 'imperial' }> = [
    { prior: [7, 7, 7.9], unit: 'metric' }, // 21.9 -> 24
    { prior: [5, 5, 4], unit: 'metric' }, // 14 -> 15
    { prior: [7, 7, 7.9], unit: 'imperial' }, // 13.6 mi -> 15 mi
    { prior: [5, 5, 4], unit: 'imperial' },
  ];
  for (const c of cases) {
    const input = marcusWeek({ unitSystem: c.unit, workouts: marcusRuns(c.prior, [4, 4, 4]) }); // short of the step: the gap carries it
    const review = computeWeeklyReview(input);
    const stepKm = computeGoalProgress(duringWeek(input)).distance!.stepTargetKm;
    const shown = Number(review.headline.match(/of ~(\d+(?:\.\d+)?) (?:km|mi)/)![1]);
    assert.equal(shown, c.unit === 'imperial' ? Math.round(stepKm * 0.621371 * 10) / 10 : stepKm, `${c.prior} ${c.unit}: ${review.headline}`);
    assert.equal(review.weekGap?.kind === 'distance' ? review.weekGap.stepKm : null, stepKm, `${c.prior} ${c.unit}`);
  }
});

test('a long run that would not leave room for easy runs is left out; a week with no running restarts gently', () => {
  // A 12 km week: a 16 km long run would exceed the ~13 km next week, so it is not suggested.
  const short = computeWeeklyReview(marcusWeek({
    workouts: [run(WEEK[0], 12), run(PREV[0], 12)],
    trainingDays: [WEEK[0], PREV[0]],
    sleepMinutes: WEEK.map(day => ({ day, value: 470 })),
    longRun: MARCUS_LONG_RUN,
  }));
  assert.equal(short.weekRating, 'good'); // 12 of this week's 13 km step (92%)
  assert.equal(short.nextWeek, 'Build to ~13 km with mostly easy runs; then add ~10% a week toward 30 km.');
  const none = computeWeeklyReview(marcusWeek({
    workouts: [run(WEEK[0], 0), run(PREV[0], 20)],
    trainingDays: [WEEK[0], PREV[0]],
    sleepMinutes: WEEK.map(day => ({ day, value: 470 })),
    longRun: MARCUS_LONG_RUN,
  }));
  assert.equal(none.weekGap?.kind, 'distance');
  assert.equal(none.nextWeek, 'Restart with a couple of easy runs, then build gradually toward 30 km.');
});

test('two or more poor recovery signals still win over any distance build: "Go lighter"', () => {
  const r = computeWeeklyReview(marcusWeek({
    longRun: MARCUS_LONG_RUN,
    sleepMinutes: WEEK.map(day => ({ day, value: 380 })), // averaged short
    restingHr: [...WEEK.map(day => ({ day, value: 56 })), ...PREV.map(day => ({ day, value: 51 }))], // resting HR rose
  }));
  assert.equal(r.weekRating, 'good');
  assert.match(r.nextWeek, /^Go lighter next week and put sleep first — sleep averaged short and resting heart rate rose\.$/);
  assert.doesNotMatch(r.nextWeek, /Build to|Aim for/);
  // A single poor signal does not override the build.
  const one = computeWeeklyReview(marcusWeek({
    longRun: MARCUS_LONG_RUN,
    sleepMinutes: WEEK.map(day => ({ day, value: 380 })),
  }));
  assert.match(one.nextWeek, /^Build to ~27 km/);
});

test('runner with a distance target counts running km only in Volume and the headline', () => {
  const r = computeWeeklyReview(marcusWeek({
    workouts: [run(WEEK[0], 8), run(WEEK[2], 8), run(WEEK[4], 8.5), run(WEEK[5], 40, 'Cycling'), run(PREV[0], 7), run(PREV[2], 7), run(PREV[4], 7.9)],
  }));
  assert.equal(statByLabel(r, 'Volume')!.value, '24.5 km');
  assert.equal(r.headline, '3 sessions, 24.5 of ~24 km — on plan · goal 30 km, +12% vs last week');
});

test('endurance with a sessions target says "N of M sessions" in the headline and the Slip names whichever is short', () => {
  const r = computeWeeklyReview(marcusWeek({ weeklySessionsTarget: 4 }));
  assert.equal(r.headline, '3 of 4 sessions, 24.5 of ~24 km — on plan · goal 30 km, +12% vs last week');
  assert.equal(r.weekRating, 'good'); // 3 of 4 sessions is one short, not tough
  // With no step below the goal, distance short of the goal comes first in the Slip.
  const toGoal = computeWeeklyReview(marcusAgainstGoal([], { weeklySessionsTarget: 4 }));
  assert.equal(toGoal.headline, '3 of 4 sessions, 24.5 of 30 km');
  assert.equal(toGoal.slip, '24.5 of 30 km target — 5.5 km short'); // distance first
  // Distance fine but sessions tough (1 of 4): the sessions are the gap.
  const fewRuns = computeWeeklyReview(marcusWeek({
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0]],
    workouts: [run(WEEK[0], 32)],
    sleepMinutes: WEEK.map(day => ({ day, value: 470 })), // enough data days for a review
  }));
  assert.equal(fewRuns.weekRating, 'mixed');
  assert.deepEqual(fewRuns.weekGap, { kind: 'sessions', done: 1, target: 4 });
  assert.equal(fewRuns.slip, '1 of 4 sessions — three short');
  assert.match(fewRuns.nextWeek, /^Book 4 sessions — lock in the missed ones now, starting with /);
});

test('a user who logged sets and meals most of the week never gets "Log every working set"', () => {
  // Priya: every meal logged, 3 strength sessions — mixed week, gap-driven.
  assert.doesNotMatch(computeWeeklyReview(priyaWeek()).nextWeek, /Log every working set/);
  // Good week but a stalled 4-week verdict reaches the generic fallback — still no logging nag.
  const stalled = computeWeeklyReview(muscleWeek({ verdict: 'stalled' }));
  assert.equal(stalled.nextWeek, 'Keep the same session days and try to add a rep or a little weight on your main lifts.');
  // Unrated week (no sessions target), logged every day.
  const unrated = computeWeeklyReview(muscleWeek({ verdict: 'stalled', weeklySessionsTarget: null }));
  assert.doesNotMatch(unrated.nextWeek, /Log every working set/);
  // Only 3 logged days is already enough.
  const threeDays = computeWeeklyReview(muscleWeek({
    verdict: 'stalled',
    weeklySessionsTarget: null,
    trainingDays: [],
    strengthDays: [],
    intakeDays: intake(WEEK.slice(0, 3), [2800, 2800, 2800], 160),
    weightReadings: weigh([...PREV, ...WEEK], i => 75 + i * 0.03),
  }));
  assert.doesNotMatch(threeDays.nextWeek, /Log every working set/);
});

test('"Log every working set" is still the nudge for a sparse logger', () => {
  const sparse = computeWeeklyReview(muscleWeek({
    verdict: 'stalled',
    weeklySessionsTarget: null,
    trainingDays: [WEEK[0]],
    strengthDays: [WEEK[0]],
    intakeDays: intake(WEEK.slice(0, 2), [2800, 2800], 160), // 2 logged days; the session day is one of them
    weightReadings: weigh([...PREV, ...WEEK], i => 75 + i * 0.03),
  }));
  assert.equal(sparse.nextWeek, 'Log every working set and a weigh-in or two so we can see your lifts and weight move.');
});

test('a deliberately lighter week has no Slip and Next week returns to full volume', () => {
  const mk = (weekStart: string, volumeKg: number) => ({ weekStart, bestEstimatedOneRepMaxKg: 100, volumeKg, totalSets: 8, totalReps: 40 });
  const prior = [mk('2026-08-31', 3000), mk('2026-09-07', 3000), mk('2026-09-14', 3000), mk('2026-09-21', 3000)];
  const r = computeWeeklyReview(muscleWeek({
    // A weekend overshoot that would otherwise be the Slip.
    intakeDays: intake(WEEK, [2500, 2500, 2500, 2500, 2500, 3100, 3100], 160),
    progression: { 'bench press': [...prior, mk(WEEK_START, 1200)] },
  }));
  assert.equal(r.weekRating, 'light');
  assert.equal(r.weekGap, null);
  assert.equal(r.slip, null);
  assert.equal(r.nextWeek, 'Back to full volume next week: your usual sessions and loads.');
});

test('weight loss: days out of budget are the gap — Slip names them, Next week plans the days', () => {
  const r = computeWeeklyReview(weightLossInput({
    intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, 1900, 1950, 2000, 2400, 2450, 2500, 2450]),
  }));
  assert.equal(r.weekRating, 'mixed'); // 3 of 7
  assert.deepEqual(r.weekGap, { kind: 'budget', inBudget: 3, logged: 7 });
  assert.equal(r.slip, 'In budget 3 of 7 logged days (2,000 kcal target)');
  // A heavy weekend is the sharpest way to close a budget gap.
  assert.equal(r.nextWeek, "Plan Saturday's dinner ahead so the weekend lands closer to your weekday average.");
  const flatWeekend = computeWeeklyReview(weightLossInput({
    intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, 1900, 1950, 2000, 2200, 2200, 2200, 2200]),
  }));
  assert.equal(flatWeekend.slip, 'In budget 3 of 7 logged days (2,000 kcal target)');
  assert.equal(flatWeekend.nextWeek, 'Pick the two days most likely to run over and plan those meals ahead.');
});

test('weight loss: a good budget week dragged down by the weight trend names the weight', () => {
  const r = computeWeeklyReview(weightLossInput({ weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.1) }));
  assert.equal(r.weekRating, 'mixed');
  assert.equal(r.weekGap?.kind, 'weight');
  assert.match(r.slip ?? '', /^Your weight trend moved up [\d.]+ kg, away from your goal\.$/);
  assert.match(r.nextWeek, /weigh in at least 3 mornings/);
});

test('general: active days short of 3 are the gap', () => {
  const r = computeWeeklyReview(base({
    goal: 'general',
    verdict: 'holding',
    trainingDays: [WEEK[0], WEEK[3]],
    sleepMinutes: WEEK.map(day => ({ day, value: 470 })),
    intakeDays: intake(WEEK.slice(0, 6), [2100, 2200, 2000, 2100, 2300, 2000]),
  }));
  assert.equal(r.weekRating, 'mixed');
  assert.deepEqual(r.weekGap, { kind: 'activeDays', done: 2, target: 3 });
  assert.equal(r.slip, '2 of 3 active days — one short');
  assert.equal(r.nextWeek, 'Plan 3 active days — put the missed one on Saturday.');
});

test('recovery still wins over adding sessions: two poor signals mean a lighter week even when short', () => {
  const r = computeWeeklyReview(priyaWeek({
    restingHr: [...PREV.map(day => ({ day, value: 50 })), ...WEEK.map(day => ({ day, value: 56 }))],
    hrv: [...PREV.map(day => ({ day, value: 70 })), ...WEEK.map(day => ({ day, value: 55 }))],
  }));
  assert.equal(r.slip, '3 of 4 sessions — one short');
  assert.match(r.nextWeek, /^Go lighter next week and put sleep first/);
});

test('weekGap rides along in the payload (null when there is none) and is absent only on old rows', () => {
  const mixed = JSON.parse(JSON.stringify(computeWeeklyReview(priyaWeek()))) as Record<string, unknown>;
  assert.deepEqual(mixed.weekGap, { kind: 'sessions', done: 3, target: 4 });
  const good = JSON.parse(JSON.stringify(computeWeeklyReview(muscleWeek()))) as Record<string, unknown>;
  assert.ok('weekGap' in good);
  assert.equal(good.weekGap, null);
  const thin = JSON.parse(JSON.stringify(computeWeeklyReview(base({ goal: 'muscle', verdict: 'insufficient_data', trainingDays: [WEEK[2]] })))) as Record<string, unknown>;
  assert.equal(thin.weekGap, null);
});

test('coherence: mixed / tough ⇒ the Slip names the gap and Next week never repeats; light ⇒ no Slip; "Repeat" ⇒ good', () => {
  const inputs: Array<[string, WeeklyReviewInput]> = [];
  for (let n = 0; n <= 5; n++) {
    const days = WEEK.slice(0, n);
    for (const verdict of ['progressing', 'behind', 'stalled'] as const) {
      inputs.push([`muscle ${n} sessions / ${verdict}`, muscleWeek({ verdict, trainingDays: days, strengthDays: days })]);
      inputs.push([`general ${n} days / ${verdict}`, base({
        goal: 'general', verdict, trainingDays: days,
        sleepMinutes: WEEK.map(day => ({ day, value: 470 })),
        intakeDays: intake(WEEK.slice(0, 6), [2100, 2200, 2000, 2100, 2300, 2000]),
      })]);
    }
  }
  // A 20 km week before puts the step at 22 km; a 28 km week before puts it at the 30 km goal; no week before: the goal too;
  // a 7 km week before puts the step at 8 km, so most rows are jumps (the spike guard).
  for (const prior of [20, 28, null, 7]) {
    for (const km of [0, 6, 12, 18, 21, 22, 24.5, 27, 30, 36]) {
      inputs.push([`endurance ${km} km after ${prior} km`, marcusWeek({
        workouts: [run(WEEK[0], km), ...(prior == null ? [] : [run(PREV[0], prior)])],
        trainingDays: [WEEK[0], PREV[0]],
        sleepMinutes: WEEK.map(day => ({ day, value: 470 })), // enough data days for a review
      })]);
    }
  }
  for (const inBudgetDays of [0, 2, 3, 4, 5, 7]) {
    const kcal = Array.from({ length: 7 }, (_, i) => (i < inBudgetDays ? 1900 : 2500));
    inputs.push([`weight_loss ${inBudgetDays}/7`, weightLossInput({ intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, ...kcal]) })]);
  }
  let mixedOrTough = 0;
  for (const [name, input] of inputs) {
    const r = computeWeeklyReview(input);
    if (!r.dataSufficiency.sufficient) continue;
    if (r.weekRating === 'mixed' || r.weekRating === 'tough') {
      mixedOrTough++;
      assert.ok(r.weekGap, `${name}: mixed/tough week has a gap`);
      assert.ok(r.slip, `${name}: mixed/tough week has a Slip`);
      assert.match(r.slip as string, /\d/, `${name}: the Slip names the gap's numbers`);
      assert.doesNotMatch(r.nextWeek, /Repeat this week/, `${name}: no "Repeat" after a ${r.weekRating} week`);
      assert.doesNotMatch(r.nextWeek, /Log every working set/, `${name}: well-logged week`);
    }
    if (r.weekRating === 'good') assert.equal(r.weekGap, null, `${name}: good week has no gap`);
    if (r.weekRating === 'light') assert.equal(r.slip, null, `${name}: lighter week has no Slip`);
    if (/Repeat this week/.test(r.nextWeek)) assert.equal(r.weekRating, 'good', `${name}: "Repeat" only after a good week`);
  }
  assert.ok(mixedOrTough >= 20, `matrix should exercise many mixed/tough weeks (got ${mixedOrTough})`);
});

// ── non-breaking spaces: numbers never part from their units (asserts the RAW copy) ──

test('review copy joins numbers to units, "a → b" pairs and "over 4 wks" with U+00A0', () => {
  const lifter = computeWeeklyReviewRaw(priyaWeek());
  assert.equal(lifter.headline, `3 of 4 sessions, Squat est. 1RM +10${NBSP}kg over 4${NBSP}wks`);
  assert.equal(statByLabel(lifter, 'Squat est. 1RM')!.value, `+10${NBSP}kg`);
  assert.equal(lifter.win, `Squat estimated 1RM is up 10${NBSP}kg vs 4 weeks ago.`);

  const runner = computeWeeklyReviewRaw(marcusWeek());
  assert.equal(runner.headline, `3 sessions, 24.5 of ~24${NBSP}km — on plan · goal 30${NBSP}km, +12% vs last week`);
  assert.equal(statByLabel(runner, 'Volume')!.value, `24.5${NBSP}km`);
  assert.equal(runner.win, `Training volume is up 12% on last week (21.9${NBSP}km${NBSP}→${NBSP}24.5${NBSP}km).`);
  assert.equal(runner.nextWeek, `Build to ~27${NBSP}km with mostly easy runs; 30${NBSP}km the week after.`);
  const withLongRun = computeWeeklyReviewRaw(marcusWeek({ longRun: MARCUS_LONG_RUN }));
  assert.equal(withLongRun.nextWeek, `Build to ~27${NBSP}km: long run 16${NBSP}km, the rest mostly easy runs; 30${NBSP}km the week after.`);
  // A week graded against its step, and one graded against the goal.
  const short = computeWeeklyReviewRaw(marcusWeek({ workouts: marcusRuns(undefined, [7, 7, 7]) }));
  assert.equal(short.headline, `3 sessions, 21 of ~24${NBSP}km · goal 30${NBSP}km, −4% vs last week`);
  assert.equal(short.slip, `21 of ~24${NBSP}km — 3${NBSP}km short of this week's step`);
  const toGoal = computeWeeklyReviewRaw(marcusAgainstGoal());
  assert.equal(toGoal.slip, `24.5 of 30${NBSP}km target — 5.5${NBSP}km short`);
  const spike = computeWeeklyReviewRaw(marcusWeek({ workouts: marcusRuns([7], [8, 6, 6]) }));
  assert.equal(spike.headline, `3 sessions, 20 of ~8${NBSP}km — well above the safe step · goal 30${NBSP}km`);
  assert.equal(spike.slip, `Jumped 12${NBSP}km over this week's step — big jumps raise injury risk`);
  assert.equal(spike.nextWeek, `Hold around ~9${NBSP}km next week, then build ~10% a week toward 30${NBSP}km.`);

  const loss = computeWeeklyReviewRaw(weightLossInput());
  assert.match(loss.headline, new RegExp(`^Down \\d\\.\\d${NBSP}kg, in budget 5 of 7 days$`));
  assert.match(loss.win ?? '', new RegExp(`^Your weight trend is down \\d\\.\\d${NBSP}kg\\.$`));
  assert.match(statByLabel(loss, 'Avg calories')!.value, new RegExp(`^[\\d,]+${NBSP}kcal$`));
  assert.match(loss.slip ?? '', new RegExp(`^Weekends ran \\+\\d+${NBSP}kcal over your weekdays\\.$`));

  const hr = computeWeeklyReviewRaw(base({
    goal: 'endurance',
    trainingDays: [WEEK[0], WEEK[2], WEEK[5], PREV[0], PREV[3], PREV[5]],
    workouts: [run(WEEK[0], 8), run(WEEK[2], 9), run(WEEK[5], 16), run(PREV[0], 16), run(PREV[3], 17)],
    restingHr: [...WEEK.map(day => ({ day, value: 50 })), ...PREV.map(day => ({ day, value: 53 }))],
  }));
  assert.equal(statByLabel(hr, 'Resting HR')!.value, `50${NBSP}bpm`);
  assert.equal(statByLabel(hr, 'Resting HR')!.comparison, `−3${NBSP}bpm vs last week`);
  assert.equal(hr.win, `Resting heart rate dropped 3${NBSP}bpm — a sign recovery is keeping up.`);
});

test('no number in the review copy is followed by a breaking space and a unit', () => {
  const breaking = /\d (kg|lb|km|mi|kcal|bpm|min|g|wks)\b|\d → | → \d/;
  const reviews = [
    priyaWeek(), marcusWeek(), marcusWeek({ unitSystem: 'imperial' }), weightLossInput(),
    marcusWeek({ longRun: MARCUS_LONG_RUN }), marcusWeek({ longRun: MARCUS_LONG_RUN, unitSystem: 'imperial' }),
    marcusWeek({ workouts: marcusRuns(undefined, [7, 7, 7]) }), marcusWeek({ unitSystem: 'imperial', workouts: marcusRuns(undefined, [7, 7, 7]) }),
    marcusWeek({ workouts: marcusRuns(undefined, [4, 4, 4]) }), marcusAgainstGoal(), marcusAgainstGoal([], { unitSystem: 'imperial' }),
    marcusWeek({ workouts: marcusRuns([7], [8, 6, 6]) }), marcusWeek({ unitSystem: 'imperial', workouts: marcusRuns([7], [8, 6, 6]) }),
    marcusWeek({ longRun: { lastKm: 18, peakKm: 18, targetPeakKm: 18 } }),
    weightLossInput({ unitSystem: 'imperial' }),
    weightLossInput({ weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.1) }),
    muscleWeek({ progression: { 'bench press': [liftWk(PREV_START, 100), liftWk(WEEK_START, 102.5)] } }),
  ].map(i => computeWeeklyReviewRaw(i));
  for (const r of reviews) {
    const strings = [r.headline, r.win, r.slip, r.nextWeek, ...r.stats.flatMap(s => [s.value, s.comparison])].filter((x): x is string => x != null);
    for (const text of strings) assert.doesNotMatch(text, breaking, text);
  }
});
