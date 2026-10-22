/**
 * Wave 23e - endurance card, round 5: the week's long run against what is left of the week (one number everywhere), a Sunday
 * morning that is not "Behind", and the Thursday that is not "Light week". (Its own file, like the wave 20 / 21 / 22 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { enduranceWeekPlan, type PlanRun } from './enduranceProgression';
import { computeGoalProgress as computeGoalProgressRaw, type GoalProgress, type GoalProgressInput } from './goalProgress';
import { plainSpaces } from './displayText';

const TODAY = '2026-10-06'; // Tuesday

function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  return JSON.parse(plainSpaces(JSON.stringify(computeGoalProgressRaw(input)))) as GoalProgress;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type Run = { day: string; durationMin: number; distanceKm: number; type: string };
const run = (day: string, km: number): Run => ({ day, durationMin: Math.round(km * 6), distanceKm: km, type: 'Running' });

function input(runs: Run[], over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return {
    goal: 'endurance',
    todayKey: TODAY,
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    start: { weightKg: null, startedAt: null },
    weightReadings: [],
    intakeDays: [],
    budget: null,
    progression: {},
    trainingDays: runs.map(r => r.day),
    workouts: runs,
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    ...over,
  };
}

/** `plan[0]` is the week of `todayKey`; each entry is `[weekday (Mon = 0), km]`; days after today are dropped. */
function weeks(todayKey: string, plan: Array<Array<[number, number]>>): Run[] {
  const dow = (new Date(`${todayKey}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(todayKey, -dow);
  const out: Run[] = [];
  plan.forEach((w, i) => {
    for (const [d, km] of w) {
      const day = addDays(monday, -7 * i + d);
      if (day <= todayKey) out.push(run(day, km));
    }
  });
  return out;
}
const wk = (km: number): Array<[number, number]> => [[1, km * 0.2], [3, km * 0.2], [5, km * 0.2], [6, km * 0.4]];
const texts = (p: GoalProgress): string => p.reasons.map(r => r.text).join(' | ');

const toPlanRuns = (runs: Run[]): PlanRun[] => runs.map(r => ({ day: r.day, km: r.distanceKm }));

// The calendar's cutback week: Monday 2026-10-19 (~20 km, long run 9 km held), after four plain build weeks 15 -> 23 km.
const CUTBACK_HISTORY = [wk(23), wk(21), wk(19), wk(17), wk(15)];

test('the plan trims the long run to what is left when done + the unrun long run is over 110% of the week (and says so once)', () => {
  const thu = '2026-10-22';
  const runs = weeks(thu, [[[1, 7], [3, 7]], ...CUTBACK_HISTORY]);
  const plan = enduranceWeekPlan({ runs: toPlanRuns(runs), weekStart: '2026-10-19', goalKm: 30, today: thu });
  assert.equal(plan.cutback?.normalKm, 25);
  assert.equal(plan.targetKm, 20);
  // 14 km in + the 9 km long run is 23 km, past 110% of 20: the long run is what is left (6 km), a number everywhere.
  assert.deepEqual(plan.longRunTrim, { fullKm: 9, doneKm: 14, remainingKm: 6, weekDone: false, today: false });
  assert.equal(plan.longRunKm, 6);
  assert.equal(plan.longRun.nextKm, 6);
  assert.equal(plan.longRunAhead, true);
  assert.equal(plan.purpose.replace(/ /g, ' '), 'Cutback week: ~20 km, long run 6 km — absorb the last three weeks');
  assert.equal(plan.longRun.held, true); // a cutback week holds its long run by definition (the trim does not change that)
});

test('under 3 km (2 mi) left: no long run is planned, the week is done', () => {
  const thu = '2026-10-22';
  const plan = enduranceWeekPlan({ runs: toPlanRuns(weeks(thu, [[[1, 9.4], [3, 9.3]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: thu });
  // The Tuesday / Thursday runs are 9+ km: the week's long run is behind, 1.3 km are left.
  assert.equal(plan.longRunAhead, false);
  assert.equal(plan.longRunTrim?.weekDone, true);
  assert.equal(plan.longRunKm, null);
  assert.equal(plan.purpose.replace(/ /g, ' '), 'Cutback week: ~20 km this week, done — no long run (rest or a 20-min jog)');
  // Friday of a week with the long run ahead and 18 km in: 18 + 9 > 22 and 2 km are left: skip the long run.
  const fri = '2026-10-23';
  const ahead = enduranceWeekPlan({ runs: toPlanRuns(weeks(fri, [[[1, 6], [3, 6], [4, 6]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: fri });
  assert.equal(ahead.longRunAhead, true);
  assert.deepEqual(ahead.longRunTrim, { fullKm: 9, doneKm: 18, remainingKm: 2, weekDone: true, today: false });
});

test('a week whose long run still fits is untouched (done + long run <= 110% of the week: 12 + 9 = 21 of 22)', () => {
  const thu = '2026-10-22';
  const plan = enduranceWeekPlan({ runs: toPlanRuns(weeks(thu, [[[1, 6], [3, 6]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: thu });
  assert.equal(plan.longRunTrim, null);
  assert.equal(plan.longRunKm, 9);
});

test('the trim belongs to the week being read: the review\'s read of the coming Monday (nothing run yet) has none', () => {
  const sunday = '2026-10-25';
  const runs = toPlanRuns(weeks(sunday, [[[1, 7], [3, 7], [5, 3], [6, 3]], ...CUTBACK_HISTORY]));
  const next = enduranceWeekPlan({ runs, weekStart: '2026-10-26', goalKm: 30, today: '2026-10-26' });
  assert.equal(next.longRunTrim, null);
  assert.ok(next.longRunKm != null);
});

test('Sunday morning, long run ahead: the card does not judge the week - it says what the long run is for (never "Behind")', () => {
  const sun = '2026-10-11';
  // Week 2: Tue 3 / Thu 3 / Sat 3 = 9 of ~17, the 8 km long run ahead.
  const card = computeGoalProgress(input(weeks(sun, [[[1, 3], [3, 3], [5, 3]], wk(15)]), { todayKey: sun }));
  assert.doesNotMatch(card.headline, /Behind|Week done|a bit under|Holding steady/);
  assert.equal(card.distance!.plan?.longRunAhead, true);
  assert.match(card.reasons.find(r => r.kind === 'plan')!.text, /long run 8 km/);
  // The same Sunday evening, long run in: the week is judged in the Monday review's words.
  const done = computeGoalProgress(input(weeks(sun, [[[1, 3], [3, 3], [5, 3], [6, 8]], wk(15)]), { todayKey: sun }));
  assert.match(done.headline, /^Week done — 17 of ~17 km, on plan$/);
});

test('Sunday morning, a week the long run can no longer make is still judged', () => {
  const sun = '2026-10-11';
  // 3 km of ~17 and an 8 km long run: 11 km would be a 64% week - the week is short whatever happens today.
  const card = computeGoalProgress(input(weeks(sun, [[[1, 3]], wk(15)]), { todayKey: sun }));
  assert.equal(card.distance!.plan?.longRunAhead, true);
  assert.notEqual(card.verdict, 'on_track');
});

test('Thursday morning: a runner who did exactly the plan on Tuesday is not "Light week" (his Thursday run is still ahead); Friday without it is', () => {
  const thu = '2026-10-08';
  const card = computeGoalProgress(input(weeks(thu, [[[1, 3]], [[1, 3], [3, 3], [5, 3], [6, 6]]]), { todayKey: thu }));
  assert.doesNotMatch(card.headline, /^Light week/);
  assert.notEqual(card.distance!.plan?.lightWeek, true);
  // Friday morning, the Thursday run never happened: 3 of ~17 km with the usual 6.0 km by Thursday behind.
  const fri = '2026-10-09';
  const late = computeGoalProgress(input(weeks(fri, [[[1, 3]], [[1, 3], [3, 3], [5, 3], [6, 6]]]), { todayKey: fri }));
  assert.match(late.headline, /^Light week/);
});

test('the remaining-km line and the plan line carry the same number, and so does the coach (see goalPromptText.endurance23.test.ts)', () => {
  const thu = '2026-10-22';
  const card = computeGoalProgress(input(weeks(thu, [[[1, 7], [3, 7]], ...CUTBACK_HISTORY]), { todayKey: thu }));
  assert.equal(card.reasons[0].text, "14 of ~20 km — keep Sunday's long run to ~6 km");
  assert.equal(card.distance!.plan?.longRunKm, 6);
  assert.equal(card.longRun?.nextKm, 6);
  assert.equal(card.distance!.plan?.longRunTrim?.fullKm, 9);
  assert.equal(texts(card).includes('one short easy run'), false);
  // On the long-run day itself the line is about today.
  const sun = '2026-10-25';
  const today = computeGoalProgress(input(weeks(sun, [[[1, 6], [3, 6], [5, 3]], ...CUTBACK_HISTORY]), { todayKey: sun }));
  assert.match(today.reasons[0].text, /^15 of ~20 km — keep today's long run to ~5 km$/);
});

test('the Sunday of a hold week he built through reads "above the hold", not "on plan"; kept, it is "on plan"; the Monday after says so too', () => {
  // Cutback week of Monday 2026-10-19 skipped (25 km, not ~20): the week of 2026-10-26 holds ~25 km.
  const history = [wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];
  const sun = '2026-11-01';
  const built = computeGoalProgress(input(weeks(sun, [[[1, 5.6], [3, 5.6], [5, 5.6], [6, 11.2]], ...history]), { todayKey: sun }));
  assert.equal(built.distance!.plan?.kind, 'hold');
  assert.equal(built.headline, 'Week done — 28 of ~25 km, above the hold');
  const kept = computeGoalProgress(input(weeks(sun, [[[1, 5], [3, 5], [5, 5], [6, 10]], ...history]), { todayKey: sun }));
  assert.equal(kept.headline, 'Week done — 25 of ~25 km, on plan');
  // The long run alone can break the hold: 25 km, a 13 km Sunday against the held ~10.
  const longBroke = computeGoalProgress(input(weeks(sun, [[[1, 4], [3, 4], [5, 4], [6, 13]], ...history]), { todayKey: sun }));
  assert.match(longBroke.headline, /^Week done — 25 of ~25 km, above the hold$/);
  // Monday after the built-through hold week: last week is named for what it was.
  const monday = '2026-11-02';
  const next = computeGoalProgress(input(weeks(monday, [[], [[1, 5.6], [3, 5.6], [5, 5.6], [6, 11.2]], ...history]), { todayKey: monday }));
  assert.equal(next.distance!.plan?.kind, 'maintain');
});
