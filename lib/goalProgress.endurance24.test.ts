/**
 * Wave 24e - endurance round 6: ONE rest-of-week budget. "What is left of this week" used to be worked out in several places with different thresholds
 * (the Saturday trim at 110%, the hold's grade at 105%, "the week's km are done" under 3 km, the review's "on plan" only at 100%). Every test here was
 * written BEFORE the rule it locks in. (Its own file, like the wave 20 - 23 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { enduranceWeekPlan, gradeEnduranceWeek, holdOverrun, type PlanRun } from './enduranceProgression';
import { computeGoalProgress as computeGoalProgressRaw, type GoalProgress, type GoalProgressInput } from './goalProgress';
import { formatGoalProgressLines } from './goalPromptText';
import { plainSpaces } from './displayText';

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
    todayKey: '2026-10-22',
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
const toPlanRuns = (runs: Run[]): PlanRun[] => runs.map(r => ({ day: r.day, km: r.distanceKm }));
const nbsp = (s: string): string => s.replace(/ /g, ' ');

// The calendar's cutback week is Monday 2026-10-19 (~20 km after 15..23); skipped (25 km) it brings a hold week from Monday 2026-10-26.
const CUTBACK_HISTORY = [wk(23), wk(21), wk(19), wk(17), wk(15)];
const HOLD_HISTORY = [wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];

test('ONE tolerance per plan kind: a runner who does what Saturday says in a hold week is never "above the hold"', () => {
  // The hold week of Monday 2026-10-26: ~25 km, long run 11 held. Saturday evening with `done` km in (Tue / Thu / Sat runs), then exactly what the card says.
  const sat = '2026-10-31';
  let checked = 0;
  for (let done = 10; done <= 27; done += 0.5) {
    const runs = weeks(sat, [[[1, done / 3], [3, done / 3], [5, done / 3]], ...HOLD_HISTORY]);
    const plan = enduranceWeekPlan({ runs: toPlanRuns(runs), weekStart: '2026-10-26', goalKm: 30, today: sat });
    assert.equal(plan.kind, 'hold');
    const trim = plan.longRunTrim;
    // What the card tells him to run on Sunday: nothing when done, the trimmed long run when it names one, a short easy run when under 3 km are left, else the plan's own long run.
    const sunday = trim == null ? (plan.longRunKm ?? 0) : trim.weekDone ? 0 : plan.longRunKm ?? trim.remainingKm;
    const total = done + sunday;
    if (done >= 25 * 1.05) continue; // the week was over before Sunday: nothing the card can say undoes it
    checked++;
    assert.ok(total <= 25 * 1.05 + 1e-9, `${done} km in by Saturday, the card says ${sunday} km on Sunday = ${total} km, past the hold's 105% (${25 * 1.05} km)`);
    assert.equal(holdOverrun({ kind: 'hold', targetKm: 25, longRunKm: plan.longRunTrim?.fullKm ?? plan.longRunKm }, total, sunday > 0 ? sunday : null), false, `${total} km with a ${sunday} km Sunday is "above the hold"`);
  }
  assert.ok(checked > 20);
});

test('"done" is the review\'s band: the km left are at most 10% of the week\'s number; under 3 km and over 10% is one short easy run', () => {
  // Week 5 of a plain build (15, 17, 19, 21 -> ~23 km). Saturday evening with `done` km in.
  const sat = '2026-10-17';
  let done20 = 0;
  for (let done = 17; done <= 25; done += 0.5) {
    const runs = weeks(sat, [[[1, done / 3], [3, done / 3], [5, done / 3]], wk(21), wk(19), wk(17), wk(15)]);
    const plan = enduranceWeekPlan({ runs: toPlanRuns(runs), weekStart: '2026-10-12', goalKm: 30, today: sat });
    assert.equal(plan.targetKm, 23);
    const trim = plan.longRunTrim;
    if (trim?.weekDone) {
      done20++;
      assert.ok(23 - done <= 2.3 + 1e-9, `${done} km of ~23 is "done" with ${23 - done} km left, more than 10% of the week`);
      assert.equal(gradeEnduranceWeek(plan, done).level, 'good', `${done} of ~23 km is "done" on the card but not a good week in the review`);
    }
    if (done >= 20.7 && done < 23) assert.equal(trim?.weekDone, true, `${done} of ~23 km is inside the review's on-plan band but the card does not say it is done`);
    if (trim != null && !trim.weekDone && 23 - done < 3) {
      assert.equal(trim.small, true);
      assert.match(nbsp(plan.purpose), /left: one short easy run/);
    }
  }
  assert.ok(done20 > 3);
});

test('the headline carries the budget: "Cutback week - 18.7 of ~20 km, this week\'s km are done" (it used to read last week\'s "Building - 23 km last week (+10%), on plan")', () => {
  const thu = '2026-10-22';
  const card = computeGoalProgress(input(weeks(thu, [[[1, 9.4], [3, 9.3]], ...CUTBACK_HISTORY]), { todayKey: thu }));
  assert.equal(card.headline, "Cutback week — 18.7 of ~20 km, this week's km are done");
  assert.equal(card.reasons.find(r => r.kind === 'volume')?.text, "18.7 of ~20 km — this week's km are done; rest or an easy 20-min jog");
  assert.equal(card.verdict, 'building');
  // The coach's lines say the same (the opener is built from the headline).
  const text = formatGoalProgressLines(card, 'metric').join('\n');
  assert.match(text, /Verdict: building — "Cutback week — 18\.7 of ~20 km, this week's km are done"/);
  assert.match(text, /the week's km are done: rest or an easy 20-min jog, no catch-up volume/);
  // Several usual run days left: the total, in the headline too.
  const total = computeGoalProgress(input(weeks(thu, [[[1, 7], [3, 7]], ...CUTBACK_HISTORY]), { todayKey: thu }));
  assert.equal(total.headline, 'Cutback week — 14 of ~20 km, 6 km left this week');
  // Nothing to budget (the long run fits): last week's read stands.
  const fits = computeGoalProgress(input(weeks(thu, [[[1, 6], [3, 6]], ...CUTBACK_HISTORY]), { todayKey: thu }));
  assert.match(fits.headline, /^Building — 23 km last week/);
});

test('"~2 km left" is one short easy run, and "or rest, either is fine" only when resting still lands the week in the good band (a rebuild week at 80%+)', () => {
  // A normal build week of ~23 km at 20.5 km on Saturday evening: 2.5 km left is more than 10%: one short easy run, no "either is fine" (resting is a 2.5 km short week).
  const sat = '2026-10-17';
  const normal = enduranceWeekPlan({ runs: toPlanRuns(weeks(sat, [[[1, 6.8], [3, 6.8], [5, 6.9]], wk(21), wk(19), wk(17), wk(15)])), weekStart: '2026-10-12', goalKm: 30, today: sat });
  assert.equal(normal.longRunTrim?.small, true);
  assert.equal(normal.longRunTrim?.easyOk, false);
  const gp = computeGoalProgress(input(weeks(sat, [[[1, 6.8], [3, 6.8], [5, 6.9]], wk(21), wk(19), wk(17), wk(15)]), { todayKey: sat }));
  assert.equal(gp.reasons.find(r => r.kind === 'volume')?.text, '20.5 of ~23 km — ~2.5 km left: one short easy run');
});

test('the coach says the same rest of the week as the card (total, named day, small, done)', () => {
  const coachOf = (gp: GoalProgress): string => formatGoalProgressLines(gp, 'metric').join('\n');
  const thu = '2026-10-22';
  const total = coachOf(computeGoalProgress(input(weeks(thu, [[[1, 7], [3, 7]], ...CUTBACK_HISTORY]), { todayKey: thu })));
  assert.match(total, /6 km left this week: one easy run of ~6 km, or two of ~3 km, so the week stays at ~20 km/);
  const sat = '2026-10-24';
  const named = coachOf(computeGoalProgress(input(weeks(sat, [[[1, 5], [3, 5], [5, 4]], ...CUTBACK_HISTORY]), { todayKey: sat })));
  assert.match(named, /keep Sunday's long run to ~6 km so the week stays at ~20 km/);
});
