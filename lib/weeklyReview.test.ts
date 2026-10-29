import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExerciseDisplay,
  signupLocalDay,
  computeWeeklyReview as computeWeeklyReviewRaw,
  EST_1RM_EXPLAINER,
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
  assert.match(r.headline, /^4 of 4 sessions, Bench Press est\. 1RM \+3 kg vs the week before$/);
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
  // Back to the target; the missed sessions are not made up (no loads are known in this fixture).
  assert.equal(r.nextWeek, "Back to 4 this week — don't make up the missed ones, starting today.");
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
    // It names what the week actually had and what it still needs, and never asks for what was already done.
    assert.match(r.nextWeek, /^You logged 1 workout; /);
    assert.doesNotMatch(r.nextWeek, /Log meals, weigh-ins or workouts/);
    assert.equal(r.dataSufficiency.sufficient, false);
    assert.equal(r.verdict, 'insufficient_data');
    assert.doesNotMatch(r.nextWeek, /log 3 more workouts|log \d+ workouts?/i, 'the one workout is not asked for again');
  }
  // A week with nothing logged keeps the plain invitation (no numbers to name).
  const empty = computeWeeklyReview(base({ goal: 'weight_loss', verdict: 'insufficient_data' }));
  assert.match(empty.nextWeek, /^Log meals, weigh-ins or workouts on a few days/);
  assert.doesNotMatch(empty.nextWeek, /\d/);
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

test('muscle: without 4-weeks-ago data the lift stat is labelled "vs the week before" (or "vs last trained week" across a skipped week)', () => {
  const progression: ProgressionSummary = { 'Bench Press': [liftWk(PREV_START, 100), liftWk(WEEK_START, 102.5)] };
  const r = computeWeeklyReview(base({
    goal: 'muscle', verdict: 'progressing', weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    progression,
    intakeDays: intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
  }));
  assert.equal(statByLabel(r, 'Bench Press est. 1RM')!.comparison, 'vs the week before');
  // A skipped week in between: it is the last TRAINED week, and says so.
  const skipped = computeWeeklyReview(base({
    goal: 'muscle', verdict: 'progressing', weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    progression: { 'Bench Press': [liftWk(addDays(PREV_START, -7), 100), liftWk(WEEK_START, 102.5)] },
    intakeDays: intake(WEEK, [2800, 2850, 2900, 2800, 2750, 2900, 2850], 160),
  }));
  assert.equal(statByLabel(skipped, 'Bench Press est. 1RM')!.comparison, 'vs last trained week');
  assert.match(skipped.headline, /Bench Press est\. 1RM \+3 kg vs last trained wk$/);
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
  for (const verdict of ['reached', 'on_track', 'ahead', 'too_fast', 'behind', 'stalled', 'progressing', 'building', 'holding', 'insufficient_data'] as const) {
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

test('weekRating weight_loss: the scale going the wrong way, when the goal card says behind, pulls the week down one level', () => {
  const r = computeWeeklyReview(weightLossInput({
    verdict: 'behind',
    weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.1),
  }));
  assert.equal(statByLabel(r, 'Days in budget')!.value, '5/7');
  assert.equal(statByLabel(r, 'Weekly avg weight')!.tone, 'watch');
  assert.equal(r.weekRating, 'mixed'); // 5/7 in budget would be good
  // A week-to-week rise in the mean is a neutral stat while the card (the 21-day pace) says the loss is fine.
  const fine = computeWeeklyReview(weightLossInput({ verdict: 'on_track', weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.1) }));
  assert.equal(statByLabel(fine, 'Weekly avg weight')!.tone, 'neutral');
  assert.equal(fine.weekRating, 'good');
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
  // Up: mixed, never tough — the weight alone does not make a tough week (the card's own call, behind, changes the wording only).
  assert.equal(lossOnly(i => 80 + i * 0.1).weekRating, 'mixed');
  const behindUp = computeWeeklyReview(base({
    verdict: 'behind',
    weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.1),
    trainingDays: [WEEK[1], WEEK[3]],
  }));
  assert.equal(statByLabel(behindUp, 'Weekly avg weight')!.tone, 'watch');
  assert.equal(behindUp.weekRating, 'mixed');
});

/** A steady 30 km week before the reviewed one (3 runs): the reviewed week's bar is then the 30 km goal itself. */
const PRIOR_30 = [run(PREV[0], 10), run(PREV[2], 10), run(PREV[4], 10)];

test('weekRating endurance: running distance vs the weekly target — 90% good, 60% mixed, below tough', () => {
  const rate = (km: number[], over: Partial<WeeklyReviewInput> = {}) => computeWeeklyReview(base({
    goal: 'endurance',
    verdict: 'building',
    weeklyDistanceKmTarget: 30,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    workouts: [...PRIOR_30, ...km.map((k, i) => run(WEEK[i * 2], k))],
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
    workouts: [...PRIOR_30, run(WEEK[1], 5), run(WEEK[2], 40, 'Cycling'), run(WEEK[4], 40, null), run(WEEK[5], 5)],
  }));
  assert.equal(r.weekRating, 'tough'); // 10 of 30 km running
});

test('weekRating endurance: a week with no run is a rest week ("light") when the week before had running; nothing measured, nothing rated', () => {
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
  const rest = noRunThisWeek(20);
  assert.equal(rest.weekRating, 'light');
  assert.equal(rest.weekGap, null);
  // A real review, not "Not enough data": rest is fine, and next week restarts gently.
  assert.equal(rest.dataSufficiency.sufficient, true);
  assert.equal(rest.headline, 'No runs this week — rest is fine');
  assert.equal(rest.slip, null);
  // 8+ days without a run restarts at ~75% of the median (wave 20), and the restart week's long run is at most 40% of it.
  assert.equal(rest.nextWeek, 'Restart at ~15 km next week with easy runs; long run 6 km.');
  assert.equal(noRunThisWeek(null).weekRating, null); // nothing measured, no sessions target
});

test('weekRating endurance: a tough sessions count pulls a distance rating down; with no distance target sessions decide', () => {
  const week = (over: Partial<WeeklyReviewInput>) => computeWeeklyReview(base({
    goal: 'endurance',
    trainingDays: [WEEK[0]],
    workouts: [...PRIOR_30, run(WEEK[0], 32), { day: WEEK[2], durationMin: 30, distanceKm: null, type: 'Yoga' }, { day: WEEK[3], durationMin: 30, distanceKm: null, type: 'Yoga' }],
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
  // A week without a session says so (wave 20b: not "0 of 4 sessions, weight +0.3 kg").
  assert.equal(r.headline, 'No sessions last week');
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
  // One session short: back to 4, the missed one is not put back on the calendar (a muscle week is never made up).
  // (This fixture is the lifter's second week of lift data: the first review that shows an est. 1RM stat explains it, once - wave 23s.)
  assert.equal(r.nextWeek, `Back to 4 this week — don't make up the missed ones, starting today. ${EST_1RM_EXPLAINER}`);
  assert.doesNotMatch(r.nextWeek, /Repeat this week|put the missed one|Book 4/);
});

test('est. 1RM is explained once: the review of the lifter\'s second week of lift data carries the sentence, no other (wave 23s)', () => {
  const week = (weekStart: string, e: number) => liftWk(weekStart, e, 6);
  const two = computeWeeklyReview(priyaWeek());
  assert.ok(two.nextWeek.endsWith(EST_1RM_EXPLAINER), two.nextWeek);
  assert.equal(EST_1RM_EXPLAINER, 'Est. 1RM = the most you could lift once, estimated from your sets and how hard they felt.');
  // One week of data: no comparison yet (and no est. 1RM stat to explain); three weeks: she has been told already.
  const one = computeWeeklyReview(priyaWeek({ progression: { Squat: [week(WEEK_START, 163)] } }));
  assert.ok(!one.nextWeek.includes('most you could lift once'), one.nextWeek);
  const three = computeWeeklyReview(priyaWeek({ progression: { Squat: [week('2026-08-24', 150), week('2026-08-31', 153), week(WEEK_START, 163)] } }));
  assert.ok(three.stats.some(st => st.label.endsWith('est. 1RM')));
  assert.ok(!three.nextWeek.includes('most you could lift once'), three.nextWeek);
  // Two weeks of data, but the review shows no est. 1RM stat (a week without a lift session): nothing to explain.
  const off = computeWeeklyReview(priyaWeek({ trainingDays: [], strengthDays: [], progression: { Squat: [week('2026-08-24', 150), week('2026-08-31', 153)] } }));
  assert.ok(!off.nextWeek.includes('most you could lift once'), off.nextWeek);
  // Weight loss and the other goals never carry it.
  assert.ok(!computeWeeklyReview(weightLossInput({ weightReadings: weigh([...PREV, ...WEEK], () => 82) })).nextWeek.includes('most you could lift once'));
});

test('the day suggested for the missed active day is the weekday with the fewest sessions over the two weeks (general goal)', () => {
  const day = (trainingDays: string[]) => computeWeeklyReview(base({
    goal: 'general',
    verdict: 'holding',
    trainingDays,
    sleepMinutes: WEEK.map(d => ({ day: d, value: 470 })),
    intakeDays: intake(WEEK.slice(0, 6), [2100, 2200, 2000, 2100, 2300, 2000]),
  })).nextWeek;
  // Saturday and Sunday were both used last week; Thursday is the only empty day over the two weeks.
  assert.match(day([WEEK[0], WEEK[1], PREV[5], PREV[6], PREV[0], PREV[1], PREV[2], PREV[4]]), /put the missed one on Thursday\.$/);
  // Everything equally used: the Saturday-first tie-break.
  assert.match(day([WEEK[0], WEEK[1]]), /put the missed one on Saturday\.$/);
  // Saturday already used this week: the next preference, Thursday.
  assert.match(day([WEEK[0], WEEK[5]]), /put the missed one on Thursday\.$/);
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
  // The long run grows from the longest recent run (8.5 km): +2 km, rounded to the half km.
  assert.equal(r.nextWeek, 'Build to ~27 km: long run 10.5 km, the rest mostly easy runs; 30 km the week after.');
  assert.doesNotMatch(r.nextWeek, /Repeat this week/);
});

test('no step below the goal (a big week before): the full goal is the bar — unchanged', () => {
  const r = computeWeeklyReview(marcusAgainstGoal([9.5, 9.5, 9]));
  assert.equal(r.weekRating, 'mixed');
  assert.deepEqual(r.weekGap, { kind: 'distance', doneKm: 24.5, targetKm: 30 });
  assert.match(r.headline, /^3 sessions, 24\.5 of 30 km(,|$)/, r.headline);
  assert.doesNotMatch(r.headline, /~|on plan|goal/);
  assert.equal(r.slip, '24.5 of 30 km target — 5.5 km short');
  // 24.5 -> ~27 km (+10%), spread over easy runs, then the goal.
  assert.equal(r.nextWeek, 'Build to ~27 km: long run 11.5 km, the rest mostly easy runs; 30 km the week after.');
  assert.doesNotMatch(r.nextWeek, /Repeat this week/);
});

test('first week of running (no earlier run): a baseline week — rated on consistency, never tough, the first step next', () => {
  const r = computeWeeklyReview(marcusAgainstGoal([]));
  assert.equal(r.weekRating, 'good'); // 3 runs
  assert.equal(r.weekGap, null);
  assert.equal(r.headline, 'Baseline week: 24.5 km in 3 runs');
  assert.equal(r.win, "Baseline set: 24.5 km in 3 runs — next week's step builds from it.");
  assert.equal(r.slip, null);
  assert.equal(r.nextWeek, 'Build to ~27 km: long run 10.5 km, the rest mostly easy runs; 30 km the week after.');
  // One run is a mixed baseline (never "tough"): the gap is consistency.
  const one = computeWeeklyReview(marcusWeek({ workouts: [run(WEEK[0], 15)], trainingDays: [WEEK[0], WEEK[2], WEEK[4]] }));
  assert.equal(one.weekRating, 'mixed');
  assert.deepEqual(one.weekGap, { kind: 'sessions', done: 1, target: 3 });
  assert.equal(one.slip, '1 of 3 sessions — two short');
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
  assert.equal(mixed.nextWeek, 'Build to ~23 km: long run 10 km, the rest mostly easy runs; then add ~10% a week toward 30 km.');
  // 12 km is half the step: tough, same step wording.
  const tough = week([4, 4, 4]);
  assert.equal(tough.weekRating, 'tough');
  assert.deepEqual(tough.weekGap, { kind: 'distance', doneKm: 12, targetKm: 30, stepKm: 24 });
  assert.equal(tough.slip, "12 of ~24 km — 12 km short of this week's step");
  // Within 10% of the step (22 of 24 km) is a good week and on plan (wave 24e: the band the card calls "done"): no gap, no Slip.
  const near = week([7, 7, 8]);
  assert.equal(near.weekRating, 'good');
  assert.equal(near.weekGap, null);
  assert.equal(near.slip, null);
  assert.equal(near.headline, '3 sessions, 22 of ~24 km — on plan · goal 30 km'); // 22 vs 21.9 km: "same as last week", no % to add
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
  // At the goal: hold it, and the long run keeps stepping toward its peak. Never "Repeat this week".
  assert.equal(r.win, 'You reached your weekly goal: 30 of 30 km.');
  assert.equal(r.nextWeek, 'Hold 30 km; long run 12 km, the rest easy.');
});

test('runner distance copy: miles for imperial users, a bigger shortfall needs another run, a hit target is good', () => {
  // On the step: 15.2 mi after 13.6 mi (step 15 mi), goal 18.6 mi.
  const imperial = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial' }));
  assert.equal(imperial.weekRating, 'good');
  assert.equal(imperial.headline, '3 sessions, 15.2 of ~15 mi — on plan · goal 18.6 mi, +12% vs last week');
  assert.equal(imperial.slip, null);
  assert.equal(imperial.nextWeek, 'Build to ~17 mi: long run 6.5 mi, the rest mostly easy runs; 18.6 mi the week after.');
  // Below the step, in miles: 13 of ~15 mi.
  const imperialShort = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial', workouts: marcusRuns(undefined, [7, 7, 7]) }));
  assert.equal(imperialShort.weekRating, 'mixed');
  assert.equal(imperialShort.slip, "13 of ~15 mi — 2 mi short of this week's step");
  assert.equal(imperialShort.headline, '3 sessions, 13 of ~15 mi · goal 18.6 mi, −4% vs last week');
  // No step below the goal (a big week before): the plain goal wording, in miles.
  const imperialGoal = computeWeeklyReview(marcusAgainstGoal([9.5, 9.5, 9], { unitSystem: 'imperial' }));
  assert.equal(imperialGoal.headline, '3 sessions, 15.2 of 18.6 mi, −12% vs last week');
  assert.equal(imperialGoal.slip, '15.2 of 18.6 mi target — 3.4 mi short');
  assert.equal(imperialGoal.nextWeek, 'Build to ~17 mi: long run 7 mi, the rest mostly easy runs; 18.6 mi the week after.');

  const far = computeWeeklyReview(marcusWeek({ workouts: marcusRuns([10, 9, 9], [6, 6, 6]) }));
  assert.equal(far.weekRating, 'mixed'); // exactly 60% of the 30 km goal (the 28 km week before lifts the step to the goal)
  // 18 -> 20 km (+10%) is as far as one week goes; the target is several weeks off, so no "30 km the week after".
  // The long run is at most half of the week (wave 20): 10 of ~20 km.
  assert.equal(far.nextWeek, 'Build to ~20 km: long run 10 km, the rest mostly easy runs; then add ~10% a week toward 30 km.');

  const hit = computeWeeklyReview(marcusWeek({ workouts: marcusRuns([8, 8, 8], [10, 10, 10]) }));
  assert.equal(hit.weekRating, 'good');
  assert.equal(hit.weekGap, null);
  assert.equal(hit.headline, '3 sessions, 30 of 30 km, +25% vs last week');
  assert.equal(hit.nextWeek, 'Hold 30 km; long run 12 km, the rest easy.');
});

// ── distance gap: safe progression (≈10% weekly growth, long run +2 km at most, never past the peak target) ──

/** The km figures in a "Next week" line, in order. */
const kmFigures = (text: string): number[] => [...text.matchAll(/(\d+(?:\.\d+)?) km/g)].map(m => Number(m[1]));

test('Marcus (24.5 of 30 km, long run 14 km, peak target 18 km): no 30 km jump, long run +2 km, weekly ~27 km', () => {
  const r = computeWeeklyReview(marcusWeek({ longRun: MARCUS_LONG_RUN }));
  assert.equal(r.weekRating, 'good'); // 24.5 km met this week's ~24 km step...
  assert.equal(r.weekGap, null);
  // ...and the build toward the goal goes on, from the same shared helper as a short week's. The long run is at most half
  // of the 27 km week (wave 20), and one already run past that is held, so 14 km, not 16.
  assert.equal(r.nextWeek, 'Build to ~27 km: long run 14 km, the rest mostly easy runs; 30 km the week after.');
  // The same advice after the same km with no step below the goal (a mixed week).
  const mixed = computeWeeklyReview(marcusAgainstGoal([9.5, 9.5, 9], { longRun: MARCUS_LONG_RUN }));
  assert.equal(mixed.weekRating, 'mixed');
  assert.deepEqual(mixed.weekGap, { kind: 'distance', doneKm: 24.5, targetKm: 30 });
  assert.equal(mixed.nextWeek, r.nextWeek);
  assert.doesNotMatch(r.nextWeek, /add ~6 km/);
  assert.doesNotMatch(r.nextWeek, /Aim for 30 km/);
  const [weekly, longRun, after] = kmFigures(r.nextWeek);
  assert.ok(longRun <= 14, `long run ${longRun}`);
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
  const near = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 15, peakKm: 15, targetPeakKm: 16 } }));
  assert.equal(near.nextWeek, 'Build to ~27 km: long run 15 km, the rest mostly easy runs; 30 km the week after.'); // wave 20: held at the 15 km already run, half of the week is 13.5
  // The long run never grows past half of the week it sits in (a 27 km week holds a 17 km long run that was already run, no longer one).
  const capped = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 17, peakKm: 17, targetPeakKm: 18 } }));
  assert.equal(capped.nextWeek, 'Build to ~27 km: long run 17 km, the rest mostly easy runs; 30 km the week after.');
  for (const r of [atPeak, past, near]) assert.ok(kmFigures(r.nextWeek)[1] <= 18, r.nextWeek);
});

test('no explicit long-run reading: the long run grows from the longest recent run; a nonsense reading is ignored', () => {
  const absent = computeWeeklyReview(marcusWeek());
  const nulled = computeWeeklyReview(marcusWeek({ longRun: null }));
  const zero = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 0, peakKm: 0, targetPeakKm: 18 } }));
  for (const r of [absent, nulled, zero]) {
    // The longest run of the last 14 days is 8.5 km: +2 km, to the half km. A short run is "the longest run" below 5 km.
    assert.equal(r.nextWeek, 'Build to ~27 km: long run 10.5 km, the rest mostly easy runs; 30 km the week after.');
  }
  const tiny = computeWeeklyReview(marcusWeek({ workouts: [run(WEEK[0], 2), run(WEEK[2], 2), run(WEEK[4], 2), run(PREV[0], 2), run(PREV[2], 2), run(PREV[4], 2)] }));
  assert.match(tiny.nextWeek, /^Build to ~7 km: longest run 3\.5 km, the rest mostly easy runs/); // half of a 7 km week
});

test('long-run data without a race distance (no peak target): +2 km, uncapped by a peak', () => {
  const r = computeWeeklyReview(marcusWeek({ longRun: { lastKm: 14, peakKm: 14, targetPeakKm: null } }));
  assert.equal(r.nextWeek, 'Build to ~27 km: long run 14 km, the rest mostly easy runs; 30 km the week after.'); // +2 km would be 16, but half of the week is 13.5 (wave 20)
});

test('a small gap (growth cap reaches the target): "Hold 30 km…" with the long run up 2 km at most', () => {
  // 26.9 of 30 km (89.7%, still a mixed week — a 28 km week before puts the step at the goal): 26.9 x 1.10 = 29.6 -> 30, so no staging.
  const week = (over: Partial<WeeklyReviewInput>) => computeWeeklyReview(marcusWeek({
    workouts: [run(WEEK[0], 9), run(WEEK[2], 9), run(WEEK[4], 8.9), run(PREV[0], 9.5), run(PREV[2], 9.5), run(PREV[4], 9)],
    ...over,
  }));
  const small = week({ longRun: MARCUS_LONG_RUN });
  assert.equal(small.weekRating, 'mixed');
  assert.deepEqual(small.weekGap, { kind: 'distance', doneKm: 26.9, targetKm: 30 });
  // The growth step reaches the goal: next week IS the goal week. He has never run 30 km, so it is "Build to", not "Hold"
  // (wave 20); the long run is at most half of the week: 15 km, not 16.
  assert.equal(small.nextWeek, 'Build to 30 km; long run 15 km, the rest easy.');
  assert.ok(kmFigures(small.nextWeek)[1] - MARCUS_LONG_RUN.lastKm <= 2);
  assert.equal(week({}).nextWeek, 'Build to 30 km; long run 11.5 km, the rest easy.');
  assert.equal(week({ longRun: { lastKm: 18, peakKm: 18, targetPeakKm: 18 } }).nextWeek, 'Build to 30 km; long run 18 km, the rest easy.');
});

test('imperial runner: same rules in miles (weekly ~10%, long run +2 km, never past the peak target)', () => {
  const r = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial', longRun: MARCUS_LONG_RUN }));
  assert.equal(r.weekRating, 'good'); // 15.2 mi met this week's ~15 mi step
  assert.equal(r.slip, null);
  // 15.2 mi x 1.10 = 16.7 -> 17 mi; long run 14 -> 16 km = 9.9 mi, but half of the week is 8.5 mi and the 14 km (8.7 mi) already run is held (wave 20).
  assert.equal(r.nextWeek, 'Build to ~17 mi: long run 8.5 mi, the rest mostly easy runs; 18.6 mi the week after.');
  assert.doesNotMatch(r.nextWeek, /\bkm\b/);
  const atPeak = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial', longRun: { lastKm: 18, peakKm: 18, targetPeakKm: 18 } }));
  assert.equal(atPeak.nextWeek, 'Build to ~17 mi: hold your long run at 11 mi and put the growth into easy runs; 18.6 mi the week after.');
  const noLongRun = computeWeeklyReview(marcusWeek({ unitSystem: 'imperial' }));
  assert.equal(noLongRun.nextWeek, 'Build to ~17 mi: long run 6.5 mi, the rest mostly easy runs; 18.6 mi the week after.');
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
    const reviewKm = Number(review.nextWeek.match(/(?:Build to ~|Build to |Hold )(\d+(?:\.\d+)?)/)![1]);
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
  // (a +31% week over a small step is not "on plan" — it is above the step, just not a spike)
  assert.match(smallStep.headline, /^3 sessions, 10\.5 of ~8 km — above the step · goal 30 km/);
  // 3+ km over, but within 30% of the step (19 vs 15 = +27%): no spike.
  const bigStep = week([14], [6, 6.5, 6.5]);
  assert.equal(bigStep.weekRating, 'good');
  assert.match(bigStep.headline, /^3 sessions, 19 of ~15 km — above the step · goal 30 km/);
  // Both (20 vs 15 = +33%, 5 km over): spike.
  const both = week([14], [6.5, 6.5, 7]);
  assert.equal(both.weekGap?.kind, 'spike');
  // No step below the goal (the week before already at the goal): going past the goal is just a hit target.
  const noStep = week([10, 10, 10], [12, 12, 12]);
  assert.equal(noStep.weekRating, 'good');
  assert.equal(noStep.headline, '3 sessions, 36 of 30 km, +20% vs last week');
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
  // A week with no run at all is a rest week, not a shortfall: rated light, and next week restarts gently (~60% of the median week).
  assert.equal(none.weekRating, 'light');
  assert.equal(none.weekGap, null);
  assert.equal(none.slip, null);
  assert.match(none.nextWeek, /^Restart at ~15 km next week with easy runs/); // 8+ days off: ~75% of the median (wave 20)
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
  const toGoal = computeWeeklyReview(marcusAgainstGoal([9.5, 9.5, 9], { weeklySessionsTarget: 4 }));
  assert.equal(toGoal.headline, '3 of 4 sessions, 24.5 of 30 km, −12% vs last week');
  assert.equal(toGoal.slip, '24.5 of 30 km target — 5.5 km short'); // distance first
  // Distance fine but sessions tough (1 of 4): the sessions are the gap.
  const fewRuns = computeWeeklyReview(marcusWeek({
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0]],
    workouts: [run(PREV[0], 10), run(PREV[2], 10), run(PREV[4], 10), run(WEEK[0], 16), run(WEEK[4], 16)],
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

/** The tips an over-budget weight-loss week rotates through (the weekend plan alternates with the others when the weekend ran high). */
const WEEKEND_TIPS = [
  "Plan Saturday's dinner ahead so the weekend lands closer to your weekday average.",
  'Pick the weekend meal most likely to run over and decide it ahead of time.',
  'Keep weekend breakfast and lunch close to your weekday routine, and let one dinner out be the flexible meal.',
  'Log weekend meals as you go — it is the easiest way to watch the gap close.',
];
const BUDGET_TIPS = [
  'Pick the two days most likely to run over and plan those meals ahead.',
  'Log your meals before you eat them on your two busiest days — a plan on paper is easier to follow.',
  'Keep one go-to dinner that fits your 2,000 kcal day and use it on your busiest night.',
];

test('weight loss: days out of budget are the gap — Slip names them, Next week plans the days', () => {
  const r = computeWeeklyReview(weightLossInput({
    intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, 1900, 1950, 2000, 2400, 2450, 2500, 2450]),
  }));
  assert.equal(r.weekRating, 'mixed'); // 3 of 7
  assert.deepEqual(r.weekGap, { kind: 'budget', inBudget: 3, logged: 7 });
  assert.equal(r.slip, 'In budget 3 of 7 logged days (2,000 kcal target)');
  // A heavy weekend is the sharpest way to close a budget gap — the weekend plan leads the rotation, alternating with other weekend tips.
  assert.ok(WEEKEND_TIPS.includes(r.nextWeek), r.nextWeek);
  // ...and never last week's tip when the loader passes it in.
  const again = computeWeeklyReview(weightLossInput({
    previousNextWeek: r.nextWeek,
    intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, 1900, 1950, 2000, 2400, 2450, 2500, 2450]),
  }));
  assert.notEqual(again.nextWeek, r.nextWeek);
  const flatWeekend = computeWeeklyReview(weightLossInput({
    intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, 1900, 1950, 2000, 2200, 2200, 2200, 2200]),
  }));
  assert.equal(flatWeekend.slip, 'In budget 3 of 7 logged days (2,000 kcal target)');
  assert.ok(BUDGET_TIPS.includes(flatWeekend.nextWeek), flatWeekend.nextWeek);
});

test('weight loss: a good budget week dragged down by the weight trend names the weight', () => {
  const r = computeWeeklyReview(weightLossInput({ verdict: 'behind', weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.1) }));
  assert.equal(r.weekRating, 'mixed');
  assert.equal(r.weekGap?.kind, 'weight');
  assert.match(r.slip ?? '', /^Your weekly average weight moved up [\d.]+ kg, away from your goal\.$/);
  // Seven weigh-ins this week: it never asks for "at least 3 mornings" again.
  assert.match(r.nextWeek, /^Hold to your calorie target each day/);
  assert.doesNotMatch(r.nextWeek, /weigh in at least 3 mornings/);
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
  assert.equal(runner.win, `You hit this week's step: 24.5 of ~24${NBSP}km (+12% on last week).`);
  assert.equal(runner.nextWeek, `Build to ~27${NBSP}km: long run 10.5${NBSP}km, the rest mostly easy runs; 30${NBSP}km the week after.`);
  const withLongRun = computeWeeklyReviewRaw(marcusWeek({ longRun: MARCUS_LONG_RUN }));
  assert.equal(withLongRun.nextWeek, `Build to ~27${NBSP}km: long run 14${NBSP}km, the rest mostly easy runs; 30${NBSP}km the week after.`);
  // A week graded against its step, and one graded against the goal.
  const short = computeWeeklyReviewRaw(marcusWeek({ workouts: marcusRuns(undefined, [7, 7, 7]) }));
  assert.equal(short.headline, `3 sessions, 21 of ~24${NBSP}km · goal 30${NBSP}km, −4% vs last week`);
  assert.equal(short.slip, `21 of ~24${NBSP}km — 3${NBSP}km short of this week's step`);
  const toGoal = computeWeeklyReviewRaw(marcusAgainstGoal([9.5, 9.5, 9]));
  assert.equal(toGoal.slip, `24.5 of 30${NBSP}km target — 5.5${NBSP}km short`);
  const spike = computeWeeklyReviewRaw(marcusWeek({ workouts: marcusRuns([7], [8, 6, 6]) }));
  assert.equal(spike.headline, `3 sessions, 20 of ~8${NBSP}km — well above the safe step · goal 30${NBSP}km`);
  assert.equal(spike.slip, `Jumped 12${NBSP}km over this week's step — big jumps raise injury risk`);
  assert.equal(spike.nextWeek, `Hold around ~9${NBSP}km next week, then build ~10% a week toward 30${NBSP}km.`);

  const loss = computeWeeklyReviewRaw(weightLossInput());
  assert.match(loss.headline, new RegExp(`^Down \\d\\.\\d${NBSP}kg, in budget 5 of 7 days$`));
  assert.match(loss.win ?? '', new RegExp(`^Your weekly average weight is down \\d\\.\\d${NBSP}kg\\.$`));
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

// ── Race lifecycle: taper / race week / recovery weeks ──────────────────────
// Reviewed week: Mon 2026-09-28 … Sun 2026-10-04; the coming week starts Mon 2026-10-05.
// Weekly goal 50 km, peak week before the taper 40 km. The race is a MARATHON here (taper x0.75 / x0.6, race week x0.4,
// recovery x0.4 / x0.6); the half-marathon and 10K tables have their own tests below.

/** An endurance review of three runs (Mon / Wed / Fri) in the reviewed week and a 24 km week before it, around a race on `raceDate`. */
function raceWeekReview(raceDate: string | null, cur: number[], over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  return marcusWeek({
    weeklyDistanceKmTarget: 50,
    raceDate,
    raceDistanceKm: 42.2,
    racePeakWeekKm: 40,
    workouts: marcusRuns([8, 8, 8], cur),
    ...over,
  });
}

test('race phase review: a taper week is graded against the taper target, not the growth step', () => {
  // Race Thu 2026-10-15: 17 days out on the reviewed Monday -> early taper, round(40 x 0.75) = 30 km.
  const r = computeWeeklyReview(raceWeekReview('2026-10-15', [10, 10, 10]));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.weekGap, null);
  assert.equal(r.headline, '3 sessions, 30 of ~30 km — taper week');
  assert.equal(r.win, 'Taper on plan: 30 km against a ~30 km target.');
  assert.equal(r.slip, null);
  // Less than the target is no slip in a taper (60% and up is on plan); the old build step (24 km) is irrelevant.
  assert.equal(computeWeeklyReview(raceWeekReview('2026-10-15', [6, 6, 6])).weekRating, 'good');
});

test('race phase review: taper far under or far over its target is a slip that never says "build"', () => {
  const under = computeWeeklyReview(raceWeekReview('2026-10-15', [3, 3, 3]));
  assert.equal(under.weekRating, 'mixed');
  assert.deepEqual(under.weekGap, { kind: 'phase', phase: 'taper', doneKm: 9, targetKm: 30, over: false });
  assert.equal(under.slip, "9 of ~30 km — well under this week's taper target");
  assert.doesNotMatch(`${under.slip} ${under.nextWeek}`, /Build to/i);
  const over = computeWeeklyReview(raceWeekReview('2026-10-15', [14, 14, 14]));
  assert.equal(over.weekRating, 'mixed');
  assert.deepEqual(over.weekGap, { kind: 'phase', phase: 'taper', doneKm: 42, targetKm: 30, over: true });
  assert.equal(over.slip, 'Ran 42 km against a ~30 km taper target — the taper is for cutting volume');
  // A little over (25% / 3 km) is still on plan.
  assert.equal(computeWeeklyReview(raceWeekReview('2026-10-15', [12, 12, 12])).weekRating, 'good'); // 36 vs 30
});

test('race phase review: next week follows the coming week\'s phase (taper, race week, recovery, back to building)', () => {
  // Taper -> taper (coming Monday is 10 days out: x0.6 = 24 km).
  assert.equal(
    computeWeeklyReview(raceWeekReview('2026-10-15', [10, 10, 10])).nextWeek,
    'Taper: ~24 km next week — cut volume; long run 6.5 km easy, plus 3×1 km at race pace midweek.',
  );
  // Taper -> race week (race Thu Oct 8: the coming Monday is 3 days out; x0.4 = 16 km).
  const toRaceWeek = computeWeeklyReview(raceWeekReview('2026-10-08', [8, 8, 8]));
  assert.equal(toRaceWeek.weekRating, 'good'); // reviewed Monday is 10 days out: late taper, 24 km
  assert.equal(toRaceWeek.nextWeek, 'Race week: short easy runs, ~16 km before the race, then rest 1–2 days before it.');
  // Race week -> recovery week 1 (race Fri Oct 2; the coming Monday is 3 days after it).
  assert.equal(
    computeWeeklyReview(raceWeekReview('2026-10-02', [5, 5, 21.1])).nextWeek,
    'Recovery: easy only, ≤ 16 km next week.',
  );
  // Recovery week 1 -> recovery week 2 (race Thu Sep 24: the coming Monday is 11 days after it; x0.6 = 24 km).
  assert.equal(
    computeWeeklyReview(raceWeekReview('2026-09-24', [4, 4, 4])).nextWeek,
    'Recovery: easy only, ≤ 24 km next week.',
  );
  // Recovery week 2 -> the shared ~10% step over what was run (22 km -> ~24 km), the same number the goal card shows.
  const back = computeWeeklyReview(raceWeekReview('2026-09-20', [8, 8, 6]));
  assert.equal(back.nextWeek, 'Back to building: ~24 km next week.');
  // A build week whose NEXT week is the first taper week: taper copy, not the growth step.
  const buildToTaper = computeWeeklyReview(raceWeekReview('2026-10-22', [8, 8, 8.5]));
  assert.equal(buildToTaper.nextWeek, 'Taper: ~30 km next week — cut volume; long run 5.5 km easy, plus 3×1 km at race pace midweek.');
});

test('race phase review: race week is graded without the race; a ceiling, not a target', () => {
  // Race Fri Oct 2 (21.1 km that day): 10 km of other running vs round(40 x 0.4) = 16 km.
  const r = computeWeeklyReview(raceWeekReview('2026-10-02', [5, 5, 21.1]));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.weekGap, null);
  assert.equal(r.headline, '3 sessions, 10 of ~16 km before the race — race week');
  assert.equal(r.win, 'Race week stayed light: 10 km before the race.');
  // Too much running in race week is a slip about easy runs.
  const heavy = computeWeeklyReview(raceWeekReview('2026-10-04', [8, 8, 8])); // Sun Oct 4 race, none run on race day
  assert.equal(heavy.weekRating, 'mixed');
  assert.deepEqual(heavy.weekGap, { kind: 'phase', phase: 'race_week', doneKm: 24, targetKm: 16, over: true });
  assert.equal(heavy.slip, 'Ran 24 km — race week is for short easy runs (~16 km planned)');
  // 10% of slack on the ceiling.
  assert.equal(computeWeeklyReview(raceWeekReview('2026-10-04', [6, 6, 5.5])).weekRating, 'good'); // 17.5 vs 16 (x1.1 = 17.6)
});

test('race phase review: recovery weeks are easy only — at or under the ceiling is good, over is "recovery weeks are easy"', () => {
  const easy = computeWeeklyReview(raceWeekReview('2026-09-24', [4, 4, 4])); // week 1: 12 km <= 16 km
  assert.equal(easy.weekRating, 'good');
  assert.equal(easy.weekGap, null);
  assert.equal(easy.headline, '3 sessions, 12 of up to 16 km — recovery week');
  assert.equal(easy.win, 'Recovery week kept easy: 12 km (ceiling 16 km).');
  assert.equal(easy.slip, null);
  const hard = computeWeeklyReview(raceWeekReview('2026-09-24', [8, 8, 8])); // 24 km > 16 km
  assert.equal(hard.weekRating, 'mixed');
  assert.deepEqual(hard.weekGap, { kind: 'phase', phase: 'recovery', doneKm: 24, targetKm: 16, over: true });
  assert.equal(hard.slip, 'Ran 24 km — recovery weeks are easy');
  assert.equal(hard.nextWeek, 'Recovery: easy only, ≤ 24 km next week.');
  // Week 2 of recovery allows x0.6 = 24 km.
  assert.equal(computeWeeklyReview(raceWeekReview('2026-09-20', [8, 8, 8])).weekRating, 'good');
});

test('race phase review: fewer sessions and less volume are the plan in these weeks, never a slip', () => {
  // The week before ran 24 km, this recovery week 9 km (-62%) and only 2 of 4 sessions.
  const r = computeWeeklyReview(raceWeekReview('2026-09-24', [3, 3, 3], {
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[2], PREV[0], PREV[2], PREV[4]],
  }));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.slip, null);
  assert.equal(statByLabel(r, 'Volume')!.tone, 'neutral');
  assert.notEqual(statByLabel(r, 'Sessions')!.tone, 'watch');
  assert.doesNotMatch(r.nextWeek, /Rebuild|Build to|calendar/);
});

test('race phase review: without a distance target a recovery week is unrated, never a sessions shortfall', () => {
  const r = computeWeeklyReview(raceWeekReview('2026-09-24', [3, 3, 3], {
    weeklyDistanceKmTarget: null,
    weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[2], PREV[0], PREV[2], PREV[4]],
  }));
  assert.equal(r.weekRating, null);
  assert.equal(r.weekGap, null);
  assert.equal(r.slip, null);
  assert.equal(r.nextWeek, 'Recovery: easy only, ≤ 24 km next week.'); // the peak week (40 km) still sets the number
});

test('race phase review: "Build to" never appears in a taper, race or recovery lifecycle week', () => {
  const dates = ['2026-10-22', '2026-10-15', '2026-10-08', '2026-10-04', '2026-10-02', '2026-09-24', '2026-09-20'];
  const runsets = [[3, 3, 3], [8, 8, 8], [10, 10, 10], [14, 14, 14], [5, 5, 21.1]];
  for (const raceDate of dates) {
    for (const cur of runsets) {
      for (const unitSystem of ['metric', 'imperial'] as const) {
        const r = computeWeeklyReview(raceWeekReview(raceDate, cur, { unitSystem, longRun: MARCUS_LONG_RUN }));
        assert.doesNotMatch(r.nextWeek, /Build to/i, `${raceDate} ${cur} ${unitSystem}: ${r.nextWeek}`);
        assert.doesNotMatch(r.nextWeek, /Aim for/i, `${raceDate} ${cur} ${unitSystem}: ${r.nextWeek}`);
        // The reviewed week of the 2026-10-22 race is still a build week (24 days out): it keeps its build-phase slip; only its "Next week" is taper.
        if (raceDate !== '2026-10-22') {
          assert.doesNotMatch(r.slip ?? '', /short of this week's step|target — .* short|Jumped/, `${raceDate} ${cur}: ${r.slip}`);
        }
        assert.ok(r.headline.length <= REVIEW_HEADLINE_MAX_CHARS, r.headline);
      }
    }
  }
});

test('race phase review: build weeks keep the growth step, spike guard and "Build to"', () => {
  // Race far out (2026-12-31) or already over 14 days ago: nothing changes.
  for (const raceDate of ['2026-12-31', null]) {
    const r = computeWeeklyReview(raceWeekReview(raceDate, [8, 8, 8.5], { weeklyDistanceKmTarget: 30 }));
    assert.equal(r.nextWeek, 'Build to ~27 km: long run 10.5 km, the rest mostly easy runs; 30 km the week after.', `${raceDate}`);
  }
  // A race over three weeks ago (marathon recovery is 14 days): the weeks that follow are the rebuild, not a build.
  const rebuild = computeWeeklyReview(raceWeekReview('2026-09-13', [8, 8, 8.5], { weeklyDistanceKmTarget: 30 }));
  assert.equal(rebuild.nextWeek, 'Keep rebuilding: ~27 km next week, long run 10.5 km.');
  const spike = computeWeeklyReview(raceWeekReview('2026-12-31', [8, 6, 6], { weeklyDistanceKmTarget: 30, workouts: marcusRuns([7], [8, 6, 6]) }));
  assert.equal(spike.weekGap?.kind, 'spike');
  // Other goals ignore the race date.
  const muscle = computeWeeklyReview(muscleWeek({ raceDate: '2026-10-15', racePeakWeekKm: 40 }));
  assert.doesNotMatch(muscle.nextWeek, /Taper|Recovery|Race week/);
});

test('race phase review: imperial copy is whole miles', () => {
  const r = computeWeeklyReview(raceWeekReview('2026-10-15', [10, 10, 10], { unitSystem: 'imperial' }));
  // 24 km (late taper) = 14.9 mi -> 15 mi.
  assert.match(r.nextWeek, /^Taper: ~15 mi next week/);
  assert.doesNotMatch(`${r.headline} ${r.win} ${r.nextWeek}`, /\bkm\b/);
});

test('race phase review: no peak data and no weekly goal still gives phase copy (no number)', () => {
  const r = computeWeeklyReview(raceWeekReview('2026-10-15', [10, 10, 10], { weeklyDistanceKmTarget: null, racePeakWeekKm: null }));
  assert.equal(r.nextWeek, 'Taper: cut volume next week, keep the long run easy, plus 3×1 km at race pace midweek.');
  assert.notEqual(r.weekRating, 'tough');
  const done = computeWeeklyReview(raceWeekReview('2026-09-20', [8, 8, 6], { weeklyDistanceKmTarget: null, racePeakWeekKm: null }));
  assert.equal(done.nextWeek, 'Back to building: ease back in with easy runs and add about 10% a week.');
});

test('race phase review: the coming week\'s target is the number the goal card then shows (taper, race week, recovery)', () => {
  const cases: Array<{ raceDate: string; cur: number[]; targetKm: number; text: RegExp }> = [
    { raceDate: '2026-10-15', cur: [10, 10, 10], targetKm: 24, text: /^Taper: ~24 km next week/ },
    { raceDate: '2026-10-08', cur: [8, 8, 8], targetKm: 16, text: /~16 km before the race/ },
    { raceDate: '2026-10-02', cur: [5, 5, 21.1], targetKm: 16, text: /≤ 16 km next week/ },
    { raceDate: '2026-09-24', cur: [4, 4, 4], targetKm: 24, text: /≤ 24 km next week/ },
  ];
  for (const c of cases) {
    const input = raceWeekReview(c.raceDate, c.cur);
    const review = computeWeeklyReview(input);
    assert.match(review.nextWeek, c.text, review.nextWeek);
    // The goal card on the coming week's Monday, over the same runs and race.
    const card = computeGoalProgress({
      ...goalInputAfter(input, 0),
      todayKey: addDays(WEEK_START, 7),
      race: { date: c.raceDate, distanceKm: 42.2 },
      racePeakWeekKm: 40,
    });
    assert.equal(card.distance!.stepTargetKm, c.targetKm, `${c.raceDate}: ${review.nextWeek}`);
  }
  // After recovery: the review's ~10% step is the card's growth step again.
  const input = raceWeekReview('2026-09-20', [8, 8, 6]);
  const card = computeGoalProgress({
    ...goalInputAfter(input, 0),
    todayKey: addDays(WEEK_START, 7),
    race: { date: '2026-09-20', distanceKm: 42.2 },
    racePeakWeekKm: 40,
  });
  assert.equal(card.race, null);
  assert.equal(card.distance!.stepTargetKm, 24);
  assert.equal(computeWeeklyReview(input).nextWeek, 'Back to building: ~24 km next week.');
});

// ── Wave 19b: the lived timeline in the weekly review ────────────────────────

/** A lift-week: `sessions` sessions, top set `top` kg, best e1RM `e`, weekly volume `volumeKg`. */
const lwk = (weekStart: string, e: number | null, top: number | null, sessions = 2, volumeKg = 3000) => ({
  weekStart, bestEstimatedOneRepMaxKg: e, volumeKg, totalSets: sessions * 3, totalReps: sessions * 15, sessions, topLoadKg: top,
});
const SESSIONS_4 = [WEEK[0], WEEK[1], WEEK[3], WEEK[5], PREV[0], PREV[1], PREV[3], PREV[5]];
const liftReview = (over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput => base({
  goal: 'muscle', verdict: 'progressing', weeklySessionsTarget: 4, trainingDays: SESSIONS_4,
  weightReadings: weigh([...PREV, ...WEEK], i => 80 + i * 0.03), ...over,
});
/** Five steady weeks (08-24 .. 09-21) at top load 107.5 kg. */
const steadySquat = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'].map(w => lwk(w, 132.6, 107.5));

test('a textbook deload (85% loads, 64% of the volume) is recognised: Win names it, Next week returns to full loads', () => {
  const r = computeWeeklyReview(liftReview({
    progression: { squat: [...steadySquat, lwk(WEEK_START, 114.1, 92.5, 2, 1920)] },
  }));
  assert.equal(r.weekRating, 'light');
  // Not "as planned": nothing asked for a lighter week (and the loads were flat, not climbing).
  assert.equal(r.win, 'Deload week done — lighter loads.');
  assert.equal(r.slip, null);
  assert.equal(r.nextWeek, 'Back to full loads: Squat 107.5 → 110 kg.');
  assert.doesNotMatch(r.nextWeek, /Repeat this week/);
  // Pounds: 107.5 kg = 237 lb, 2 lb off the 5 lb grid: the step starts from the grid ("~235") and adds exactly 5 lb (240).
  const lb = computeWeeklyReview(liftReview({ unitSystem: 'imperial', progression: { squat: [...steadySquat, lwk(WEEK_START, 114.1, 92.5, 2, 1920)] } }));
  assert.equal(lb.nextWeek, 'Back to full loads: Squat ~235 → 240 lb.');
});

test('a deload win says "as planned" only when last week asked for a lighter week, else it names the timing (wave 22s)', () => {
  const deload = lwk(WEEK_START, 114.1, 92.5, 2, 1920);
  // Last week's Next week asked for a lighter week: as planned.
  const planned = computeWeeklyReview(liftReview({ progression: { squat: [...steadySquat, deload] }, previousNextWeek: 'Go lighter next week and put sleep first — poor sleep and a high resting heart rate.' }));
  assert.equal(planned.win, 'Deload week done — lighter loads, as planned.');
  // The previous review said "Squat 110 → 112.5 kg" after 4 weeks of heavier loads (102.5, 105, 107.5, 110 kg): the lifter's own call, and good timing.
  const climbing = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'].map((w, i) => lwk(w, 128 + i * 2.5, [100, 102.5, 105, 107.5, 110][i]));
  const timing = computeWeeklyReview(liftReview({ progression: { squat: [...climbing, deload] }, previousNextWeek: 'Squat 110 → 112.5 kg.' }));
  assert.equal(timing.win, 'Deload week done — lighter loads, good timing after 4 straight weeks of heavier loads.');
  // Two weeks of climbing is not a run.
  const short = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'].map((w, i) => lwk(w, 128 + i, [100, 100, 100, 102.5, 105][i]));
  assert.equal(computeWeeklyReview(liftReview({ progression: { squat: [...short, deload] } })).win, 'Deload week done — lighter loads.');
});

test('a deload by loads alone (every top set at 85-90% of its 4-week best, normal volume) is also a deload', () => {
  const r = computeWeeklyReview(liftReview({
    progression: { squat: [...steadySquat, lwk(WEEK_START, 112.7, 92.5, 2, 3000)], 'bench press': ['2026-09-07', '2026-09-14', '2026-09-21', WEEK_START].map((w, i) => lwk(w, i < 3 ? 100 : 86, i < 3 ? 80 : 70, 2, 1500)) },
  }));
  assert.equal(r.weekRating, 'light');
  // A restart at 95% of the usual loads is not a deload.
  const restart = computeWeeklyReview(liftReview({ progression: { squat: [...steadySquat, lwk(WEEK_START, 126, 102.5, 2, 3000)] } }));
  assert.notEqual(restart.weekRating, 'light');
});

test('a week with no sessions: no lift win, "Ease back in" at ~90% of the last working weights starting today, never "lock in the missed ones"', () => {
  const squat = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'].map(w => lwk(w, 141.8, 115)); // last trained week: 09-21; only the reviewed week is empty
  const r = computeWeeklyReview(liftReview({
    trainingDays: [], strengthDays: [], progression: { squat },
  }));
  assert.equal(r.weekRating, 'tough');
  assert.deepEqual(r.weekGap, { kind: 'sessions', done: 0, target: 4 });
  assert.ok(!r.stats.some(s => s.label.endsWith('est. 1RM')), 'no lift stat for a week off');
  assert.doesNotMatch(r.win ?? '', /1RM/);
  assert.doesNotMatch(r.slip ?? '', /1RM/);
  assert.equal(r.slip, '0 of 4 sessions — none done');
  assert.equal(r.nextWeek, 'Ease back in: 4 sessions at ~90% of your last working weights (Squat ~102.5 kg), starting today.');
  assert.doesNotMatch(r.nextWeek, /lock in the missed|Book /);
  // Without a known working load the sentence still stands.
  const noLoad = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [], progression: { squat: squat.map(w => ({ ...w, topLoadKg: null })) } }));
  assert.equal(noLoad.nextWeek, 'Ease back in: 4 sessions at ~90% of your last working weights, starting today.');
});

test('a review read on a Monday she has already lifted does not tell her to start today: "You\'re already back — Monday\'s 110 kg squat was your first session; …" (wave 23s)', () => {
  const monday = addDays(WEEK_START, 7);
  const weeks = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
  const squat = (monthly: Array<ReturnType<typeof lwk>>) => [...weeks.map(w => lwk(w, 141.8, 115)), ...monthly];
  // First week off, squatted 110 kg this Monday: the "Ease back in … starting today" is replaced.
  const first = computeWeeklyReview(liftReview({
    trainingDays: [], strengthDays: [monday], progression: { squat: squat([lwk(monday, 128.3, 110, 1, 1650)]) }, signupDay: '2026-06-01',
  }));
  assert.equal(first.nextWeek, "You're already back — Monday's 110 kg squat was your first session; make it 4 this week, adding load only when every set feels solid.");
  // Second week off (nothing in the week before either): she did the easy session the review asked for; build back from it.
  const second = computeWeeklyReview(liftReview({
    trainingDays: [], strengthDays: [monday], signupDay: '2026-06-01',
    progression: { squat: [...weeks.slice(0, 4).map(w => lwk(w, 141.8, 115)), lwk(monday, 128.3, 110, 1, 1650)] },
  }));
  assert.equal(second.headline, 'No sessions last week (2nd week off)');
  assert.equal(second.nextWeek, "You're already back — Monday's 110 kg squat was your first session; build back toward 4 a week, adding load only when every set feels solid.");
  // Two main lifts, in the lift ranking's order; pounds are whole pounds of the top set (110 kg = 243 lb).
  const two = computeWeeklyReview(liftReview({
    unitSystem: 'imperial', trainingDays: [], strengthDays: [monday], signupDay: '2026-06-01',
    progression: { squat: squat([lwk(monday, 128.3, 110, 1, 1650)]), 'bench press': [...weeks.map(w => lwk(w, 100, 80)), lwk(monday, 96, 85, 1, 1275)] },
  }));
  assert.match(two.nextWeek, /^You're already back — Monday's 243 lb squat and 187 lb bench were your first session; /);
  // No load known for that Monday (a HealthKit strength workout): the session is still acknowledged, without a number.
  const none = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [monday], progression: { squat: squat([]) }, signupDay: '2026-06-01' }));
  assert.match(none.nextWeek, /^You're already back — Monday's session was your first session; make it 4 this week/);
  // More days trained since (the review opened midweek): the Monday loads can no longer be told from the week's, so no number.
  const later = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [monday, addDays(monday, 2)], progression: { squat: squat([lwk(monday, 128.3, 110, 2, 1650)]) }, signupDay: '2026-06-01' }));
  assert.match(later.nextWeek, /^You're already back — Monday's session was your first session; /);
  // No session on Monday: the review is unchanged.
  const quiet = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [], progression: { squat: squat([]) }, signupDay: '2026-06-01' }));
  assert.equal(quiet.nextWeek, 'Ease back in: 4 sessions at ~90% of your last working weights (Squat ~102.5 kg), starting today.');
  // A short week (some sessions, not all): "starting today" goes once she has lifted on the review's Monday, the loads stay.
  const shortWeek = computeWeeklyReview(liftReview({ trainingDays: [WEEK[3]], strengthDays: [WEEK[3], monday], progression: { squat: squat([lwk(monday, 128.3, 110, 1, 1650)]) } }));
  assert.doesNotMatch(shortWeek.nextWeek, /today/);
  assert.match(shortWeek.nextWeek, /^Back to 4 this week — don't make up the missed ones\. /);
});

test('a session on the review\'s Monday never moves the review\'s lift comparisons (the lift data is cut at the reviewed week) (wave 23s)', () => {
  const monday = addDays(WEEK_START, 7);
  const weeks = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', WEEK_START];
  const squat = weeks.map((w, i) => lwk(w, 130 + i * 3, 105 + i * 2.5));
  const without = computeWeeklyReview(liftReview({ strengthDays: SESSIONS_4, progression: { squat } }));
  const withMonday = computeWeeklyReview(liftReview({ strengthDays: [...SESSIONS_4, monday], progression: { squat: [...squat, lwk(monday, 160, 120, 1, 1800)] } }));
  assert.deepEqual(withMonday.stats, without.stats);
  assert.equal(withMonday.headline, without.headline);
  assert.equal(withMonday.nextWeek, without.nextWeek);
});

test('a muscle week 1-3 sessions short is never made up: "Back to 4 this week — don\'t make up the missed ones", starting today, whatever the weekdays trained', () => {
  const back = "Back to 4 this week — don't make up the missed ones, starting today.";
  // Two sessions short (trained Mon + Thu in both weeks), one short (Tue/Thu/Sat): no weekday suggested, no "Book", no "lock in".
  for (const days of [[WEEK[0], WEEK[3], PREV[0], PREV[3]], [WEEK[1], WEEK[3], PREV[1], PREV[3]], [WEEK[1], WEEK[3], WEEK[5], PREV[1], PREV[3], PREV[5]]]) {
    const r = computeWeeklyReview(liftReview({ trainingDays: days, progression: {} }));
    assert.equal(r.nextWeek, back);
    assert.doesNotMatch(r.nextWeek, /Book |lock in the missed|put the missed one|catch up/);
  }
});

/** Three steady weeks (09-07 .. 09-21) of one lift at `top` kg, 2 sessions a week. */
const steadyAt = (top: number): Array<ReturnType<typeof lwk>> => ['2026-09-07', '2026-09-14', '2026-09-21'].map(w => lwk(w, top * 1.2, top));

test('a short muscle week cues the loads: a lift not trained repeats its LAST load (not a step it never lifted), a light volume day does too, a trained lift follows the normal rule (wave 24s)', () => {
  // 1 of 4 sessions: only a light bench volume day (75 kg against an 87.5 kg best). Squat and deadlift were skipped.
  const skipped = computeWeeklyReview(liftReview({
    trainingDays: [WEEK[3]], strengthDays: [WEEK[3]],
    progression: { squat: steadyAt(110), 'bench press': [...steadyAt(87.5), lwk(WEEK_START, 100, 75, 1, 1800)], deadlift: steadyAt(125) },
  }));
  assert.deepEqual(skipped.weekGap, { kind: 'sessions', done: 1, target: 4 });
  assert.equal(
    skipped.nextWeek,
    "Back to 4 this week — don't make up the missed ones. Squat 110 kg, bench 87.5 kg and deadlift 125 kg (your last loads), starting today.",
  );
  // Pounds: the last loads as logged (110 kg -> 243 lb, 87.5 kg -> 193 lb, 125 kg -> 276 lb).
  const lb = computeWeeklyReview(liftReview({
    unitSystem: 'imperial', trainingDays: [WEEK[3]], strengthDays: [WEEK[3]],
    progression: { squat: steadyAt(110), 'bench press': [...steadyAt(87.5), lwk(WEEK_START, 100, 75, 1, 1800)], deadlift: steadyAt(125) },
  }));
  assert.equal(lb.nextWeek, "Back to 4 this week — don't make up the missed ones. Squat 243 lb, bench 193 lb and deadlift 276 lb (your last loads), starting today.");
  // The squat WAS trained at its working load (115 kg, above last week's 110): the normal rule, 115 → 117.5; the deadlift alone is skipped.
  const trained = computeWeeklyReview(liftReview({
    trainingDays: [WEEK[0], WEEK[3]], strengthDays: [WEEK[0], WEEK[3]],
    progression: { squat: [...steadyAt(110), lwk(WEEK_START, 138, 115, 2)], deadlift: steadyAt(125) },
  }));
  assert.equal(trained.nextWeek, "Back to 4 this week — don't make up the missed ones. Deadlift 125 kg (your last load), squat 115 → 117.5 kg, starting today.");
  // A lift whose e1RM fell more than 1% holds its load instead of going up.
  const held = computeWeeklyReview(liftReview({
    trainingDays: [WEEK[0], WEEK[3]], strengthDays: [WEEK[0], WEEK[3]],
    progression: { squat: [...steadyAt(110), lwk(WEEK_START, 126, 110, 2)] },
  }));
  assert.equal(held.nextWeek, "Back to 4 this week — don't make up the missed ones. Squat hold at 110 kg, starting today.");
  // No known load in the last 4 weeks: nothing to repeat, the sentence still stands.
  const stale = computeWeeklyReview(liftReview({
    trainingDays: [WEEK[3]], strengthDays: [WEEK[3]],
    progression: { squat: [lwk('2026-07-20', 130, 108)] },
  }));
  assert.equal(stale.nextWeek, "Back to 4 this week — don't make up the missed ones, starting today.");
});

const RETURN = { exercise: 'squat', name: 'Squat', breakDays: 15, endedOn: '2026-09-20', preBreakKg: 142, recentKg: 136, pct: 95, regained: false };
// Squat back from a break: weeks 08-24 .. 09-07 steady at 142, 09-14 / 09-21 empty, 09-28 at 136.
const squatReturn = [lwk('2026-08-17', 138, 112.5), lwk('2026-08-24', 140, 112.5), lwk('2026-08-31', 142, 115), lwk('2026-09-07', 142, 115), lwk(WEEK_START, 135.7, 110)];

test('building back after a break: no slip for a lower e1RM, no "make up" — Win and Next week keep rebuilding', () => {
  const r = computeWeeklyReview(liftReview({ verdict: 'building', liftReturn: RETURN, progression: { squat: squatReturn } }));
  assert.equal(r.weekRating, 'good');
  const lift = statByLabel(r, 'Squat est. 1RM')!;
  assert.equal(lift.value, '136 kg');
  assert.equal(lift.comparison, '96% of your 142 kg pre-break best'); // 136 / 142 = 95.8%, rounded the normal way
  assert.equal(lift.tone, 'neutral');
  assert.equal(r.slip, null);
  assert.equal(r.win, '4 of 4 again — 2 weeks running.');
  assert.equal(r.nextWeek, 'Keep rebuilding: Squat 110 → 112.5 kg; progress the others as they hit their reps.');
  // The rebuild is in the headline: est. 1RM, the shown numbers, pre-break.
  assert.equal(r.headline, '4 of 4 sessions, Squat est. 1RM 136 of 142 kg pre-break');
  assert.doesNotMatch(JSON.stringify(r), /estimated 1RM is down|vs 4 weeks ago/);
  // Short of the target while rebuilding: the Slip is a fact, Next week is not a catch-up.
  const short = computeWeeklyReview(liftReview({ verdict: 'building', liftReturn: RETURN, trainingDays: [WEEK[0], WEEK[3], PREV[0], PREV[3]], progression: { squat: squatReturn } }));
  assert.equal(short.slip, '2 of 4 sessions — two short');
  assert.equal(short.nextWeek, 'Keep rebuilding: aim for 4 sessions at your current weights and add load only when every set feels solid.');
  assert.doesNotMatch(short.nextWeek, /lock in|missed|make up/i);
  // A rebuild is not a deload, even at lighter loads.
  assert.notEqual(r.weekRating, 'light');
});

test('regained the pre-break best: the stat is good and the headline says so', () => {
  const r = computeWeeklyReview(liftReview({
    liftReturn: { ...RETURN, recentKg: 145, pct: 102, regained: true },
    progression: { squat: [...squatReturn.slice(0, 4), lwk(WEEK_START, 145, 117.5)] },
  }));
  const lift = statByLabel(r, 'Squat est. 1RM')!;
  assert.equal(lift.value, '145 kg');
  assert.equal(lift.comparison, 'back above your pre-break 142 kg');
  assert.equal(lift.tone, 'good');
  assert.equal(r.headline, '4 of 4 sessions, Squat est. 1RM back above pre-break 142 kg');
});

test('returning from a break, lift by lift: "back above" is said only when every lift is back; otherwise both are named and the lift behind carries the stat (wave 21)', () => {
  const squatBack = [...squatReturn.slice(0, 4), lwk(WEEK_START, 145, 117.5)];
  const deadlift = [lwk('2026-08-17', 150, 125), lwk('2026-08-24', 155, 127.5), lwk('2026-08-31', 158, 130), lwk('2026-09-07', 158, 130), lwk(WEEK_START, 155, 127.5)];
  const RET_SQUAT = { ...RETURN, recentKg: 145, pct: 102, regained: true };
  const RET_DEADLIFT = { exercise: 'deadlift', name: 'Deadlift', breakDays: 15, endedOn: '2026-09-20', preBreakKg: 158, recentKg: 155, pct: 98, regained: false };
  const r = computeWeeklyReview(liftReview({
    verdict: 'building', liftReturn: RET_SQUAT, liftReturns: [RET_SQUAT, RET_DEADLIFT], progression: { squat: squatBack, deadlift },
  }));
  assert.equal(r.headline, '4 of 4 sessions, Squat back above pre-break; deadlift at 98%');
  const lift = statByLabel(r, 'Deadlift est. 1RM')!;
  assert.equal(lift.value, '155 kg');
  assert.equal(lift.comparison, '98% of your 158 kg pre-break best');
  assert.equal(lift.tone, 'neutral');
  assert.equal(statByLabel(r, 'Squat est. 1RM'), undefined);
  assert.equal(r.slip, null);
  // Still a rebuild: the next week keeps rebuilding, and no lift holds for its lower week.
  assert.match(r.nextWeek, /^Keep rebuilding: /);
  assert.doesNotMatch(JSON.stringify(r), /hold at|estimated 1RM is down/);
  // Every lift back: the old single-lift copy, "back above" for the headline lift.
  const allBack = computeWeeklyReview(liftReview({
    liftReturn: RET_SQUAT, liftReturns: [RET_SQUAT, { ...RET_DEADLIFT, recentKg: 160, pct: 101, regained: true }],
    progression: { squat: squatBack, deadlift: [...deadlift.slice(0, 4), lwk(WEEK_START, 160, 130)] },
  }));
  assert.equal(allBack.headline, '4 of 4 sessions, Squat est. 1RM back above pre-break 142 kg');
  assert.equal(statByLabel(allBack, 'Squat est. 1RM')!.tone, 'good');
  // Without `liftReturns` (older callers) the headline lift alone speaks, as before.
  assert.equal(computeWeeklyReview(liftReview({ liftReturn: RET_SQUAT, progression: { squat: squatBack, deadlift } })).headline, '4 of 4 sessions, Squat est. 1RM back above pre-break 142 kg');
});

test('a good week names the next load for the headline lift (the lift logger\'s next-weight rule)', () => {
  const progression: ProgressionSummary = {
    squat: [...steadySquat.slice(0, 4), lwk('2026-09-21', 129, 107.5), lwk(WEEK_START, 135.7, 110)],
    'bench press': ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', WEEK_START].map(w => lwk(w, 100, 80)),
  };
  const r = computeWeeklyReview(liftReview({ progression }));
  assert.equal(r.weekRating, 'good');
  // Every main lift that was trained is named (wave 20b: not just "Squat ... keep the rest"), by the same next-load rule.
  assert.equal(r.nextWeek, 'Squat 110 → 112.5 kg, bench 80 → 82.5 kg.');
  assert.doesNotMatch(r.nextWeek, /Repeat this week|keep the rest/);
  // Every lift steps by 2.5 kg, a load standard plates make (wave 21: bench used to read 80 → 81.5, which needs 0.75 kg a side).
  // One lift alone says the others follow.
  const bench = computeWeeklyReview(liftReview({ progression: { 'bench press': progression['bench press'] } }));
  assert.equal(bench.nextWeek, 'Bench Press 80 → 82.5 kg; progress the others as they hit their reps.');
  // Pounds (waves 22s, 24s): 5 lb exactly, from the NEAREST grid value of the logged load - 110 kg is 243 lb logged, so "~245 → 250" (+7; wave 23s rounded down to "~240 → 245", a +2 that was not a step, and 22s printed "243 → 250"); 80 kg is 176 lb, off the grid: "~175 → 180" (was "176 → 180", +4).
  const lb = computeWeeklyReview(liftReview({ unitSystem: 'imperial', progression }));
  assert.equal(lb.nextWeek, 'Squat ~245 → 250 lb, bench ~175 → 180 lb.');
  // No known load (older payloads): the old sentence still applies.
  const old = computeWeeklyReview(liftReview({ progression: { squat: progression.squat.map(w => ({ ...w, topLoadKg: null })) } }));
  assert.equal(old.nextWeek, 'Repeat this week: same routine, same training days.');
});

test('the card and the review name the same lift and the same number (anchored on the Monday the review is read)', () => {
  // Squat +9 (steady), bench and deadlift drop by different amounts: the lift never changes.
  const progression: ProgressionSummary = {
    squat: ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', WEEK_START].map((w, i) => lwk(w, [130, 131, 132, 138, 140, 141][i], 110)),
    'bench press': ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', WEEK_START].map((w, i) => lwk(w, [100, 100, 100, 99, 98, 97][i], 80)),
    deadlift: ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', WEEK_START].map((w, i) => lwk(w, [150, 150, 150, 147, 145, 144][i], 120)),
  };
  const review = computeWeeklyReview(liftReview({ progression }));
  const monday = '2026-10-05'; // the day after the reviewed week: the card's own week has no sets yet
  const fourWeeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].flatMap(w => [0, 1, 3, 5].map(o => addDays(w, o)));
  const card = computeGoalProgress({
    goal: 'muscle', todayKey: monday, target: { weightKg: null, date: null, weeklySessions: 4 }, start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' },
    weightReadings: [], intakeDays: [], budget: null, progression, trainingDays: fourWeeks, strengthDays: fourWeeks, workouts: [], restingHr: [], hrv: [], sleepMinutes: [], sleepGoalMinutes: 480,
  });
  const cardLift = card.reasons.find(r => r.kind === 'lift')!.text; // "Squat est. 1RM +11 kg vs 4 weeks ago (130 → 141 kg)"
  const stat = review.stats.find(s => s.label.endsWith('est. 1RM'))!;
  assert.equal(plainSpaces(cardLift).split(' est.')[0], stat.label.split(' est.')[0]); // same lift
  assert.equal(stat.comparison, 'vs 4 weeks ago'); // same comparison
  assert.equal(stat.value, /est\. 1RM ([+−]\d+ kg) vs 4 weeks ago/.exec(plainSpaces(cardLift))![1]); // same number
  assert.equal(stat.label, 'Squat est. 1RM');
  assert.equal(stat.value, '+10 kg');
  assert.match(plainSpaces(card.headline), /^Progressing — Squat est\. 1RM \+10 kg vs 4 weeks ago$/);
});

test('the review says the target was hit exactly when the card does (two weeks on target, an older gap in the 28 days)', () => {
  const sunday = WEEK[6];
  const days = [...WEEK.filter((_, i) => [0, 1, 3, 5].includes(i)), ...PREV.filter((_, i) => [0, 1, 3, 5].includes(i)), '2026-09-07', '2026-09-11'];
  const progression: ProgressionSummary = { squat: ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', WEEK_START].map((w, i) => lwk(w, [120, 122, 125, 128, 132][i], 100)) };
  const card = computeGoalProgress({
    goal: 'muscle', todayKey: sunday, target: { weightKg: null, date: null, weeklySessions: 4 }, start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' },
    weightReadings: [], intakeDays: [], budget: null, progression, trainingDays: days, strengthDays: days, workouts: [], restingHr: [], hrv: [], sleepMinutes: [], sleepGoalMinutes: 480,
  });
  const review = computeWeeklyReview(liftReview({ progression, trainingDays: days }));
  assert.equal(review.win, '4 of 4 again — 2 weeks running.'); // wave 20b: not "You hit your 4-sessions target with 4."
  assert.equal(statByLabel(review, 'Sessions')!.tone, 'good');
  assert.ok(!card.reasons.some(r => r.kind === 'adherence' && r.tone === 'watch'), JSON.stringify(card.reasons));
  assert.equal(card.reasons.find(r => r.kind === 'week_sessions')!.text, plainSpaces('4 of 4 sessions this week'));
  assert.notEqual(card.verdict, 'behind');
});

// ── wave 19c: raw weekly mean, weigh-in-only weeks, plateau, reached, rotating tips ──

const PREV2 = Array.from({ length: 7 }, (_, i) => addDays(PREV_START, i - 7));
const TOO_FAST_TIPS = [
  'Eat up to your full 2,000 kcal target each day — a slower loss is easier to keep.',
  'Add one more protein-rich meal or snack a day and eat up to your 2,000 kcal target — a slower loss protects muscle.',
];

test('E. the weight stat is the change in the RAW weekly mean (not the smoothed trend), labelled as such', () => {
  // 82.0 all of last week, 81.5 all of this week: the weekly means differ by exactly 0.5 kg.
  const r = computeWeeklyReview(base({ weightReadings: [...weigh(PREV, () => 82), ...weigh(WEEK, () => 81.5)] }));
  const stat = statByLabel(r, 'Weekly avg weight')!;
  assert.equal(stat.value, '−0.5 kg');
  assert.equal(stat.comparison, 'vs the week before');
  assert.equal(stat.tone, 'good');
  assert.equal(r.win, 'Your weekly average weight is down 0.5 kg.');
  // The smoothed trend moved by far less over the same week; the stat is not it.
  assert.equal(statByLabel(r, 'Trend change'), undefined);
});

test('E. a weight-loss week after a thin one (one weigh-in) is still compared on the weekly average (wave 22w)', () => {
  const r = computeWeeklyReview(base({
    weightReadings: [...weigh([PREV[6]], () => 82), ...weigh(WEEK.slice(0, 4), i => 81.4 - i * 0.05)],
    intakeDays: intake(WEEK, [1900, 1950, 2000, 1850, 2050, 1900, 1950]),
  }));
  const mean = statByLabel(r, 'Weekly avg weight')!;
  assert.ok(mean);
  assert.equal(mean.comparison, 'vs the week before');
  assert.equal(statByLabel(r, 'Weight change'), undefined, 'no smoothed fallback: the card never quotes the smoothed trend');
  assert.doesNotMatch(JSON.stringify(r), /smoothed|trend/i);
});

test('E. a weight-loss week short of weigh-ins for a weekly mean falls back to the smoothed change, labelled "Weight change" - never a "trend"', () => {
  // (This week's own weigh-ins are what is short: one reading cannot make a weekly average.)
  const r = computeWeeklyReview(base({
    weightReadings: [...weigh([PREV[5], PREV[6]], () => 82), ...weigh(WEEK.slice(0, 1), () => 81.4)],
    intakeDays: intake(WEEK, [1900, 1950, 2000, 1850, 2050, 1900, 1950]),
  }));
  assert.equal(statByLabel(r, 'Weekly avg weight'), undefined);
  assert.equal(statByLabel(r, 'Trend change'), undefined, 'a weight-loss goal\'s one weight is the weekly average; "trend" is the chart\'s line');
  const stat = statByLabel(r, 'Weight change')!;
  assert.ok(stat);
  assert.equal(stat.comparison, 'smoothed, vs the week before');
  assert.match(r.win ?? '', /^Your weight is down/);
  assert.doesNotMatch(JSON.stringify(r), /trend/i);
});

test('E. a muscle week short of weigh-ins keeps the trend wording (its card quotes a trend weight)', () => {
  const r = computeWeeklyReview(base({
    goal: 'muscle',
    weeklySessionsTarget: 3,
    trainingDays: [WEEK[0], WEEK[2], WEEK[4]],
    weightReadings: [...weigh([PREV[6]], () => 80), ...weigh(WEEK.slice(0, 4), i => 80.6 + i * 0.05)],
  }));
  const stat = statByLabel(r, 'Trend change')!;
  assert.ok(stat);
  assert.equal(stat.comparison, 'smoothed trend, vs the week before');
  assert.equal(statByLabel(r, 'Weight change'), undefined);
});

test('E. a too-fast week (the card says so) names the weight as the gap, and Next week says to eat up to the full calorie target — never a weekend tip', () => {
  const input = (previousNextWeek: string | null) => weightLossInput({
    verdict: 'too_fast',
    // Down 1.0 kg on the weekly mean (1.2%), calories over budget on most days with a heavy weekend.
    weightReadings: [...weigh(PREV, () => 83), ...weigh(WEEK, () => 82)],
    intakeDays: intake([...PREV, ...WEEK], [2300, 2250, 2400, 2300, 2350, 2500, 2450, 2400, 2450, 2500, 2400, 2450, 2500, 2450]),
    previousNextWeek,
  });
  const first = computeWeeklyReview(input(null));
  assert.equal(statByLabel(first, 'Weekly avg weight')!.tone, 'watch');
  assert.equal(first.weekGap?.kind, 'weight');
  assert.equal(first.weekRating, 'tough');
  assert.match(first.slip ?? '', /^Your 3-week loss pace is faster than is comfortable to sustain\.$/);
  assert.ok(TOO_FAST_TIPS.includes(first.nextWeek), first.nextWeek);
  assert.doesNotMatch(first.nextWeek, /Saturday/);
  // Two weeks running never gives the same tip.
  const second = computeWeeklyReview(input(first.nextWeek));
  assert.ok(TOO_FAST_TIPS.includes(second.nextWeek));
  assert.notEqual(second.nextWeek, first.nextWeek);
  // Without a known budget it still reads, without a number.
  const noBudget = computeWeeklyReview({ ...input(null), budget: null });
  assert.ok(
    ['Eat up to your full calorie target each day — a slower loss is easier to keep.',
      'Add one more protein-rich meal or snack a day and eat up to your calorie target — a slower loss protects muscle.'].includes(noBudget.nextWeek),
    noBudget.nextWeek,
  );
});

test('E. the weight stat alone is a review when there were 3+ weigh-ins: "Down 0.5 kg this week (5 weigh-ins)"', () => {
  const r = computeWeeklyReview(base({
    weightReadings: [...weigh(PREV.slice(0, 5), () => 82), ...weigh(WEEK.slice(0, 5), () => 81.5)],
  }));
  assert.equal(r.dataSufficiency.sufficient, true);
  assert.equal(r.dataSufficiency.statCount, 1);
  assert.equal(r.headline, 'Down 0.5 kg this week (5 weigh-ins)');
  assert.equal(r.weekRating, 'good');
  assert.equal(r.stats.length, 1);
  // Two weigh-ins are not enough to carry a review alone.
  const two = computeWeeklyReview(base({ weightReadings: [...weigh(PREV.slice(0, 5), () => 82), ...weigh(WEEK.slice(0, 2), () => 81.5)] }));
  assert.equal(two.dataSufficiency.sufficient, false);
  // Imperial.
  const lb = computeWeeklyReviewRaw(base({ unitSystem: 'imperial', weightReadings: [...weigh(PREV.slice(0, 5), () => 82), ...weigh(WEEK.slice(0, 5), () => 81.5)] }));
  assert.equal(lb.headline, `Down 1.1${NBSP}lb this week (5 weigh-ins)`);
});

test('E. the empty review names what is actually missing and never asks for what was done', () => {
  const weighedOnly = computeWeeklyReview(base({ weightReadings: weigh(WEEK.slice(0, 5), () => 82) }));
  assert.equal(weighedOnly.dataSufficiency.sufficient, false);
  assert.equal(
    weighedOnly.nextWeek,
    'You weighed in 5 days; log meals on 3 days to add calories. Your weight change shows once last week has weigh-ins to compare against.',
  );
  const mealsOnly = computeWeeklyReview(base({ weightReadings: weigh([WEEK[0]], () => 82), intakeDays: intake(WEEK.slice(0, 2), [1900, 2000]) }));
  assert.equal(mealsOnly.dataSufficiency.sufficient, false);
  assert.match(mealsOnly.nextWeek, /^You weighed in 1 day and logged meals on 2 days; weigh in on 2 more mornings to see your weight change and log meals on 1 more day to add calories\.$/);
  // Someone who weighed in 5 days is never told to weigh in again.
  assert.doesNotMatch(weighedOnly.nextWeek, /weigh in/i);
  // A lifter's gap is workouts, not weigh-ins.
  const lifter = computeWeeklyReview(base({ goal: 'muscle', trainingDays: [WEEK[0]] }));
  assert.match(lifter.nextWeek, /^You logged 1 workout; log 2 more workouts to add your sessions and log meals on 3 days to add calories\.$/);
});

/** Three weeks of flat weigh-ins (about 89.5 kg), full logging inside the budget. */
function plateauWeek(over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  const flat = (days: string[]) => weigh(days, i => 89.5 + (i % 2 === 0 ? 0.05 : -0.05));
  return base({
    verdict: 'holding',
    weightReadings: [...flat(PREV2), ...flat(PREV), ...flat(WEEK)],
    intakeDays: intake([...PREV, ...WEEK], [1900, 1950, 2000, 1850, 2050, 1900, 1950, 1900, 1950, 2000, 1850, 2050, 1900, 1950]),
    trainingDays: [WEEK[1], WEEK[3], WEEK[5]],
    weeklySessionsTarget: 3,
    ...over,
  });
}

test('D. a plateau week is not a weight "win": neutral stat, no win line, named in the headline, a real next step', () => {
  const r = computeWeeklyReview(plateauWeek());
  const stat = statByLabel(r, 'Weekly avg weight')!;
  assert.equal(stat.tone, 'neutral');
  assert.ok(!/weight|average/i.test(r.win ?? ''), `win: ${r.win}`);
  assert.match(r.headline, /^Weight flat for 3 weeks, in budget 7 of 7 days$/);
  assert.equal(r.weekRating, 'good');
  assert.equal(
    r.nextWeek,
    'Plateaus are common and often water: keep 2,000 kcal and 3 sessions; if the scale is still flat in 2 weeks, trim ~150 kcal a day or add two 30-minute walks.',
  );
  // Only two flat weeks (the third still falling) is just a good week.
  const falling = computeWeeklyReview(plateauWeek({ weightReadings: [...weigh(PREV2, () => 90.3), ...weigh(PREV, () => 89.5), ...weigh(WEEK, () => 89.0)] }));
  assert.equal(statByLabel(falling, 'Weekly avg weight')!.tone, 'good');
});

test('wave 23w: a plateau week leads with the plan (the headline is also the push): weekends first, back to target first, or keep the plan', () => {
  const planWith = (kind: 'weekends' | 'intake' | 'water') => ({
    state: 'plateau', flatWeeks: 3, plateauCause: { kind }, action: { kind: 'plateau_water', text: 'x' }, verdict: 'holding',
  }) as unknown as NonNullable<WeeklyReviewInput['weightPlan']>;
  assert.equal(computeWeeklyReview(plateauWeek({ weightPlan: planWith('weekends') })).headline, 'Flat for 3 weeks — weekends first, in budget 7 of 7 days');
  assert.equal(computeWeeklyReview(plateauWeek({ weightPlan: planWith('intake') })).headline, 'Flat for 3 weeks — back to target first, in budget 7 of 7 days');
  assert.equal(computeWeeklyReview(plateauWeek({ weightPlan: planWith('water') })).headline, 'Flat for 3 weeks — keep your plan, in budget 7 of 7 days');
  // Two flat weeks (a calm hold) or no plan: the stat headline as before.
  const fortnight = { ...planWith('water'), flatWeeks: 2 } as unknown as NonNullable<WeeklyReviewInput['weightPlan']>;
  assert.match(computeWeeklyReview(plateauWeek({ weightPlan: fortnight })).headline, /^Weight flat for 3 weeks, in budget/);
});

test('wave 23w: a week with no weigh-ins at all says so and that the plan waits for the next one - not "not enough data"', () => {
  const earlier = weigh(PREV2, () => 88.4);
  const r = computeWeeklyReview(base({ verdict: 'progressing', weightReadings: earlier }));
  assert.equal(r.headline, 'No weigh-ins last week — your plan picks up when you weigh in');
  assert.equal(r.nextWeek, 'Weigh in on a few mornings this week and your plan picks up from where it left off.');
  assert.equal(r.dataSufficiency.sufficient, false);
  // A user who has never weighed in keeps the generic one; so does a week with a weigh-in.
  assert.equal(computeWeeklyReview(base({ verdict: 'insufficient_data' })).headline, 'Not enough data for a weekly review yet');
  // (Wave 24w: a weigh-in after a gap of 7+ days is a return week - below; one in a week that kept weighing in is the generic one.)
  assert.equal(computeWeeklyReview(base({ verdict: 'progressing', weightReadings: [...weigh(PREV, () => 88.4), ...weigh([WEEK[1]], () => 88.2)] })).headline, 'Not enough data for a weekly review yet');
});

test('wave 24w P3-7: the return week (one weigh-in after a gap of 7+ days) welcomes the user back and says the review fills in next Monday', () => {
  const back = computeWeeklyReview(base({ verdict: 'progressing', weightReadings: [...weigh(PREV2, () => 88.4), ...weigh([WEEK[1]], () => 88.2)] }));
  assert.equal(back.headline, 'Welcome back — one weigh-in last week; your review fills in next Monday');
  assert.equal(back.dataSufficiency.sufficient, false);
  assert.equal(back.stats.length, 0);
  // Two weigh-ins back: the same, counted.
  const two = computeWeeklyReview(base({ verdict: 'progressing', weightReadings: [...weigh(PREV2, () => 88.4), ...weigh([WEEK[1], WEEK[3]], () => 88.2)] }));
  assert.equal(two.headline, 'Welcome back — 2 weigh-ins last week; your review fills in next Monday');
  // A user who weighed in the week before, or whose first ever weigh-in this is, gets the generic line.
  assert.equal(computeWeeklyReview(base({ verdict: 'progressing', weightReadings: weigh([WEEK[1]], () => 88.2) })).headline, 'Not enough data for a weekly review yet');
  assert.equal(computeWeeklyReview(base({ goal: 'muscle', verdict: 'progressing', weightReadings: [...weigh(PREV2, () => 88.4), ...weigh([WEEK[1]], () => 88.2)] })).headline.startsWith('Welcome back'), false);
});

test('wave 24w P3-6: "Weekends ran +N kcal over your weekdays" needs two logged weekend days, and is not said while an eat-more step is the plan', () => {
  const prior = [2300, 2250, 2400, 2300, 2350, 2500, 2450];
  const week = (sat: number | null, sun: number | null) => weightLossInput({ intakeDays: intake([...PREV, ...WEEK], [...prior, 1900, 1950, 2000, 1850, 2050, sat as number, sun as number]) });
  // Both weekend days logged: the slip, as before.
  assert.match(computeWeeklyReview(week(2450, 2500)).slip ?? '', /^Weekends ran \+\d+ kcal over your weekdays\.$/);
  // One weekend day logged is not a weekend pattern.
  assert.doesNotMatch(computeWeeklyReview(week(2450, null)).slip ?? '', /Weekends ran/);
  assert.doesNotMatch(computeWeeklyReview(week(null, 2500)).slip ?? '', /Weekends ran/);
  // An eat-more step is the coming week's plan: eating more at the weekend is not a slip.
  const step = (phase: 'given' | 'standing' | 'settled') => ({
    state: 'pace', verdict: 'on_track', nearlyThere: true,
    action: { kind: 'ease_to_maintenance', text: "Stay at ~2,150–2,200 kcal (the step you started Oct 1); we'll read it on Mon, Oct 19", kcalTarget: 2150 },
    step: { since: '2026-10-01', readOn: '2026-10-19', phase, outcome: null, loKcal: 2150, hiKcal: 2200, food: false },
  }) as unknown as NonNullable<WeeklyReviewInput['weightPlan']>;
  assert.doesNotMatch(computeWeeklyReview({ ...week(2450, 2500), weightPlan: step('standing') }).slip ?? '', /Weekends ran/);
  assert.doesNotMatch(computeWeeklyReview({ ...week(2450, 2500), weightPlan: step('given') }).slip ?? '', /Weekends ran/);
  // A level the user has settled on (the maintenance) is not a step up in progress: the slip is back.
  assert.match(computeWeeklyReview({ ...week(2450, 2500), weightPlan: step('settled') }).slip ?? '', /Weekends ran/);
});

const reachedWeekInput = (over: Partial<WeeklyReviewInput> = {}) => base({
  verdict: 'reached',
  targetWeightKg: 84,
  reachedAt: WEEK[2],
  weightReadings: [...weigh(PREV, i => 85.2 - i * 0.1), ...weigh(WEEK, i => (i < 3 ? 84.4 - i * 0.2 : 84 + (i % 2 === 0 ? 0.05 : -0.05)))],
  intakeDays: intake([...PREV, ...WEEK], [1900, 1950, 2000, 1850, 2050, 1900, 1950, 1900, 1950, 2000, 1850, 2050, 2450, 2500]),
  trainingDays: [WEEK[1], WEEK[3], WEEK[5]],
  weeklySessionsTarget: 3,
  ...over,
});

test('F. the week the target is reached: "You reached 84 kg this week", a good week, a win, "Switch to maintenance in Goals", no deficit tips', () => {
  const r = computeWeeklyReview(reachedWeekInput());
  assert.equal(r.headline, 'You reached 84 kg this week');
  assert.equal(r.weekRating, 'good');
  assert.equal(r.weekGap, null);
  // Wave 22w: an average that is not exactly the target says how close it is (the card does the same).
  assert.match(r.win ?? '', /^You reached your 84 kg target — (weekly average 84\.0 kg|weekly average within 0\.\d kg of it)\.$/);
  assert.equal(r.slip, null, 'a heavy weekend is not scolded once the deficit is over');
  assert.equal(r.nextWeek, 'Switch to maintenance in Goals so your calorie target stops pushing you lower.');
  assert.ok(!r.stats.some(s => s.label === 'Days in budget'), 'budget days no longer rate a reached goal');
  assert.equal(statByLabel(r, 'Weekly avg weight')!.tone, 'neutral');
  assert.doesNotMatch(JSON.stringify(r), /Saturday|in budget/);
  assertWellFormed(r);
});

test('F. afterwards a steady weight rates good and is a win; Next week never repeats and never reverts to deficit tips', () => {
  const holding = (previousNextWeek: string | null) => computeWeeklyReview(reachedWeekInput({
    reachedAt: PREV[2],
    weightReadings: [...weigh(PREV, i => 84 + (i % 2 === 0 ? 0.1 : 0)), ...weigh(WEEK, i => 84.1 + (i % 2 === 0 ? 0.05 : -0.05))],
    previousNextWeek,
  }));
  const r = holding(null);
  assert.match(r.headline, /^Holding at 84\.1 kg, 3 workouts$/);
  assert.equal(r.weekRating, 'good');
  assert.equal(r.win, 'Holding at 84.1 kg, within 1 kg of 84 kg.');
  assert.equal(r.slip, null);
  assert.doesNotMatch(r.nextWeek, /Saturday|budget|trim/);
  const again = holding(r.nextWeek);
  assert.notEqual(again.nextWeek, r.nextWeek);
  assert.doesNotMatch(again.nextWeek, /Saturday|budget|trim/);
  // Imperial.
  const lb = computeWeeklyReviewRaw(reachedWeekInput({ reachedAt: PREV[2], unitSystem: 'imperial', weightReadings: [...weigh(PREV, () => 84), ...weigh(WEEK, () => 84.1)] }));
  assert.equal(lb.win, `Holding at 185.4${NBSP}lb, within 2.2${NBSP}lb of 185.2${NBSP}lb.`);
  const reachedLb = computeWeeklyReviewRaw(reachedWeekInput({ unitSystem: 'imperial' }));
  assert.equal(reachedLb.headline, `You reached 185.2${NBSP}lb this week`);
});

test('F. drifting well under the target is the one reached-week gap: it is named and no longer a win', () => {
  const r = computeWeeklyReview(reachedWeekInput({
    reachedAt: PREV[2],
    weightReadings: [...weigh(PREV, () => 83.4), ...weigh(WEEK, () => 82.5)],
  }));
  assert.equal(r.weekRating, 'mixed');
  assert.equal(r.slip, 'At 82.5 kg, 1.5 kg under your 84 kg target.');
  assert.doesNotMatch(r.win ?? '', /Holding/, 'no "holding inside your range" win');
});

test('E. the tip rotates: never the same Next week two weeks running, with or without the stored previous text', () => {
  const week = (k: number, previousNextWeek: string | null) => {
    const start = addDays(WEEK_START, 7 * k);
    const days = Array.from({ length: 14 }, (_, i) => addDays(start, i - 7));
    return computeWeeklyReview(weightLossInput({
      weekStart: start,
      weightReadings: weigh(days, i => 82 - i * 0.05),
      intakeDays: intake(days, [2300, 2250, 2400, 2300, 2350, 2500, 2450, 1900, 1950, 2000, 2400, 2450, 2500, 2450]),
      trainingDays: [days[8], days[10], days[12]],
      previousNextWeek,
    }));
  };
  // Deterministic rotation by week number alone.
  const alone = Array.from({ length: 8 }, (_, k) => week(k, null).nextWeek);
  for (let i = 1; i < alone.length; i++) assert.notEqual(alone[i], alone[i - 1], `weeks ${i - 1} and ${i}: ${alone[i]}`);
  assert.ok(new Set(alone).size >= 3, 'more than two different tips over eight weeks');
  // And with the loader handing the previous text in.
  let prev: string | null = null;
  const chained: string[] = [];
  for (let k = 0; k < 8; k++) {
    const next: string = week(k, prev).nextWeek;
    chained.push(next);
    prev = next;
  }
  for (let i = 1; i < chained.length; i++) assert.notEqual(chained[i], chained[i - 1]);
  assert.ok(chained.filter(t => t.startsWith("Plan Saturday's dinner")).length <= 4, '"Plan Saturday\'s dinner" no longer fills every week');
});

test('E. the fallback tip is built from what was logged: six weigh-ins are never told to "weigh in at least 3 mornings"', () => {
  const sixWeighIns = computeWeeklyReview(base({
    verdict: 'stalled',
    weightReadings: [...weigh(PREV, () => 82), ...weigh(WEEK.slice(0, 6), () => 82)],
    intakeDays: intake(WEEK, [1900, 1950, 2000, 1850, 2050, 1900, 1950]),
    trainingDays: [WEEK[1], WEEK[3]],
  }));
  assert.doesNotMatch(sixWeighIns.nextWeek, /weigh in at least 3/i);
  const noMeals = computeWeeklyReview(base({
    verdict: 'stalled',
    weightReadings: [...weigh(PREV, () => 82), ...weigh(WEEK.slice(0, 6), () => 81.7)],
    trainingDays: [WEEK[1], WEEK[3], WEEK[5]],
    weeklySessionsTarget: 3,
  }));
  assert.match(noMeals.nextWeek, /^You weighed in 6 days — log dinner on 3 days to see how your calories line up\.$|^Repeat this week|^Nothing to change/);
  assert.doesNotMatch(noMeals.nextWeek, /meals, weigh-in/);
});

// ── Wave 19: ONE week plan — baseline, spike -> hold -> held, restart, maintain, race done, rebuild ──
// The reviewed week is WEEK (Mon 2026-09-28 … Sun 2026-10-04). `weeks` are the weekly km up to and including it,
// four runs each (Tue / Thu / Sat and a 40% Sunday long run), so the plan has the history it needs.

function planReview(weeks: number[], over: Partial<WeeklyReviewInput> = {}): WeeklyReviewInput {
  const workouts: ReturnType<typeof run>[] = [];
  const reviewed = over.weekStart ?? WEEK_START;
  weeks.forEach((km, i) => {
    if (km <= 0) return;
    const monday = addDays(reviewed, -7 * (weeks.length - 1 - i));
    workouts.push(run(addDays(monday, 1), km * 0.2), run(addDays(monday, 3), km * 0.2), run(addDays(monday, 5), km * 0.2), run(addDays(monday, 6), km * 0.4));
  });
  return base({
    goal: 'endurance',
    verdict: 'building',
    weeklyDistanceKmTarget: 30,
    trainingDays: workouts.map(w => w.day),
    workouts,
    ...over,
  });
}

test('spike week: no "volume is up" win, no +74% [good] stat, a jump Slip, and Next week holds one step up from the STEP', () => {
  // (The week before the reviewed one, 2026-09-21, is the calendar's cutback week: run as planned, 18 km - 23 km would be a skipped cutback.)
  const r = computeWeeklyReview(planReview([15, 17, 19, 21, 18, 40]));
  assert.equal(r.weekRating, 'mixed');
  assert.deepEqual(r.weekGap, { kind: 'spike', doneKm: 40, stepKm: 23, targetKm: 30 });
  assert.equal(r.headline, '4 sessions, 40 of ~23 km — well above the safe step · goal 30 km');
  assert.equal(r.win, null);
  assert.doesNotMatch(r.win ?? '', /volume/i);
  assert.equal(statByLabel(r, 'Volume')!.tone, 'watch');
  assert.equal(r.slip, "Jumped 17 km over this week's step — big jumps raise injury risk");
  assert.equal(r.nextWeek, 'Hold around ~25 km next week, then build ~10% a week toward 30 km.');
});

test('the week after a spike, holding as advised is good: win says so, no "fell X%" slip, no "Rebuild toward 40 km"', () => {
  // (The hold week's number is ~22 km here (a step up from the week the spike should have been); 28 km would be built through it - wave 23e, see the next test.)
  const r = computeWeeklyReview(planReview([15, 17, 19, 21, 18, 40, 22]));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.weekGap, null);
  assert.equal(r.win, "Held back after last week's jump — exactly right.");
  assert.equal(r.slip, null);
  assert.equal(statByLabel(r, 'Volume')!.comparison, 'held after 40 km last week');
  assert.equal(statByLabel(r, 'Volume')!.tone, 'good');
  assert.doesNotMatch(`${r.headline} ${r.win} ${r.slip} ${r.nextWeek}`, /fell|Rebuild|−30%/);
  // Next the build resumes from the hold (a 10% step), the long run held at 16 km.
  // (the 40 km week's 16 km long run is still inside the 14 days the long run grows from; half of the week is 15 km, so it is held at 16)
  assert.equal(r.nextWeek, 'Build to ~24 km: long run 16 km, the rest mostly easy runs; then add ~10% a week toward 30 km.');
  // Not holding (another 40 km) is the same mistake again, not praise.
  const again = computeWeeklyReview(planReview([15, 17, 19, 21, 18, 40, 40]));
  assert.equal(again.weekRating, 'mixed');
  assert.equal(again.weekGap?.kind, 'spike');
  assert.equal(again.win, null);
});

test('illness: a sick week that ended in a break is "light" with a real review, and the comeback week is graded against the restart', () => {
  // Weeks 1-8 build to 30 km; week 9 is one 6 km run, then 5 days off.
  const sick = planReview([15, 17, 19, 21, 23, 25, 28, 30, 6]);
  const sickWeek = computeWeeklyReview({ ...sick, workouts: sick.workouts.filter(w => !(w.day > addDays(WEEK_START, 1) && w.day <= addDays(WEEK_START, 6))), trainingDays: [addDays(WEEK_START, 1)] });
  assert.equal(sickWeek.dataSufficiency.sufficient, true); // not "Not enough data"
  assert.equal(sickWeek.weekRating, 'light');
  assert.equal(sickWeek.weekGap, null);
  // 'light' for a runner is a rest week, not a lifter's deload: no "Deload week done" win.
  assert.equal(sickWeek.win, null);
  assert.equal(sickWeek.headline, '1.2 km this week, then 5 days off');
  assert.equal(sickWeek.slip, null);
  assert.match(sickWeek.nextWeek, /^Restart at ~\d+ km next week with easy runs/);
  // The comeback: 15 km after the 6 km week is a good restart, not "15 of ~7 km — well above the safe step".
  const back = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25, 28, 30, 6, 15]));
  assert.equal(back.weekRating, 'good');
  assert.equal(back.win, 'Back out there: 15 km after the break.');
  assert.doesNotMatch(back.headline, /well above|safe step/);
  assert.equal(statByLabel(back, 'Volume')!.comparison, 'back after 6 km last week');
  // The comeback climbs back toward the pre-break median in rungs (wave 20): the week after a good restart is 80% of ~26.5 km,
  // capped (wave 21e) at 1.25x the 15 km just run and worded as a ceiling: "Build up to ~18 km", then ~10% a week.
  assert.equal(back.nextWeek.startsWith('Build up to ~18 km'), true);
});

test('a 2-week gap: the 0-run weeks get a real review ("rest is fine"), then a gentle restart — never "tough, 18 km short"', () => {
  const zero = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25, 0]));
  assert.equal(zero.weekRating, 'light');
  assert.equal(zero.win, null);
  assert.equal(zero.headline, 'No runs this week — rest is fine');
  assert.equal(zero.dataSufficiency.sufficient, true);
  assert.equal(zero.slip, null);
  assert.match(zero.nextWeek, /^Restart at ~\d+ km next week with easy runs/);
  const comeback = computeWeeklyReview(planReview([15, 17, 19, 21, 23, 25, 0, 0, 12]));
  assert.equal(comeback.weekRating, 'good');
  assert.equal(comeback.win, 'Back out there: 12 km after the break.');
  assert.equal(comeback.slip, null);
});

test('maintain at the goal: "Hold 30 km; long run 15 km, the rest easy" — never "Repeat this week" or "wear your watch"', () => {
  const r = computeWeeklyReview(planReview([30, 30, 30, 30, 30]));
  assert.equal(r.weekRating, 'good');
  assert.equal(r.win, 'You held your weekly goal: 30 of 30 km.');
  assert.equal(r.nextWeek, 'Hold 30 km; long run 14 km, the rest easy.');
  // The long run keeps stepping +2 km toward the peak target while the volume holds.
  const withRace = computeWeeklyReview(planReview([30, 30, 30, 30, 30], { raceDate: '2026-12-13', raceDistanceKm: 21.1 }));
  assert.equal(withRace.nextWeek, 'Hold 30 km; long run 14 km, the rest easy.');
  // Even a week with a distance the verdict does not praise never falls back to the "watch" advice.
  const odd = computeWeeklyReview(planReview([30, 30, 30, 30, 30], { verdict: 'holding' }));
  assert.doesNotMatch(odd.nextWeek, /wear your watch|Repeat this week/);
  assert.doesNotMatch(computeWeeklyReview(planReview([20, 20, 20])).nextWeek, /wear your watch/);
});

test('the growth number is the same finished-week number everywhere: the Volume stat, the headline and the plan', () => {
  const r = computeWeeklyReview(planReview([15, 17, 19, 21]));
  assert.equal(statByLabel(r, 'Volume')!.comparison, '+11% vs last week');
  assert.match(r.headline, /, \+11% vs last week$/);
  // An earlier week under 5 km (3 mi) has no percentage; "up 0%" reads "same as last week".
  assert.equal(statByLabel(computeWeeklyReview(planReview([4, 5])), 'Volume')!.comparison, 'vs 4 km last week');
  assert.equal(statByLabel(computeWeeklyReview(planReview([20, 20, 20])), 'Volume')!.comparison, 'same as last week');
  const mi = computeWeeklyReview(planReview([4, 5], { unitSystem: 'imperial' }));
  assert.equal(statByLabel(mi, 'Volume')!.comparison, 'vs 2.5 mi last week');
  assert.equal(statByLabel(computeWeeklyReview(planReview([7, 8], { unitSystem: 'imperial' })), 'Volume')!.comparison, '+14% vs last week');
});

test('half marathon table: ONE taper week (x0.75), race week x0.5, recovery x0.4 then x0.7; the race itself is a win and not volume', () => {
  // Race Sunday 2026-10-04 ends the reviewed week (race week); peak week 40 km.
  const raceWeek = planReview([30, 30, 30, 30, 30, 12], { raceDate: '2026-10-04', raceDistanceKm: 21.1, racePeakWeekKm: 40 });
  const withRace = { ...raceWeek, workouts: [...raceWeek.workouts.filter(w => w.day !== '2026-10-04'), run('2026-10-04', 21.1)], trainingDays: raceWeek.trainingDays };
  const r = computeWeeklyReview(withRace);
  assert.equal(r.headline, 'Raced the half marathon — 21.1 km, after 7.2 km in race week');
  assert.equal(r.win, 'You ran the half marathon — 21.1 km.');
  assert.equal(statByLabel(r, 'Volume')!.value, '7.2 km');
  assert.equal(statByLabel(r, 'Volume')!.comparison, 'excl. the race');
  assert.notEqual(statByLabel(r, 'Volume')!.tone, 'good'); // no "+95% [good]"
  assert.equal(r.weekRating, 'good'); // 8 km against a 20 km ceiling
  assert.equal(r.nextWeek, 'Recovery: easy only, ≤ 16 km next week.');
  // The week before the race week is the taper week: x0.75 of the peak, with the intensity spelled out.
  const toTaper = computeWeeklyReview(planReview([30, 30, 30, 30, 30, 30], { raceDate: '2026-10-11', raceDistanceKm: 21.1, racePeakWeekKm: 40 }));
  assert.equal(toTaper.nextWeek.replace(/ /g, ' ').replace(/long run [\d.]+ km/, 'long run N km'), 'Race week: short easy runs, ~20 km before the race, then rest 1–2 days before it.');
  const toRaceWeek = computeWeeklyReview(planReview([30, 30, 30, 30, 30, 30], { raceDate: '2026-10-18', raceDistanceKm: 21.1, racePeakWeekKm: 40 }));
  // (Wave 23e P3-m: 30 km weeks into a taper of 30 km - 75% of the 40 km peak - hold the volume, they do not cut it.)
  assert.match(toRaceWeek.nextWeek, /^Taper: hold ~30 km next week \(75% of your ~40 km peak\); long run [\d.]+ km easy, plus 3×1 km at race pace midweek\.$/);
  // 10K: no taper — the week before race week is still a build / maintain week.
  const ten = computeWeeklyReview(planReview([30, 30, 30, 30, 30, 30], { raceDate: '2026-10-18', raceDistanceKm: 10, racePeakWeekKm: 40 }));
  assert.match(ten.nextWeek, /^Hold 30 km;/);
});

test('rebuild: the step out of recovery is "Back to building", later weeks "Keep rebuilding"; each is graded against its step', () => {
  // Race Sun 2026-09-13 (a half): race week 09-07, recovery 09-14 (12 km) and 09-21 (20 km), the first rebuild week 09-28 (22 km).
  const weeks = [30, 30, 30, 30, 30, 5, 12, 20, 22];
  const rebuild = computeWeeklyReview(planReview(weeks, { raceDate: '2026-09-13', raceDistanceKm: 21.1, racePeakWeekKm: 30 }));
  assert.equal(rebuild.weekRating, 'good'); // 22 of a 22 km step from recovery volume
  assert.equal(rebuild.win, "You hit this week's step: 22 of ~22 km (+10% on last week).");
  assert.match(rebuild.nextWeek, /^Keep rebuilding: ~24 km next week, long run [\d.]+ km\.$/);
  // Reviewing the last recovery week (09-21): the next step is back to building, from what was run.
  const recovery = computeWeeklyReview(planReview(weeks.slice(0, 8), { weekStart: '2026-09-21', raceDate: '2026-09-13', raceDistanceKm: 21.1, racePeakWeekKm: 30 }));
  assert.equal(recovery.nextWeek, 'Back to building: ~22 km next week.');
  assert.equal(recovery.weekRating, 'good');
  // A rebuild week far short of its step is mixed with the same step wording — never "behind" or a 30 km target.
  const short = computeWeeklyReview(planReview([30, 30, 30, 30, 30, 5, 12, 20, 16], { raceDate: '2026-09-13', raceDistanceKm: 21.1, racePeakWeekKm: 30 }));
  assert.equal(short.weekRating, 'mixed');
  assert.equal(short.slip, "16 of ~22 km — 6 km short of this week's step");
});

test('a runner with distance data is never told to "wear your watch so volume and resting HR show up"', () => {
  const r = computeWeeklyReview(planReview([30, 30, 30, 30, 30]));
  assert.doesNotMatch(JSON.stringify(r), /wear your watch/);
  // Without any running in the week the generic advice may still ask for the watch (a sessions-only runner).
  const sessionsOnly = computeWeeklyReview(base({
    goal: 'endurance', verdict: 'holding', weeklySessionsTarget: 4,
    trainingDays: [WEEK[0], WEEK[2], PREV[0], PREV[2]],
    workouts: [{ day: WEEK[0], durationMin: 40, distanceKm: null, type: 'Cycling' }, { day: WEEK[2], durationMin: 40, distanceKm: null, type: 'Cycling' }],
    sleepMinutes: WEEK.map(day => ({ day, value: 470 })),
  }));
  assert.equal(sessionsOnly.weekGap?.kind, 'sessions');
});

// ── Wave 20b: wins that vary, weeks off, every main lift's next load, week over week, the rebuild, first-week sessions ──

const onTarget = (w: string[]) => [w[0], w[1], w[3], w[5]];

test('weeks on target read differently: "You hit all 4 planned sessions." → "4 of 4 again — 2 weeks running." → …, never the same line two weeks in a row', () => {
  const win = (weeks: string[][]) => computeWeeklyReview(liftReview({ trainingDays: weeks.flatMap(onTarget), signupDay: '2026-06-01' })).win;
  assert.equal(win([WEEK]), 'You hit all 4 planned sessions.');
  assert.equal(win([WEEK, PREV]), '4 of 4 again — 2 weeks running.');
  assert.equal(win([WEEK, PREV, PREV2]), '4 of 4 again — 3 weeks running.');
  assert.equal(win([WEEK, PREV2]), 'You hit all 4 planned sessions.', 'a missed week in between ends the run');
  // A month in: the run is capped at the weeks the review can see, and the wording alternates week to week.
  const allDays = Array.from({ length: 14 }, (_, k) => onTarget(Array.from({ length: 7 }, (_, i) => addDays(WEEK_START, i + 7 * (k - 8))))).flat();
  const wins = Array.from({ length: 6 }, (_, k) => computeWeeklyReview(liftReview({ weekStart: addDays(WEEK_START, 7 * k), trainingDays: allDays, weightReadings: [], signupDay: '2026-06-01' })).win);
  for (let k = 1; k < wins.length; k += 1) assert.notEqual(wins[k], wins[k - 1], `weeks ${k - 1} and ${k}: ${wins[k]}`);
  assert.ok(wins.every(w => w === '4 of 4 again — a month running.' || w === 'Another full week: all 4 planned sessions done.'), wins.join(' | '));
  // One planned session a week.
  const one = computeWeeklyReview(liftReview({ weeklySessionsTarget: 1, trainingDays: [WEEK[2]], progression: {} }));
  assert.equal(one.win, 'You hit your planned session.');
});

test('a week with no session: the headline says so (2nd, 3rd week off), weight gain is not the win, and the weeks never repeat word for word', () => {
  const lifts = (through: string) => ({ squat: ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'].filter(w => w <= through).map(w => lwk(w, 141.8, 115)) });
  const first = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [], progression: lifts('2026-09-21'), signupDay: '2026-06-01' }));
  const second = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [], progression: lifts('2026-09-14'), signupDay: '2026-06-01' }));
  const third = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [], progression: lifts('2026-09-07'), signupDay: '2026-06-01' }));
  assert.equal(first.headline, 'No sessions last week');
  assert.equal(second.headline, 'No sessions last week (2nd week off)');
  assert.equal(third.headline, 'No sessions last week (3rd week off)');
  // The scale went up 0.2 kg: still on the card as a number, but not the win, and the push is not "0 of 4 sessions, weight +0.2 kg".
  for (const r of [first, second, third]) {
    assert.equal(r.win, null);
    assert.equal(statByLabel(r, 'Weekly avg weight')!.tone, 'neutral');
    assert.doesNotMatch(JSON.stringify(r), /weekly average weight is up/);
    assert.doesNotMatch(r.nextWeek, /starting Monday/);
  }
  assert.equal(first.slip, '0 of 4 sessions — none done');
  assert.equal(second.slip, '0 of 4 sessions — 2nd week in a row');
  assert.equal(third.slip, '0 of 4 sessions — 3rd week in a row');
  assert.equal(first.nextWeek, 'Ease back in: 4 sessions at ~90% of your last working weights (Squat ~102.5 kg), starting today.');
  assert.equal(second.nextWeek, '2nd week off — book one easy session today at ~90% of your last working weights (Squat ~102.5 kg), then build back toward 4 a week.');
  assert.equal(new Set([first, second, third].map(r => `${r.headline}|${r.slip}|${r.nextWeek}`)).size, 3);
  // Weeks before the user signed up are not weeks off.
  const fresh = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [], progression: {}, signupDay: WEEK_START }));
  assert.equal(fresh.headline, 'No sessions last week', 'one week since signup is not a second week');
});

test('muscle weight gain is the win in a week with a session, not in a week without one - nor in a slack one (wave 23s)', () => {
  // Three of four sessions: the sessions stat is not a win, so the up-0.2 kg weekly average is.
  const trained = computeWeeklyReview(liftReview({ trainingDays: [WEEK[0], WEEK[2], WEEK[4]] }));
  assert.equal(statByLabel(trained, 'Weekly avg weight')!.tone, 'good');
  assert.match(trained.win ?? '', /^Your weekly average weight is up 0\.\d kg\.$/);
  // Two of four is a slack week (half the plan): the scale moved, the training did not - a neutral number, and the win is the sessions done.
  const slack = computeWeeklyReview(liftReview({ trainingDays: [WEEK[0], WEEK[3]] }));
  assert.equal(statByLabel(slack, 'Weekly avg weight')!.tone, 'neutral');
  assert.equal(slack.win, 'You still got 2 sessions in — Monday and Thursday.');
  const none = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [] }));
  assert.equal(statByLabel(none, 'Weekly avg weight')!.tone, 'neutral');
  assert.equal(none.win, null);
});

test('a slack week (1-2 of 4 sessions) has no 4-week lift win: the session itself is the win, named by day and lift (wave 22s)', () => {
  const flat = weigh([...PREV, ...WEEK], () => 80);
  const lifts = { squat: steadyAt(110), 'bench press': [...steadyAt(87.5), lwk(WEEK_START, 100, 75, 1, 1800)] };
  // 1 of 4: the squat is the headline lift (+ vs 4 weeks ago would be its win) but only a bench volume day happened.
  const one = computeWeeklyReview(liftReview({ trainingDays: [WEEK[3]], strengthDays: [WEEK[3]], weightReadings: flat, progression: lifts }));
  assert.deepEqual(one.weekGap, { kind: 'sessions', done: 1, target: 4 });
  assert.equal(one.win, "You still got Thursday's bench session in.");
  // The lift stat keeps its numbers but is not green, and the headline leads with the week, not a gain it did not produce (wave 22s).
  assert.ok(one.stats.some(st => st.label.endsWith('est. 1RM')), JSON.stringify(one.stats));
  assert.ok(one.stats.filter(st => st.label.endsWith('est. 1RM')).every(st => st.tone !== 'good'), JSON.stringify(one.stats));
  assert.equal(one.headline, '1 of 4 sessions last week — a short week');
  // A lift trained at working weight that week may still show its gain: green stat, in the headline "over 4 wks".
  const trainedSquat = computeWeeklyReview(liftReview({ trainingDays: [WEEK[0]], strengthDays: [WEEK[0]], weightReadings: flat, progression: { squat: [...steadySquat, lwk(WEEK_START, 138, 110, 1)] } }));
  assert.equal(statByLabel(trainedSquat, 'Squat est. 1RM')!.tone, 'good');
  assert.match(trainedSquat.headline, /^1 of 4 sessions, Squat est\. 1RM \+5\skg over 4\swks$/);
  // ... but not when that week's squat was a light day (a top set under 90% of its best): neutral again.
  const lightSquat = computeWeeklyReview(liftReview({ trainingDays: [WEEK[0]], strengthDays: [WEEK[0]], weightReadings: flat, progression: { squat: [...steadySquat, lwk(WEEK_START, 138, 90, 1)] } }));
  assert.equal(statByLabel(lightSquat, 'Squat est. 1RM')!.tone, 'neutral');
  assert.equal(lightSquat.headline, '1 of 4 sessions last week — a short week');
  // 2 of 4 is still half: two days named. No lift in the week's data, or more than two: just the day.
  const two = computeWeeklyReview(liftReview({ trainingDays: [WEEK[0], WEEK[3]], strengthDays: [WEEK[0], WEEK[3]], weightReadings: flat, progression: lifts }));
  assert.equal(two.win, 'You still got 2 sessions in — Monday and Thursday.');
  const noLifts = computeWeeklyReview(liftReview({ trainingDays: [WEEK[3]], strengthDays: [WEEK[3]], weightReadings: flat, progression: {} }));
  assert.equal(noLifts.win, "You still got Thursday's session in.");
  // A rising scale is no win of a slack week either (wave 23s): the win is the session she did; 3 of 4 is not slack and keeps the lift win.
  const rising = computeWeeklyReview(liftReview({ trainingDays: [WEEK[3]], strengthDays: [WEEK[3]], progression: lifts }));
  assert.equal(statByLabel(rising, 'Weekly avg weight')!.tone, 'neutral');
  assert.equal(rising.win, "You still got Thursday's bench session in.");
  const three = computeWeeklyReview(liftReview({ trainingDays: [WEEK[0], WEEK[2], WEEK[4]], strengthDays: [WEEK[0], WEEK[2], WEEK[4]], weightReadings: flat, progression: { squat: [...steadySquat, lwk(WEEK_START, 138, 110, 3)] } }));
  assert.match(three.win ?? '', /^Squat estimated 1RM is up 5\skg vs 4 weeks ago\.$/);
});

test('a flat weekly average reads "no change", not "0 kg"', () => {
  const r = computeWeeklyReview(liftReview({ weightReadings: weigh([...PREV, ...WEEK], () => 80), progression: {} }));
  const weight = statByLabel(r, 'Weekly avg weight')!;
  assert.equal(weight.value, 'no change');
  assert.equal(weight.comparison, 'vs the week before');
  assert.equal(r.headline, '4 of 4 sessions, weight steady');
  // Weight loss keeps its own wording (not this change's concern).
  assert.equal(statByLabel(computeWeeklyReview(weightLossInput({ weightReadings: weigh([...PREV, ...WEEK], () => 82) })), 'Weekly avg weight')!.value, '0 kg');
});

test('the first week after 4 of 4 sessions is a sessions-only review, not "Not enough data"', () => {
  const r = computeWeeklyReview(liftReview({ weightReadings: [], progression: {}, trainingDays: onTarget(WEEK), strengthDays: onTarget(WEEK), signupDay: WEEK_START }));
  assert.equal(r.dataSufficiency.sufficient, true);
  assert.equal(r.dataSufficiency.statCount, 1);
  assert.equal(r.headline, '4 of 4 sessions');
  assert.equal(r.win, 'You hit all 4 planned sessions.');
  assert.equal(r.weekRating, 'good');
  assert.doesNotMatch(r.nextWeek, /log meals|Log meals/);
  // Three of four is still a review (one short); two of four, or no target, is still "not enough data".
  const three = computeWeeklyReview(liftReview({ weightReadings: [], progression: {}, trainingDays: [WEEK[0], WEEK[2], WEEK[4]], signupDay: WEEK_START }));
  assert.equal(three.dataSufficiency.sufficient, true);
  assert.equal(three.slip, '3 of 4 sessions — one short');
  assert.equal(computeWeeklyReview(liftReview({ weightReadings: [], progression: {}, trainingDays: [WEEK[0], WEEK[2]], signupDay: WEEK_START })).dataSufficiency.sufficient, false);
  assert.equal(computeWeeklyReview(liftReview({ weeklySessionsTarget: null, weightReadings: [], progression: {}, trainingDays: onTarget(WEEK), signupDay: WEEK_START })).dataSufficiency.sufficient, false);
});

const triple = (lastWeek: { squat: number; bench: number; deadlift: number }, deadliftPrev = 160) => {
  const weeks = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
  return {
    squat: [...weeks.map(w => lwk(w, 135, 107.5)), lwk(WEEK_START, 138, lastWeek.squat)],
    'bench press': [...weeks.map(w => lwk(w, 100, 80)), lwk(WEEK_START, 101, lastWeek.bench)],
    deadlift: [...weeks.map(w => lwk(w, deadliftPrev, 132.5)), lwk(WEEK_START, 160, lastWeek.deadlift)],
  } as ProgressionSummary;
};

test('a good week cues every main lift trained: "Squat 110 → 112.5 kg, bench 80 → 82.5 kg, deadlift 130 → 132.5 kg"; a lift that went backwards holds', () => {
  const all = computeWeeklyReview(liftReview({ progression: triple({ squat: 110, bench: 80, deadlift: 130 }) }));
  assert.equal(all.nextWeek, 'Squat 110 → 112.5 kg, bench 80 → 82.5 kg, deadlift 130 → 132.5 kg.');
  // Deadlift's e1RM fell 6% (170 -> 160): hold it.
  const hold = computeWeeklyReview(liftReview({ progression: triple({ squat: 110, bench: 80, deadlift: 130 }, 170) }));
  assert.equal(hold.nextWeek, 'Squat 110 → 112.5 kg, bench 80 → 82.5 kg; deadlift hold at 130 kg.');
  assert.doesNotMatch(hold.nextWeek, /keep the rest/);
  // Only one lift ready: the others follow when their reps land.
  const only = computeWeeklyReview(liftReview({ progression: { squat: triple({ squat: 110, bench: 80, deadlift: 130 }).squat } }));
  assert.equal(only.nextWeek, 'Squat 110 → 112.5 kg; progress the others as they hit their reps.');
  // A main lift not trained in the reviewed week is not cued; an accessory never is.
  const p = triple({ squat: 110, bench: 80, deadlift: 130 });
  const partial = computeWeeklyReview(liftReview({ progression: { squat: p.squat, 'lat pulldown': p['bench press'] } }));
  assert.equal(partial.nextWeek, 'Squat 110 → 112.5 kg; progress the others as they hit their reps.');
  // Pounds.
  assert.equal(computeWeeklyReview(liftReview({ unitSystem: 'imperial', progression: triple({ squat: 110, bench: 80, deadlift: 130 }) })).nextWeek, 'Squat ~245 → 250 lb, bench ~175 → 180 lb, deadlift ~285 → 290 lb.');
});

test('after a deload every main lift goes back to full loads; a week off eases every one in', () => {
  const weeks = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
  const progression: ProgressionSummary = {
    squat: [...weeks.map(w => lwk(w, 132.6, 107.5)), lwk(WEEK_START, 114.1, 92.5, 2, 1920)],
    'bench press': [...weeks.map(w => lwk(w, 100, 80)), lwk(WEEK_START, 86, 70, 2, 1500)],
  };
  const deload = computeWeeklyReview(liftReview({ progression }));
  assert.equal(deload.weekRating, 'light');
  assert.equal(deload.nextWeek, 'Back to full loads: Squat 107.5 → 110 kg, bench 80 → 82.5 kg.');
  const off = computeWeeklyReview(liftReview({ trainingDays: [], strengthDays: [], progression: { squat: weeks.map(w => lwk(w, 141.8, 115)), 'bench press': weeks.map(w => lwk(w, 110, 90)) }, signupDay: '2026-06-01' }));
  assert.equal(off.nextWeek, 'Ease back in: 4 sessions at ~90% of your last working weights (Squat ~102.5 kg, bench ~80 kg), starting today.');
});

// ── Wave 24s P2-A: a proactive deload after 5 straight weeks of heavier loads ──────────────────────────────────────────────────────────────

/** `tops` kg, one lift-week each from `from` on, a week apart; the e1RM follows the load. */
const climbing = (tops: number[], from = '2026-08-24'): Array<ReturnType<typeof lwk>> => tops.map((t, i) => lwk(addDays(from, 7 * i), t * 1.2, t));

test('after 5 straight weeks of heavier loads the next-week cue is a deload, with the pre-deload loads to go back to (wave 24s)', () => {
  // Squat 100 -> 112.5 over six weeks: five step-ups in a row (09-28 is the reviewed week).
  const squat = climbing([100, 102.5, 105, 107.5, 110, 112.5]);
  const one = computeWeeklyReview(liftReview({ progression: { squat } }));
  assert.equal(one.weekRating, 'good');
  assert.equal(one.nextWeek, "Deload week: ~85–90% of last week's loads, 2 working sets — then back to Squat 112.5 kg.");
  // Every main lift trained that week is named, the lead lift first.
  const three = computeWeeklyReview(liftReview({ progression: { squat, 'bench press': climbing([80, 82.5, 85, 87.5, 90, 92.5]), deadlift: climbing([120, 122.5, 125, 127.5, 130, 132.5]) } }));
  assert.equal(three.nextWeek, "Deload week: ~85–90% of last week's loads, 2 working sets — then back to Squat 112.5 kg, bench 92.5 kg and deadlift 132.5 kg.");
  // Pounds: the loads as logged (112.5 kg = 248 lb).
  assert.equal(computeWeeklyReview(liftReview({ unitSystem: 'imperial', progression: { squat } })).nextWeek, "Deload week: ~85–90% of last week's loads, 2 working sets — then back to Squat 248 lb.");
  // Four step-ups are not enough: the normal cue.
  const four = computeWeeklyReview(liftReview({ progression: { squat: squat.slice(1) } }));
  assert.equal(four.nextWeek, 'Squat 112.5 → 115 kg; progress the others as they hit their reps.');
  // A lighter week in the run (100 -> 102.5 -> 105 -> 100 -> 102.5 -> 105) breaks it, and so does a week without the lift.
  assert.doesNotMatch(computeWeeklyReview(liftReview({ progression: { squat: climbing([100, 102.5, 105, 100, 102.5, 105]) } })).nextWeek, /Deload/);
  assert.doesNotMatch(computeWeeklyReview(liftReview({ progression: { squat: [...climbing([100, 102.5, 105]), ...climbing([107.5, 110], '2026-09-14'), lwk(WEEK_START, 135, 112.5)].filter(w => w.weekStart !== '2026-09-07') } })).nextWeek, /Deload/);
  // Returning from a break is a rebuild, never a deload.
  assert.doesNotMatch(computeWeeklyReview(liftReview({ verdict: 'building', liftReturn: RETURN, progression: { squat } })).nextWeek, /Deload/);
});

test('the week after a prescribed deload: the win praises the timing, the next week goes back to the pre-deload loads the cue named (wave 24s)', () => {
  // Six climbing weeks (08-17 .. 09-21), then the deload week (09-28): 97.5 kg x 2 sets.
  const progression: ProgressionSummary = { squat: [...climbing([100, 102.5, 105, 107.5, 110, 112.5], '2026-08-17'), lwk(WEEK_START, 117, 97.5, 2, 1920)] };
  const cue = "Deload week: ~85–90% of last week's loads, 2 working sets — then back to Squat 112.5 kg.";
  const r = computeWeeklyReview(liftReview({ progression, previousNextWeek: cue }));
  assert.equal(r.weekRating, 'light');
  assert.equal(r.win, 'Deload week done — lighter loads, good timing after 5 straight weeks of heavier loads.');
  assert.equal(r.nextWeek, 'Back to full loads: Squat 112.5 kg.');
  // A deload she took on her own keeps the step: the old rule is unchanged.
  const own = computeWeeklyReview(liftReview({ progression: { squat: [...steadySquat, lwk(WEEK_START, 114.1, 92.5, 2, 1920)] } }));
  assert.equal(own.nextWeek, 'Back to full loads: Squat 107.5 → 110 kg.');
});

test('before the first 4-week comparison the review and the goal card quote the same week over week, rounded from the change itself', () => {
  // 100.4 -> 102.6 kg: a 2.2 kg change is "+2" on both surfaces. It is not the difference of two rounded endpoints (100 -> 103 would say +3):
  // a constant +2.5 kg step read +3, +4, +3 week to week (wave 22s), and the text prints no endpoints for them to add up to.
  const progression: ProgressionSummary = { squat: [lwk('2026-09-21', 100.4, 80), lwk(WEEK_START, 102.6, 82.5)] };
  const review = computeWeeklyReview(liftReview({ progression, signupDay: '2026-09-14' }));
  const stat = statByLabel(review, 'Squat est. 1RM')!;
  assert.equal(stat.value, '+2 kg');
  assert.equal(stat.comparison, 'vs the week before');
  assert.match(review.headline, /Squat est\. 1RM \+2 kg vs the week before$/);
  const monday = '2026-10-05'; // the card, read the morning the review is (this week has no sets yet)
  const days = [...onTarget(PREV), ...onTarget(WEEK)];
  const card = computeGoalProgress({
    goal: 'muscle', todayKey: monday, target: { weightKg: null, date: null, weeklySessions: 4 }, start: { weightKg: 80, startedAt: '2026-09-14T09:00:00.000Z', startedDay: '2026-09-14' },
    weightReadings: [], intakeDays: [], budget: null, progression, trainingDays: days, strengthDays: days, workouts: [], restingHr: [], hrv: [], sleepMinutes: [], sleepGoalMinutes: 480,
  });
  // The card, read that Monday, says the same pair, labelled with its window: the review's week is "last week" by then.
  assert.equal(plainSpaces(card.reasons.find(r => r.kind === 'lift')!.text), 'Last week: Squat est. 1RM +2 kg vs the week before');
});

test('rebuilding: the headline carries the rebuild with the shown numbers, and the percentage is computed from them', () => {
  // 136.5 -> 137 shown, 142.4 -> 142 shown: 96%, not the 95% the unrounded numbers give.
  const r = computeWeeklyReview(liftReview({
    verdict: 'building', liftReturn: { ...RETURN, preBreakKg: 142.4, recentKg: 136.5 }, progression: { squat: squatReturn },
  }));
  assert.equal(r.headline, '4 of 4 sessions, Squat est. 1RM 137 of 142 kg pre-break');
  assert.equal(statByLabel(r, 'Squat est. 1RM')!.value, '137 kg');
  assert.equal(statByLabel(r, 'Squat est. 1RM')!.comparison, '96% of your 142 kg pre-break best');
  // Regained exactly: the stat and headline say "back at".
  const at = computeWeeklyReview(liftReview({ liftReturn: { ...RETURN, recentKg: 142, pct: 100, regained: true }, progression: { squat: [...squatReturn.slice(0, 4), lwk(WEEK_START, 142, 115)] } }));
  assert.equal(at.headline, '4 of 4 sessions, Squat est. 1RM back at pre-break best');
  // A week off while returning is a week off, not a rebuild headline.
  const off = computeWeeklyReview(liftReview({ liftReturn: RETURN, trainingDays: [], strengthDays: [], progression: { squat: squatReturn.slice(0, 4) } }));
  assert.match(off.headline, /^No sessions last week/);
  assert.doesNotMatch(off.headline, /pre-break/);
});

// ── wave 20c: the review's too-fast / too-slow call is the goal card's, reached copy depends on the budget ──

test('B1. a week is not called too fast off one week-to-week drop in the mean: the card (the 21-day pace) decides', () => {
  // The weekly mean falls 1 kg (about 1.2% of bodyweight); 4 of the 6 logged days are in budget.
  const input = (verdict: WeeklyReviewInput['verdict']) => weightLossInput({
    verdict,
    weightReadings: [...weigh(PREV, () => 83), ...weigh(WEEK, () => 82)],
    intakeDays: intake([...PREV, ...WEEK.slice(0, 6)], [2300, 2250, 2400, 2300, 2350, 2500, 2450, 1900, 1950, 2000, 2050, 2450, 2500]),
  });
  // The card says progressing (inside the safe band): the drop is a neutral-to-good stat, not "faster than is comfortable".
  const fine = computeWeeklyReview(input('progressing'));
  assert.equal(statByLabel(fine, 'Weekly avg weight')!.value, '−1 kg');
  assert.equal(statByLabel(fine, 'Weekly avg weight')!.tone, 'good');
  assert.equal(fine.weekRating, 'mixed'); // 4 of 6 logged days in budget — rated on the budget, not the weight
  assert.equal(fine.weekGap?.kind, 'budget');
  assert.doesNotMatch(`${fine.win} ${fine.slip} ${fine.nextWeek}`, /faster than|too fast|slower loss/);
  assert.ok(!TOO_FAST_TIPS.includes(fine.nextWeek), fine.nextWeek);
  // The card says too fast: the same week is flagged, and a flag from the weight never makes the week tough.
  const fast = computeWeeklyReview(input('too_fast'));
  assert.equal(statByLabel(fast, 'Weekly avg weight')!.tone, 'watch');
  assert.equal(fast.weekRating, 'mixed');
  assert.equal(fast.weekGap?.kind, 'weight');
  assert.match(fast.slip ?? '', /faster than is comfortable to sustain/);
  assert.ok(TOO_FAST_TIPS.includes(fast.nextWeek), fast.nextWeek);
});

test('B1. a good budget week with a drop in the mean is good unless the card says too fast; then mixed, never tough', () => {
  const week = (verdict: WeeklyReviewInput['verdict']) => computeWeeklyReview(weightLossInput({
    verdict,
    weightReadings: [...weigh(PREV, () => 83), ...weigh(WEEK, () => 82)],
  }));
  assert.equal(week('on_track').weekRating, 'good');
  assert.equal(week('on_track').weekGap, null);
  assert.equal(week('too_fast').weekRating, 'mixed');
});

test('B8. a reached goal says "switch to maintenance" until the calorie target already is maintenance, then "stay on maintenance"', () => {
  const tips = (budget: WeeklyReviewInput['budget']) => Array.from({ length: 6 }, (_, k) => {
    const start = addDays(WEEK_START, 7 * k);
    const days = Array.from({ length: 14 }, (_, i) => addDays(start, i - 7));
    return computeWeeklyReview(reachedWeekInput({
      weekStart: start,
      reachedAt: days[2],
      budget,
      weightReadings: weigh(days, i => 84 + (i % 2 === 0 ? 0.05 : -0.05)),
      intakeDays: intake(days, Array.from({ length: 14 }, () => 2000)),
      trainingDays: [days[8], days[10], days[12]],
    })).nextWeek;
  });
  const deficit = tips({ targetKcal: 2000, proteinG: 150, floorKcal: 1500, formulaTdee: 2500, learnedTdee: null, tdeeConfidence: null });
  const unknown = tips({ targetKcal: 2000, proteinG: 150, floorKcal: 1500, formulaTdee: null, learnedTdee: null, tdeeConfidence: null });
  for (const list of [deficit, unknown]) {
    assert.ok(list.some(t => /^Switch to maintenance in Goals/.test(t)), list.join(' | '));
    assert.ok(list.some(t => /switch to maintenance and enjoy holding here/.test(t)), list.join(' | '));
    assert.ok(!list.some(t => /stay on maintenance|already at maintenance/.test(t)), 'a fat-loss goal that is reached but not switched is not on maintenance');
  }
  const atMaintenance = tips({ targetKcal: 2000, proteinG: 150, floorKcal: 1500, formulaTdee: 2050, learnedTdee: null, tdeeConfidence: null });
  assert.ok(atMaintenance.some(t => /already at maintenance/.test(t)), atMaintenance.join(' | '));
  assert.ok(atMaintenance.some(t => /stay on maintenance and enjoy holding here/.test(t)), atMaintenance.join(' | '));
  assert.ok(!atMaintenance.some(t => /^Switch to maintenance|switch to maintenance and enjoy/.test(t)), atMaintenance.join(' | '));
});
