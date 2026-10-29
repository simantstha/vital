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
