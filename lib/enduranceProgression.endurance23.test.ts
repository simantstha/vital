/**
 * Wave 23e - the endurance week plan, round 5: a skipped cutback is owed. (Its own file, like the wave 20 / 21 / 22 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { addDayKey, enduranceWeekPlan, type PlanRun } from './enduranceProgression';

/** The calendar's cutback weeks are Mon 2026-10-19 and every 28 days from it (09-21, 11-16, 12-14). */
const WEEK1 = '2026-09-14';
const monday = (n: number): string => addDayKey(WEEK1, 7 * (n - 1));

/** One 4-run week (Tue / Thu / Sat and a 40% Sunday long run) per entry, week 1 first. */
function runsFor(kms: number[]): PlanRun[] {
  const runs: PlanRun[] = [];
  kms.forEach((km, i) => {
    const w = monday(i + 1);
    runs.push({ day: addDayKey(w, 1), km: km * 0.2 }, { day: addDayKey(w, 3), km: km * 0.2 }, { day: addDayKey(w, 5), km: km * 0.2 }, { day: addDayKey(w, 6), km: km * 0.4 });
  });
  return runs;
}

const planOf = (runs: PlanRun[], week: number, goalKm = 30) => enduranceWeekPlan({ runs: runs.filter(r => r.day < monday(week + 1)), weekStart: monday(week), goalKm, today: monday(week) });

test('a skipped cutback is OWED: the skip-hold counts as a build week, the cutback comes back on the next calendar slot', () => {
  // Weeks 1-5 build, week 6 (Mon 10-19) is the calendar's cutback (~20 km) run as a normal 25 km week, week 7 holds ~25, weeks 8-9 build.
  const kms = [15, 17, 19, 21, 23, 25, 25, 27, 29];
  const runs = runsFor(kms);
  const w6 = planOf(runs, 6);
  assert.equal(w6.cutback?.normalKm, 25);
  assert.equal(w6.cutbackOwed, false);
  const w7 = planOf(runs, 7);
  assert.equal(w7.kind, 'hold');
  assert.equal(w7.hold?.skippedCutback, true);
  assert.equal(w7.cutbackOwed, true);
  assert.equal(w7.buildWeeks, 1); // the skip-hold is a build week
  const w8 = planOf(runs, 8);
  assert.equal(w8.cutbackOwed, true);
  assert.equal(w8.buildWeeks, 2);
  // Week 10 (Mon 11-16) is the next calendar slot: hold + 2 builds before it, so the cutback is back (it used to be lost: a hold reset the count).
  const w10 = planOf(runsFor([...kms, 29]), 10);
  assert.equal(w10.cutback != null, true);
  assert.equal(w10.cutbackOwed, false);
  assert.equal(w10.buildWeeks, 0);
});

test('a cutback run as planned is not owed, and a hold after a spike is a build week that owes nothing', () => {
  const kept = runsFor([15, 17, 19, 21, 23, 20, 25]);
  const w7 = planOf(kept, 7);
  assert.equal(w7.cutbackOwed, false);
  // A spike in week 5; the hold lands on the calendar's cutback week (week 6) after 3+ build weeks: it takes the cutback's place (the cut after the jump).
  const spike = runsFor([15, 17, 19, 21, 40, 22]);
  const w6 = planOf(spike, 6);
  assert.equal(w6.kind, 'hold');
  assert.equal(w6.hold?.skippedCutback, undefined);
  assert.equal(w6.cutbackOwed, false);
  assert.equal(w6.buildWeeks, 0);
  // A hold off the slot is one more build week.
  const early = runsFor([15, 17, 40, 22]);
  const w4 = planOf(early, 4);
  assert.equal(w4.kind, 'hold');
  assert.equal(w4.buildWeeks, 3);
});

test('a cutback is never planned for the last build week before the taper, owed or not', () => {
  // Half marathon on Sun 2026-11-29: Monday 11-16 is the last build week (the taper starts 11-16 + 7 = 11-23? taper 14 days out = Mon 11-16)... the week before the taper has no cutback.
  const race = { date: '2026-11-29', distanceKm: 21.1 };
  const runs = runsFor([15, 17, 19, 21, 23, 25, 25, 27, 29]);
  const p = enduranceWeekPlan({ runs, weekStart: monday(9), goalKm: 30, race, today: monday(9) });
  assert.equal(p.preTaper != null || p.kind === 'taper', true);
  assert.equal(p.cutback, null);
});

test('a taper week at last week\'s own volume HOLDS it ("hold ~22 km (76% of your ~29 km peak)"); one that cuts says "cut the volume" (23e P3-m)', () => {
  // A half on the Sunday of week 10: week 9 is the taper. Week 8 (the last build week) ran 22 km - the taper's own number - or 28 km.
  const race = { date: addDayKey(monday(10), 6), distanceKm: 21.1 };
  const taperOf = (lastBuild: number) => enduranceWeekPlan({ runs: runsFor([15, 17, 19, 21, 23, 25, 27, lastBuild]), weekStart: monday(9), goalKm: 30, race, today: monday(9), racePeakWeekKm: 29 });
  const hold = taperOf(22);
  assert.equal(hold.kind, 'taper');
  assert.equal(hold.targetKm, 22);
  assert.equal(hold.taperHold, true);
  assert.match(hold.purpose.replace(/ /g, '~'), /^Taper: hold ~22~km this week \(76% of your ~29~km peak\); /);
  assert.doesNotMatch(hold.purpose, /cut the volume/);
  const cut = taperOf(28);
  assert.equal(cut.taperHold, false);
  assert.match(cut.purpose.replace(/ /g, '~'), /^Taper: ~22~km this week, cut the volume; /);
});
