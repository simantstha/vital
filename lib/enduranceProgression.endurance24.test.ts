/**
 * Wave 24e - the endurance week plan, round 6: a restart that begins mid-week is scaled to the days left, and the next Monday is the full restart week.
 * Every test here was written BEFORE the rule it locks in. (Its own file, like the wave 20 - 23 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { addDayKey, enduranceWeekPlan, type PlanRun } from './enduranceProgression';

const WEEK1 = '2026-09-14';
const monday = (n: number): string => addDayKey(WEEK1, 7 * (n - 1));
const nbsp = (s: string): string => s.replace(/ /g, ' ');

/** One 4-run week (Tue / Thu / Sat and a 40% Sunday long run) per entry, week 1 first; 0 = no runs. */
function runsFor(kms: number[]): PlanRun[] {
  const runs: PlanRun[] = [];
  kms.forEach((km, i) => {
    if (km <= 0) return;
    const w = monday(i + 1);
    runs.push({ day: addDayKey(w, 1), km: km * 0.2 }, { day: addDayKey(w, 3), km: km * 0.2 }, { day: addDayKey(w, 5), km: km * 0.2 }, { day: addDayKey(w, 6), km: km * 0.4 });
  });
  return runs;
}
const run = (week: number, dow: number, km: number): PlanRun => ({ day: addDayKey(monday(week), dow), km });

// Weeks 1-6 build to 25 km (the median of the last four is 22), week 7 is empty: a break. The restart after an 8-14 day gap is ~75% of 22 = 17 km.
const BEFORE = runsFor([15, 17, 19, 21, 23, 25]);
const planOf = (runs: PlanRun[], week: number, dow: number) => enduranceWeekPlan({ runs: runs.filter(r => r.day <= addDayKey(monday(week), dow)), weekStart: monday(week), goalKm: 30, today: addDayKey(monday(week), dow) });

test('a restart whose first run back is on Thursday is scaled to the days left: round(17 x 4 / 7) = 10 km, nothing over 4 km, and Monday is the 17 km restart week', () => {
  // Week 7 is empty; the first run back is Thursday of week 8 (a 3 km run).
  const runs = [...BEFORE, run(8, 3, 3)];
  const thu = planOf(runs, 8, 3);
  assert.equal(thu.kind, 'restart');
  assert.deepEqual(thu.restart?.midWeek, { fullKm: 17, daysLeft: 4, km: 10, longCapKm: 4, pending: false });
  assert.equal(thu.targetKm, 10);
  assert.equal(thu.longRunKm, 4);
  assert.equal(nbsp(thu.purpose), 'Restart mid-week: ~10 km this week in 2–3 easy runs, nothing over ~4 km; the restart week (~17 km) starts Monday');
  // Saturday and Sunday of that week: the same stub.
  const sun = planOf([...runs, run(8, 5, 3), run(8, 6, 4)], 8, 6);
  assert.equal(sun.targetKm, 10);
  assert.equal(sun.restart?.midWeek?.pending, false);
  // The next Monday is the restart week at the FULL number, and the climb back builds on it (the next rung is from the full restart).
  const full = [...runs, run(8, 5, 3), run(8, 6, 4)];
  const next = planOf(full, 9, 0);
  assert.equal(next.kind, 'restart');
  assert.equal(next.targetKm, 17);
  assert.equal(next.restart?.midWeek, undefined);
  const after = planOf([...full, run(9, 1, 4), run(9, 3, 4), run(9, 5, 4), run(9, 6, 5)], 10, 0);
  assert.equal(after.kind, 'build');
  assert.equal(after.comeback?.weeksSince, 1);
  assert.equal(after.targetKm, 19); // the step over the 17 km restart week (a stub of 10 km would have made it 11)
});

test('on the break the card knows what to take if the runner starts today: pending from Thursday, none before (Tuesday / Wednesday start is the restart week)', () => {
  // Thursday morning of week 8, nothing run yet this week: on a break (11 days since the last run).
  const thuMorning = planOf(BEFORE, 8, 3);
  assert.equal(thuMorning.onBreak, true);
  assert.deepEqual(thuMorning.restart?.midWeek, { fullKm: 17, daysLeft: 4, km: 10, longCapKm: 4, pending: true });
  assert.equal(thuMorning.targetKm, 17, 'the break card keeps the restart number');
  // Tuesday: six days left, the restart week as it is (no stub).
  assert.equal(planOf(BEFORE, 8, 1).restart?.midWeek, undefined);
  // Sunday: a restart tomorrow is next week's.
  assert.equal(planOf(BEFORE, 8, 6).restart?.midWeek, undefined);
  // A first run back on Tuesday is the restart week itself: no stub, the next week is a normal rung.
  const tue = planOf([...BEFORE, run(8, 1, 4)], 8, 1);
  assert.equal(tue.restart?.midWeek, undefined);
  assert.equal(tue.targetKm, 17);
});

test('the first run back on a Sunday never shrinks the week below what it ran (the older rule stands)', () => {
  const plan = planOf([...BEFORE, run(8, 6, 14)], 8, 6);
  assert.equal(plan.kind, 'restart');
  assert.equal(plan.restart?.midWeek, undefined);
  assert.ok((plan.targetKm as number) >= 14, `${plan.targetKm}`);
});

// ── wave 24e group 2: hold and cutback rules ─────────────────────────────────

import { holdOverrunRead } from './enduranceProgression';
import { buildScenario } from './timeline/scenarios';
import { addDays as scnAddDays } from './timeline/types';

const MI = 1 / 1.609344;
const onPlanRuns = (): PlanRun[] => buildScenario('runner_on_plan').workouts.map(w => ({ day: w.day, km: (w.distanceM as number) / 1000 }));
const onPlanPlan = (idx: number, unitsPerKm: number) => {
  const scn = buildScenario('runner_on_plan');
  const today = scnAddDays(scn.day0, idx);
  const mon = scnAddDays(scn.day0, Math.floor(idx / 7) * 7);
  return enduranceWeekPlan({ runs: onPlanRuns().filter(r => r.day <= today), weekStart: mon, goalKm: 30, race: { date: scn.user.raceDate, distanceKm: 21.1 }, today, unitsPerKm, goalStartDay: scn.day0 });
};

test('a cutback that became a normal week at the GOAL week (30 km) is followed by a maintain week, not a hold below the goal; the cutback is still owed', () => {
  const p = onPlanPlan(70, 1); // Monday after the second cutback week, run as 30 km (the week it replaced WAS the goal)
  assert.equal(p.kind, 'maintain');
  assert.equal(p.hold, null);
  assert.equal(p.targetKm, 30);
  assert.equal(p.cutbackOwed, true);
  assert.equal(nbsp(p.purpose), 'Hold 30 km this week: long run 15 km, the rest easy');
  assert.doesNotMatch(p.purpose, /easier week|normal week/);
  // Below the goal it is still a hold (the week of d42: the cutback replaced a 25 km week).
  const hold = onPlanPlan(42, 1);
  assert.equal(hold.kind, 'hold');
  assert.equal(hold.hold?.skippedCutback, true);
  // Its plan line says why there is no step - and "an easier week" only when it is easier (25 after 25 is not).
  assert.equal(nbsp(hold.purpose), 'Your cutback became a normal week — fine. Hold ~25 km this week, long run 11 km — no 10% step on top of it');
});

test('a hold is graded by km first: a long run past the held one breaks it only when oversized (over 55% of the week); "km" and "long" are told apart', () => {
  const plan = { kind: 'hold' as const, targetKm: 25, longRunKm: 11 };
  assert.equal(holdOverrunRead(plan, 25, 11), null);
  assert.equal(holdOverrunRead(plan, 25, 13), null); // 52%: the same rule as a maintain week's
  assert.deepEqual(holdOverrunRead(plan, 25, 14), { kind: 'long', longKm: 14, heldKm: 11 }); // 56%
  assert.deepEqual(holdOverrunRead(plan, 27, 11), { kind: 'km' });
  assert.equal(holdOverrunRead({ kind: 'build' as const, targetKm: 25, longRunKm: 11 }, 40, 30), null);
});

test('metric and imperial trim the second cutback the same way (Saturday: 15 km in, the 12 km long run would carry the week past 110%); the imperial long run is the half-mile cap, not 7 mi', () => {
  const km = onPlanPlan(68, 1);
  const mi = onPlanPlan(68, MI);
  assert.equal(km.longRunTrim != null, true);
  assert.equal(mi.longRunTrim != null, true, 'imperial did not trim');
  assert.equal(nbsp(km.purpose), 'Cutback week: ~24 km, long run 9 km — absorb the last three weeks');
  assert.equal(nbsp(mi.purpose), 'Cutback week: ~15 mi, long run 5.5 mi — absorb the last three weeks');
  assert.equal(km.longRunTrim?.fullKm, 12);
  assert.ok(Math.abs((mi.longRunTrim?.fullKm ?? 0) * MI - 7.5) < 0.01, `${mi.longRunTrim?.fullKm}`);
});

test('imperial: the held long run is never past the peak the goal fits (9.5 mi against the 9 mi of an 18.6 mi week)', () => {
  const p = onPlanPlan(75, MI);
  assert.ok((p.longRunKm ?? 0) * MI <= 9 + 1e-6, `${(p.longRunKm ?? 0) * MI} mi`);
  assert.match(nbsp(p.purpose), /long run 9 mi/);
});
