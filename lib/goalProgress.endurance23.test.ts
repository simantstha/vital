/**
 * Wave 23e - endurance card, round 5: the week's long run against what is left of the week (one number everywhere), a Sunday
 * morning that is not "Behind", and the Thursday that is not "Light week". (Its own file, like the wave 20 / 21 / 22 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { enduranceWeekPlan, longRunStepKm, restOfWeekPhrase, type PlanRun } from './enduranceProgression';
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

// The calendar's cutback week: Monday 2026-10-19 (~17 km = 75% of the 23 km just run; long run 7 km = 75% of the 9 km held), after four plain build weeks 15 -> 23 km.
const CUTBACK_HISTORY = [wk(23), wk(21), wk(19), wk(17), wk(15)];

test('the plan trims the long run to what is left when done + the unrun long run is over 110% of the week (and says so once)', () => {
  const thu = '2026-10-22';
  const runs = weeks(thu, [[[1, 6], [3, 6]], ...CUTBACK_HISTORY]);
  const plan = enduranceWeekPlan({ runs: toPlanRuns(runs), weekStart: '2026-10-19', goalKm: 30, today: thu });
  assert.equal(plan.cutback?.normalKm, 25);
  assert.equal(plan.targetKm, 17);
  // 12 km in + the 7 km long run is 19 km, past 110% of 17 (18.7). On the Thursday two usual run days are left (Saturday and Sunday), so what is left is a TOTAL (wave 24e):
  // 5 km, no long run of its own planned.
  assert.deepEqual(plan.longRunTrim, { fullKm: 7, doneKm: 12, remainingKm: 5, weekDone: false, today: false, daysLeft: 2, day: null, small: false, easyOk: false, afterRun: false, limitKm: 18.7 });
  assert.equal(plan.longRunKm, null);
  assert.equal(plan.longRunAhead, true);
  assert.equal(plan.purpose.replace(/\u00a0/g, ' '), 'Cutback week: ~17 km this week, 5 km left: one easy run of ~5 km, or two of ~2.5 km');
  assert.equal(plan.longRun.held, true); // a cutback week holds its long run by definition (the trim does not change that)
  // Saturday evening, Saturday's run in: ONE usual run day is left, so the day is named and the long run is cut to what is left, a number everywhere.
  const sat = '2026-10-24';
  const named = enduranceWeekPlan({ runs: toPlanRuns(weeks(sat, [[[1, 4], [3, 4], [5, 4]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: sat });
  assert.deepEqual(named.longRunTrim, { fullKm: 7, doneKm: 12, remainingKm: 5, weekDone: false, today: false, daysLeft: 1, day: 'Sunday', small: false, easyOk: false, afterRun: false, limitKm: 18.7, longestKm: 4 });
  assert.equal(named.longRunKm, 5);
  assert.equal(named.longRun.nextKm, 5);
  assert.equal(named.purpose.replace(/\u00a0/g, ' '), 'Cutback week: ~17 km, long run 5 km — absorb the last three weeks');
});

test('Sunday keeps Saturday\'s trim: after the Sunday run the plan line still says the long run Saturday said (5 km), not the full 7 (wave 24e)', () => {
  const sat = '2026-10-24';
  const sun = '2026-10-25';
  const satPlan = enduranceWeekPlan({ runs: toPlanRuns(weeks(sat, [[[1, 4], [3, 4], [5, 4]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: sat });
  const morning = enduranceWeekPlan({ runs: toPlanRuns(weeks(sun, [[[1, 4], [3, 4], [5, 4]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: sun });
  const evening = enduranceWeekPlan({ runs: toPlanRuns(weeks(sun, [[[1, 4], [3, 4], [5, 4], [6, 5]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: sun });
  for (const p of [satPlan, morning, evening]) {
    assert.equal(p.longRunKm, 5);
    assert.equal(p.purpose.replace(/\u00a0/g, ' '), 'Cutback week: ~17 km, long run 5 km — absorb the last three weeks');
  }
  assert.equal(satPlan.longRunTrim?.today, false);
  assert.equal(morning.longRunTrim?.today, true);
  assert.equal(morning.longRunTrim?.afterRun, false);
  assert.equal(evening.longRunTrim?.afterRun, true);
  // The long run Sunday's run was is still "the week's long run, run" (the card judges the week); the remaining-km line is the morning's only.
  assert.equal(evening.longRunAhead, false);
});

test('under 3 km (2 mi) left: no long run is planned, the week is done', () => {
  const thu = '2026-10-22';
  const plan = enduranceWeekPlan({ runs: toPlanRuns(weeks(thu, [[[1, 8], [3, 7.9]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: thu });
  // The Tuesday / Thursday runs are 8 km: the week's long run is behind, 1.1 km are left.
  assert.equal(plan.longRunAhead, false);
  assert.equal(plan.longRunTrim?.weekDone, true);
  assert.equal(plan.longRunKm, null);
  assert.equal(plan.purpose.replace(/\u00a0/g, ' '), 'Cutback week: ~17 km this week, done — no long run (rest or a 20-min jog)');
  // Friday of a week with the long run ahead and 15.6 km in: 15.6 + 7 > 18.7 and 1.4 km (under 10%) are left: skip the long run.
  const fri = '2026-10-23';
  const ahead = enduranceWeekPlan({ runs: toPlanRuns(weeks(fri, [[[1, 5.2], [3, 5.2], [4, 5.2]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: fri });
  assert.equal(ahead.longRunAhead, true);
  assert.deepEqual(ahead.longRunTrim, { fullKm: 7, doneKm: 15.6, remainingKm: 1.4, weekDone: true, today: false, daysLeft: 2, day: null, small: false, easyOk: false, afterRun: false, limitKm: 18.7 });
});

test('a week whose long run still fits is untouched (done + long run <= 110% of the week: 11 + 7 = 18 of 18.7)', () => {
  const thu = '2026-10-22';
  const plan = enduranceWeekPlan({ runs: toPlanRuns(weeks(thu, [[[1, 5.5], [3, 5.5]], ...CUTBACK_HISTORY])), weekStart: '2026-10-19', goalKm: 30, today: thu });
  assert.equal(plan.longRunTrim, null);
  assert.equal(plan.longRunKm, 7);
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
  // Week 2: Tue 3 / Thu 3 / Sat 3 = 9 of ~17, the 7 km long run ahead (6 km + the graded +1 km step; it was 8 km at a flat +2).
  const card = computeGoalProgress(input(weeks(sun, [[[1, 3], [3, 3], [5, 3]], wk(15)]), { todayKey: sun }));
  assert.doesNotMatch(card.headline, /Behind|Week done|a bit under|Holding steady/);
  assert.equal(card.distance!.plan?.longRunAhead, true);
  assert.match(card.reasons.find(r => r.kind === 'plan')!.text, /long run 7 km/);
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
  const card = computeGoalProgress(input(weeks(thu, [[[1, 6], [3, 6]], ...CUTBACK_HISTORY]), { todayKey: thu }));
  assert.equal(card.reasons[0].text, '12 of ~17 km — 5 km left this week: one easy run of ~5 km, or two of ~2.5 km');
  assert.equal(card.distance!.plan?.longRunKm, null);
  assert.equal(card.distance!.plan?.longRunTrim?.fullKm, 7);
  assert.equal(card.distance!.plan?.purpose, 'Cutback week: ~17 km this week, 5 km left: one easy run of ~5 km, or two of ~2.5 km');
  assert.equal(texts(card).includes('one short easy run'), false);
  // With ONE usual run day left (Saturday's run is in) the day is named and the long run is the number.
  const sat = '2026-10-24';
  const named = computeGoalProgress(input(weeks(sat, [[[1, 4], [3, 4], [5, 4]], ...CUTBACK_HISTORY]), { todayKey: sat }));
  assert.equal(named.reasons[0].text, "12 of ~17 km — keep Sunday's long run to ~5 km");
  assert.equal(named.distance!.plan?.longRunKm, 5);
  assert.equal(named.longRun?.nextKm, 5);
  // On the long-run day itself the line is about today. (Wave 26e round 8, P2-1: 4 km is less than a long run - after 5, 5 and 3 km runs it is "one short easy run", not "the longest run".)
  const sun = '2026-10-25';
  const today = computeGoalProgress(input(weeks(sun, [[[1, 5], [3, 5], [5, 3]], ...CUTBACK_HISTORY]), { todayKey: sun }));
  assert.match(today.reasons[0].text, /^13 of ~17 km — ~4 km left: one short easy run$/);
  assert.doesNotMatch(texts(today), /longest run/);
  // The cutback Saturday of the on-plan runner (round 8, P2-1): 5 + 5 + 4 km run, 3 km left - the sentence is "~3 km left", on the card, the plan line and the coach, never "longest run 3 km".
  const sat3 = computeGoalProgress(input(weeks(sat, [[[1, 5], [3, 5], [5, 4]], ...CUTBACK_HISTORY]), { todayKey: sat }));
  assert.equal(sat3.distance!.plan?.longRunTrim?.small, true);
  assert.equal(sat3.distance!.plan?.longRunKm, null);
  assert.equal(sat3.reasons[0].text, '14 of ~17 km — ~3 km left: one short easy run');
  assert.doesNotMatch([texts(sat3), sat3.headline, sat3.distance!.plan!.purpose].join(' | '), /longest run|long run/);
  // A Sunday run no longer than a run the week already holds is not "the long run" (a 9 km Tuesday, 6 km left): "keep Sunday's run to ~6 km".
  const trim = { remainingKm: 6, weekDone: false, today: false, daysLeft: 1, day: 'Sunday', small: false, easyOk: false };
  const phrase = (longestKm: number) => plainSpaces(restOfWeekPhrase({ ...trim, longestKm }, { unitsPerKm: 1, longRunKm: 6, longRunAhead: true, form: 'card' }));
  assert.equal(phrase(9), "keep Sunday's run to ~6 km");
  assert.equal(phrase(5), "keep Sunday's long run to ~6 km");
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
  // Wave 24e: when only the long run broke it (14 km = 56% of the week), the headline says THAT - "above the hold" is for a week that built past its number.
  const longBroke = computeGoalProgress(input(weeks(sun, [[[1, 4], [3, 4], [5, 3], [6, 14]], ...history]), { todayKey: sun }));
  assert.match(longBroke.headline, /^Week done — 25 of ~25 km, long run 14 km over the held 10 km$/);
  // Monday after the built-through hold week: last week is named for what it was.
  const monday = '2026-11-02';
  const next = computeGoalProgress(input(weeks(monday, [[], [[1, 5.6], [3, 5.6], [5, 5.6], [6, 11.2]], ...history]), { todayKey: monday }));
  assert.equal(next.distance!.plan?.kind, 'maintain');
});

test('the week after a cutback quotes its % against the last full week before the cutback, and says so - card headline (23e P2-4)', () => {
  // Cutback week Mon 2026-10-19 (17 km after 23), then 25 km. Monday 2026-11-02: last week's +47% against the cutback is +9% on the 23 km week.
  const mon = '2026-11-02';
  const card = computeGoalProgress(input(weeks(mon, [[], [[1, 5], [3, 5], [5, 5], [6, 10]], [[1, 3.4], [3, 3.4], [5, 3.4], [6, 6.8]], ...CUTBACK_HISTORY.slice(0, 4).map((_, i) => wk([23, 21, 19, 17][i]))]), { todayKey: mon }));
  assert.equal(card.headline, 'Building — 25 km last week (+9% on last full week, 23 km), on plan');
  assert.equal(card.distance!.plan?.stepAfterCutback, undefined); // this week's own step is from last week now
  // The cutback week itself keeps "−26%, as planned" against the week before it.
  const cutMon = '2026-10-26';
  const afterCut = computeGoalProgress(input(weeks(cutMon, [[], [[1, 3.4], [3, 3.4], [5, 3.4], [6, 6.8]], wk(23), wk(21), wk(19), wk(17)]), { todayKey: cutMon }));
  assert.match(afterCut.headline, /^Building — 17 km last week \(−26%, as planned\), your cutback week$/);
  assert.equal(afterCut.distance!.plan?.stepAfterCutback, true);
  assert.equal(afterCut.distance!.plan?.stepBaseKm, 23);
});

test('the sessions line quotes "before your break" only from weeks older than the run-free gap; post-gap weeks say "since you came back" (23e P3-f)', () => {
  const three: Array<[number, number]> = [[1, 5], [3, 5], [5, 5]];
  const sessions = (plan: Array<Array<[number, number]>>): string => computeGoalProgress(input(weeks(TODAY, plan))).reasons.find(r => r.kind === 'sessions')!.text;
  // Last three weeks: 3 runs, 3 runs, then nothing (the window ends in the gap): all the runs are AFTER it.
  assert.equal(sessions([[], three, three, [], wk(30)]), '3 runs a week since you came back');
  // The gap in the middle, four runs a week before it, three since: the number is the one from before the break.
  assert.equal(sessions([[], three, [], wk(30)]), '4 runs a week before your break');
  // Currently on a break (the newest weeks are the empty ones): still "before your break", from the older weeks.
  assert.equal(sessions([[], [], [], wk(30), wk(30)]), '4 runs a week before your break');
});

test('a peak date is promised only when the long run can get there: 10 -> 11.5 -> 13 -> (cutback week holds) -> 14.5 -> 15 km needs five Sundays before the peak-by day (23e P3-i, graded step)', () => {
  // A half: the peak is due 14 days before the race. Tuesday 2026-10-06, last long run 10 km (40% of 25 km). The graded step (+1.5 km from 10 km): Sundays 10-11 (11.5),
  // 10-18 (13), 10-25 (13: the calendar's cutback week 10-19 holds the long run), 11-01 (14.5), 11-08 (15). At a flat +2 km it was 12, 14, 15 on 10-11, 10-18, 10-25.
  const history = [[[1, 4]] as Array<[number, number]>, wk(25), wk(23), wk(21), wk(19)];
  const longRunLine = (raceDate: string): string => computeGoalProgress(input(weeks(TODAY, history), { race: { date: raceDate, distanceKm: 21.1 }, racePeakWeekKm: 30 })).reasons.find(r => r.kind === 'long_run')!.text;
  const sundays: Array<[string, number]> = [];
  for (let km = 10, sunday = '2026-10-11'; km < 15 - 1e-9; sunday = addDays(sunday, 7)) {
    if (sunday !== '2026-10-25') km = longRunStepKm(km, 15);
    sundays.push([sunday, km]);
  }
  assert.deepEqual(sundays, [['2026-10-11', 11.5], ['2026-10-18', 13], ['2026-10-25', 13], ['2026-11-01', 14.5], ['2026-11-08', 15]]);
  // Race 11-22: the peak is due 11-08 - the fifth Sunday, in time.
  assert.match(longRunLine('2026-11-22'), /^Long run 10 km · build to 15 km by (?:early |mid-|late )Nov/);
  // Race 11-15: the peak is due 11-01, a week before the 15 km arrives (14.5 km) - no date is promised.
  const late = longRunLine('2026-11-15');
  assert.match(late, /^Long run 10 km · peak target 15 km/);
  assert.doesNotMatch(late, /build to|by (early|mid|late)/);
});

test('the taper week\'s own long run is no yardstick: a 14 km peak run on the taper Sunday (the taper plans ~9) reads "Peak long run 14 km - done", not "longer than the 9 km plan" (23e P3-e)', () => {
  const race = { date: '2026-10-25', distanceKm: 21.1 }; // Monday 10-12 is the taper week (13 days out), Sunday 10-18 its last day; the peak target is 15 km
  const sun = '2026-10-18';
  const ignored = computeGoalProgress(input(weeks(sun, [[[1, 5], [3, 5], [5, 4], [6, 14]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race, racePeakWeekKm: 30 }));
  assert.equal(ignored.race?.phase, 'taper');
  const planned = ignored.distance!.plan!.longRunKm;
  assert.ok(planned != null && planned < 12, `the taper plans a short long run, got ${planned}`);
  const line = ignored.reasons.find(r => r.kind === 'long_run')!;
  assert.equal(line.text, 'Peak long run 14 km — done');
  assert.equal(line.tone, 'good');
  // Past the PEAK TARGET (15 km + 0.5) it is still a reproach, against that number.
  const big = computeGoalProgress(input(weeks(sun, [[[1, 5], [3, 5], [5, 4], [6, 18]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race, racePeakWeekKm: 30 }));
  assert.equal(big.reasons.find(r => r.kind === 'long_run')!.text, 'Long-run peak done — 18 km, longer than the 15 km plan');
});

test('"Hold 30 km" only after a week that ran the goal: after 28 km (or a cutback week) a maintain week is "Build to 30 km" (23e P3-c)', () => {
  // Weeks of 15..23 km, a 40 km spike, then the hold week ran 28 km: this Monday is at the 30 km goal, which he has run before - but not last week.
  const monday = '2026-04-20';
  const after28 = computeGoalProgress(input(weeks(monday, [[], wk(28), wk(40), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: monday }));
  const plan = after28.distance!.plan!;
  assert.equal(plan.kind, 'maintain');
  assert.equal(plan.goalReachedBefore, true);
  assert.equal(plan.lastAtGoal, false);
  assert.match(plan.purpose, /^Build to 30 km this week: long run [\d.]+ km, the rest easy$/);
  assert.match(after28.reasons.find(r => r.kind === 'plan')!.text, /^Build to 30 km this week: /);
  // After a week that ran the goal (30 km; 29.5 is the edge) it is "Hold".
  const after30 = computeGoalProgress(input(weeks(monday, [[], wk(30), wk(28), wk(25), wk(23), wk(21), wk(19), wk(17)]), { todayKey: monday }));
  assert.equal(after30.distance!.plan?.kind, 'maintain');
  assert.equal(after30.distance!.plan?.lastAtGoal, true);
  assert.match(after30.reasons.find(r => r.kind === 'plan')!.text, /^Hold 30 km this week: /);
  assert.equal(computeGoalProgress(input(weeks(monday, [[], wk(29.5), wk(28), wk(25), wk(23), wk(21), wk(19), wk(17)]), { todayKey: monday })).distance!.plan?.lastAtGoal, true);
});

test('"a touch over, fine" is said once: the Monday has it, from Tuesday the card is quiet; a spike keeps its words all week (23e P3-a)', () => {
  // Weeks 1-6 build (15..25 km), two weeks off, a restart week of 12 km, then the comeback week "up to ~15 km" ran at `lastKm`.
  const hist = (lastKm: number) => [[], wk(lastKm), wk(12), [], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];
  const day = (todayKey: string, lastKm: number) => computeGoalProgress(input(weeks(todayKey, hist(lastKm)), { todayKey }));
  const monday = day('2026-10-26', 18);
  assert.equal(monday.headline, 'Building — 18 of up to ~15 km last week, a touch over, fine');
  assert.equal(monday.distance!.plan?.overCapRead, 'touch');
  for (const tuesdayOn of ['2026-10-27', '2026-10-28']) {
    const card = day(tuesdayOn, 18);
    assert.equal(card.headline, 'Building — 18 km last week, back after your break');
    assert.equal(card.verdict, 'building');
    assert.equal(card.distance!.plan?.overCap, undefined);
    assert.equal(card.distance!.plan?.overCapRead, undefined);
    assert.equal(card.distance!.stepTargetKm, 18); // the ceiling still climbs from the ceiling, not the overshoot
    assert.doesNotMatch(texts(card), /touch over|on plan/);
  }
  // A spike (far over the ceiling) is a hold AT the ceiling, said all week.
  assert.equal(day('2026-10-27', 20).headline, 'Well over the ceiling last week — stay at ~15 km this week');
  assert.equal(day('2026-10-27', 20).distance!.plan?.overCapRead, 'well');
});
