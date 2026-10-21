/**
 * Wave 20a — endurance card: race eve and race day, the "step is done" warning, the break, recovery copy, imperial
 * ceilings, the long-run cap note. (Kept in its own file so the older goalProgress tests stay untouched.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeGoalProgress as computeGoalProgressRaw, type GoalProgress, type GoalProgressInput } from './goalProgress';
import { plainSpaces } from './displayText';

const TODAY = '2026-10-06'; // Tuesday

/** Copy read with plain spaces (the NBSP is asserted in the older display-copy test). */
function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  return JSON.parse(plainSpaces(JSON.stringify(computeGoalProgressRaw(input)))) as GoalProgress;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type Run = { day: string; durationMin: number; distanceKm: number; type: string };

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

const run = (day: string, km: number, min = Math.round(km * 6)): Run => ({ day, durationMin: min, distanceKm: km, type: 'Running' });

/** `weeks[0]` is the week of `todayKey`; each entry is `[weekday (Mon = 0), km]`. */
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

const NOT_HUNDRED_PERCENT = (p: GoalProgress): string => p.reasons.map(r => r.text).join(' | ');

// Weekly goal 50 km, peak week 40 km: race week x0.5 = 20 km, recovery week 1 x0.4 = 16 km.
const RACE_GOAL = { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 };
const history = [run(addDays(TODAY, -3), 10), run(addDays(TODAY, -9), 12), run(addDays(TODAY, -16), 9), run(addDays(TODAY, -23), 10)];

test('race eve: the card is rest or a shakeout and carries no km of the week at all (wave 21e); a week at 1.5x the plan adds a neutral "start conservatively"', () => {
  const race = { date: addDays(TODAY, 1), distanceKm: 21.1 };
  // 24 km Monday + Tuesday against a 20 km race-week target: 1.2x, not heavy.
  const over = computeGoalProgress(input([run(TODAY, 14), run(addDays(TODAY, -1), 10), ...history], { target: RACE_GOAL, race, racePeakWeekKm: 40 }));
  assert.equal(over.race?.daysToGo, 1);
  assert.equal(over.headline, 'Race tomorrow — rest or a 15-min shakeout; lay out your kit');
  assert.equal(over.verdict, 'on_track');
  assert.doesNotMatch(over.headline, /over the plan/);
  assert.deepEqual(over.reasons.map(r => r.kind), ['race']);
  assert.doesNotMatch(NOT_HUNDRED_PERCENT(over), /\d+ of ~|over the plan|more than planned|keep Sunday|rest of the week|≤/);
  // The week's km are not on the card: no km in the stat, no bar to fill.
  assert.equal(over.distance!.thisWeekKm, null);
  assert.equal(over.distance!.text, 'Race tomorrow');
  // Under the plan it is the same headline and nothing else.
  const under = computeGoalProgress(input([run(addDays(TODAY, -1), 5), ...history], { target: RACE_GOAL, race, racePeakWeekKm: 40 }));
  assert.equal(under.headline, 'Race tomorrow — rest or a 15-min shakeout; lay out your kit');
  assert.deepEqual(under.reasons.map(r => r.kind), ['race']);
  // A week of 1.5x the plan or more (30 of 20 km): the neutral reason, never a scolding.
  const heavy = computeGoalProgress(input([run(TODAY, 14), run(addDays(TODAY, -1), 16), ...history], { target: RACE_GOAL, race, racePeakWeekKm: 40 }));
  assert.equal(heavy.headline, 'Race tomorrow — rest or a 15-min shakeout; lay out your kit');
  const note = heavy.reasons.find(r => r.kind === 'race_phase')!;
  assert.deepEqual({ text: note.text, tone: note.tone }, { text: 'Start conservatively — the first few km easy', tone: 'neutral' });
  assert.doesNotMatch(NOT_HUNDRED_PERCENT(heavy), /\d+ of ~|over the plan/);
});

test('race week: only the days BEFORE the race share what is left of the budget; tomorrow is a shakeout at most', () => {
  const day = (daysToGo: number, km: number[]) => computeGoalProgress(input(
    [...km.map((k, i) => run(addDays(TODAY, -i), k)), ...history],
    { target: RACE_GOAL, race: { date: addDays(TODAY, daysToGo), distanceKm: 21.1 }, racePeakWeekKm: 40 },
  ));
  // Race Sunday 2026-10-11: 5 days out, 12 of 20 km run.
  const early = day(5, [6, 6]);
  assert.equal(early.reasons.find(r => r.kind === 'race_phase')!.text, 'Race week: 12 of ~20 km — keep the days before the race ≤ 8 km');
  // The day before the eve: tomorrow's run is a short shakeout, never the whole leftover.
  const friday = computeGoalProgress(input(
    [run('2026-10-09', 3), run('2026-10-08', 5), run('2026-10-07', 5), ...history],
    { todayKey: '2026-10-09', target: RACE_GOAL, race: { date: '2026-10-11', distanceKm: 21.1 }, racePeakWeekKm: 40 },
  ));
  assert.equal(friday.race?.daysToGo, 2);
  assert.equal(friday.reasons.find(r => r.kind === 'race_phase')!.text, "Race week: 13 of ~20 km — keep tomorrow's run ≤ 3 km");
  assert.doesNotMatch(NOT_HUNDRED_PERCENT(friday), /Sunday/);
});

test('race day: "start relaxed" before the race, and once it is run "is today" and the long-run line are dropped', () => {
  const race = { date: TODAY, distanceKm: 21.1 };
  const before = computeGoalProgress(input([run(addDays(TODAY, -2), 5), ...history], { target: RACE_GOAL, race, racePeakWeekKm: 40 }));
  assert.equal(before.headline, 'Race day — start relaxed');
  assert.equal(before.distance!.plan?.purpose, 'Race day: warm up easy and start relaxed');
  assert.ok(before.reasons.some(r => r.kind === 'race' && /is today/.test(r.text)));
  const done = computeGoalProgress(input([run(TODAY, 21.1, 121), run(addDays(TODAY, -2), 5), ...history], { target: RACE_GOAL, race, racePeakWeekKm: 40 }));
  assert.equal(done.headline, 'Half marathon done — 21.1 km in 2:01. Congratulations!');
  assert.deepEqual(done.reasons.map(r => r.text), ['Walk it off, eat and rest; easy running only from here']);
  assert.doesNotMatch(NOT_HUNDRED_PERCENT(done), /is today|Peak long run/);
});

test('recovery: "Set your next goal" is for week 1 only, and never offers a weekly distance target the runner has', () => {
  const at = (daysSince: number, over: Partial<GoalProgressInput> = {}) => computeGoalProgress(input(
    [run(addDays(TODAY, -daysSince - 1), 21.1, 121), ...history],
    { race: { date: addDays(TODAY, -daysSince), distanceKm: 21.1 }, racePeakWeekKm: 40, ...over },
  ));
  const week1 = at(3);
  assert.equal(week1.race?.phase, 'recovery');
  assert.equal(week1.reasons.find(r => r.kind === 'next_step')?.text, 'Set your next goal: a new race or maintenance');
  assert.equal(at(9).reasons.some(r => r.kind === 'next_step'), false);
  // Without a weekly distance target the distance goal is one of the options, in week 1 only.
  const noTarget = at(3, { target: { weightKg: null, date: null, weeklySessions: 3, weeklyDistanceKm: null } });
  const text = noTarget.reasons.find(r => r.kind === 'next_step')?.text;
  assert.ok(text === undefined || text === 'Set your next goal: a new race, a weekly distance target, or maintenance');
  assert.equal(at(10, { target: { weightKg: null, date: null, weeklySessions: 3, weeklyDistanceKm: null } }).reasons.some(r => r.kind === 'next_step'), false);
});

test('build week: once the step is run the card warns while a day is left (a watch reason, not a spike); Sunday talks about next week', () => {
  const lastWeeks = [wk(23), wk(21), wk(19), wk(17), wk(15)];
  const saturday = '2026-10-10';
  // 28 km by Saturday against a 25 km step, a long run still to come.
  const sat = computeGoalProgress(input(weeks(saturday, [[[1, 9.4], [3, 9.3], [5, 9.3]], ...lastWeeks]), { todayKey: saturday }));
  assert.equal(sat.distance!.plan?.kind, 'build');
  assert.equal(sat.verdict, 'building');
  assert.match(sat.headline, /^Building — 23 km last week/);
  assert.deepEqual(sat.reasons[0], { kind: 'volume', text: "28 of ~25 km — the week's step is done; keep Sunday easy and short", tone: 'watch' });
  // Mid-week it is "the rest of the week".
  const thu = computeGoalProgress(input(weeks('2026-10-08', [[[0, 14], [1, 14]], ...lastWeeks]), { todayKey: '2026-10-08' }));
  assert.match(thu.reasons[0].text, /^28 of ~25 km — the week's step is done; keep the rest of the week easy and short$/);
  // Under the step: no warning.
  const under = computeGoalProgress(input(weeks(saturday, [[[1, 9], [3, 9], [5, 5]], ...lastWeeks]), { todayKey: saturday }));
  assert.equal(under.reasons.some(r => /step is done/.test(r.text)), false);
  // The jump itself (40 km) is the spike verdict; on Sunday the advice is about tomorrow, not "the rest of the week".
  const sunday = '2026-10-11';
  const spike = computeGoalProgress(input(weeks(sunday, [[[1, 9.4], [3, 9.3], [5, 9.3], [6, 12]], ...lastWeeks]), { todayKey: sunday }));
  assert.equal(spike.verdict, 'holding');
  assert.match(spike.headline, /^Over the safe step — 40 of ~25 km\. Hold ~28 km next week$/);
  assert.match(spike.reasons[0].text, /injury risk — keep tomorrow's run easy and hold next week's step$/);
  assert.doesNotMatch(spike.reasons[0].text, /rest of the week/);
  // A maintain week that reached its goal says "goal".
  const maintain = computeGoalProgress(input(weeks(saturday, [[[1, 10], [3, 10], [5, 10]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: saturday }));
  assert.equal(maintain.distance!.plan?.kind, 'maintain');
  assert.equal(maintain.reasons[0].text, "30 of 30 km — the week's goal is done; keep Sunday easy and short");
});

test('a break is 7 days, not 5: the target does not drop mid-week, and the card says it once the 7th day is reached', () => {
  const lastWeeks = [wk(23), wk(21), wk(19), wk(17)];
  const at = (todayKey: string) => computeGoalProgress(input(weeks(todayKey, [[], ...lastWeeks]), { todayKey }));
  // Last run was Sunday 2026-10-04; Mon..Fri of the week there is nothing yet.
  const friday = at('2026-10-09');
  assert.equal(friday.distance!.plan?.kind, 'build');
  assert.equal(friday.distance!.stepTargetKm, 25);
  // Wave 21e: five days with no run in the week is a light week - holding, never "Building" toward the step (the target itself stands).
  assert.equal(friday.headline, 'Light week — 0 of ~25 km so far');
  assert.equal(friday.verdict, 'holding');
  const sunday = at('2026-10-11');
  assert.match(sunday.headline, /^On a break — 7 days since your last run\. Restart at ~\d+ km\.$/);
  assert.equal(sunday.verdict, 'building');
  // From 8 days the restart is ~75% of the median (the pre-break weeks 23, 21, 19, 17 -> median 20), then 55% after 14 days.
  const week2 = computeGoalProgress(input(weeks('2026-10-12', [[], [], ...lastWeeks]), { todayKey: '2026-10-12' }));
  assert.equal(week2.distance!.plan?.kind, 'restart');
  assert.equal(week2.distance!.stepTargetKm, 15);
  assert.match(week2.reasons.find(r => r.kind === 'plan')!.text, /^Restart at ~15 km with easy runs, then build back toward your usual ~20 km$/);
  const week3 = computeGoalProgress(input(weeks('2026-10-19', [[], [], [], ...lastWeeks]), { todayKey: '2026-10-19' }));
  assert.equal(week3.distance!.stepTargetKm, 11);
});

test('comeback: the weeks after a restart climb toward the pre-break median (card target and plan agree)', () => {
  const lastWeeks = [wk(23), wk(21), wk(19), wk(17)];
  // Two empty weeks, a restart week of 11 km, and now Monday of the week after.
  const monday = '2026-11-02';
  const plan = weeks(monday, [[], [[1, 3], [3, 3], [5, 5]], [], [], ...lastWeeks]);
  const p = computeGoalProgress(input(plan, { todayKey: monday }));
  assert.equal(p.distance!.plan?.kind, 'build');
  // 80% of the 20 km pre-break median (the zero weeks count) is 16 km, capped (wave 21e) at 1.25x the 11 km just run: 13 km,
  // worded as a ceiling ("up to ~13 km"); not the 12 km plain step over 11.
  assert.equal(p.distance!.stepTargetKm, 13);
  assert.equal(p.distance!.plan?.upTo, true);
  assert.match(p.distance!.text, /^0 of up to ~13 km running this week · goal 30 km$/);
  assert.equal(p.distance!.plan?.comebackKm, 20);
  assert.match(p.distance!.plan!.purpose, /back toward your usual ~20 km$/);
});

test('imperial: a recovery week just over its ceiling reads "right at" it, never "7.5 of up to 7 mi"', () => {
  // Race Sunday 2026-10-04; recovery week 1 is Mon 10-05 .. Sun 10-11; peak week 28 km -> ceiling 11.2 km = 6.96 mi, rounded UP to 7 mi
  // (wave 21e: km and mi ceilings agree, and the ceiling stated on Monday is the one said on Saturday).
  const todayKey = '2026-10-10';
  const p = computeGoalProgressRaw(input([run('2026-10-06', 4), run('2026-10-08', 4), run('2026-10-09', 4), run('2026-10-04', 21.1, 121), ...history], {
    todayKey, unitSystem: 'imperial', race: { date: '2026-10-04', distanceKm: 21.1 }, racePeakWeekKm: 28,
  }));
  assert.equal(p.race?.phase, 'recovery');
  const text = plainSpaces(p.distance!.text);
  assert.equal(text, '7.5 mi so far · right at your ~7 mi ceiling (recovery)');
  assert.ok(!/7\.5 of up to 7 mi/.test(text));
  assert.equal(plainSpaces(p.reasons.find(r => r.kind === 'race_phase')!.text), 'Recovery: 7.5 mi — right at your ~7 mi ceiling; easy from here');
  // Earlier in the week the same ceiling was stated: "up to 7 mi".
  const monday = computeGoalProgressRaw(input([run('2026-10-04', 21.1, 121), ...history], {
    todayKey: '2026-10-05', unitSystem: 'imperial', race: { date: '2026-10-04', distanceKm: 21.1 }, racePeakWeekKm: 28,
  }));
  assert.equal(plainSpaces(monday.distance!.text), '0 of up to 7 mi running this week (recovery)');
  // The ceiling itself is a multiple of half a mile.
  const miles = p.distance!.stepTargetKm / 1.609344;
  assert.ok(Math.abs(miles * 2 - Math.round(miles * 2)) < 0.05, `${miles}`);
});

test('long run: a peak the weekly goal cannot carry is "what fits", the race peak is named once, and the lines use one rounding', () => {
  const race = { date: addDays(TODAY, 84), distanceKm: 21.1 };
  const runs = weeks(TODAY, [[[0, 5]], [[1, 5], [3, 5], [5, 5], [6, 10]], wk(18), wk(17), wk(15)]);
  const p = computeGoalProgress(input(runs, { race }));
  assert.equal(p.longRun?.targetPeakKm, 15);
  assert.equal(p.longRun?.raceTargetKm, 18);
  assert.match(p.reasons.find(r => r.kind === 'long_run')!.text, /^Long run 10 km · build to 15 km by [a-z-]+ ?[A-Za-z]{3}\. Your 30 km weeks fit a 15 km long run; for an 18 km peak, raise the goal to ~36 km$/);
  // The plan's own long run never passes the peak that fits.
  assert.ok((p.distance!.plan!.longRunKm ?? 0) <= 15);
  // A goal that carries it names no cap.
  const big = computeGoalProgress(input(runs, { race, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 40 } }));
  assert.equal(big.longRun?.targetPeakKm, 18);
  assert.equal(big.longRun?.raceTargetKm, undefined);
  // Imperial: the peak reached and the peak target are the same 11 mi (18 km is 11.18 mi: never "11.2" beside "11").
  // (Last week's 17.9 km long run is 54% of a 32.9 km week; in a smaller week it would be its own watch note, see the wave 21e tests.)
  // (A peak that kept to the plan - long runs 13, 15, 16.5, then 17.9 km, each week under half of its week - is praised; wave 22e.)
  const wkLong = (long: number): Array<[number, number]> => [[1, 7], [3, 7], [5, 7], [6, long]];
  const reached = computeGoalProgress(input(weeks(TODAY, [[[0, 5]], wkLong(17.9), wkLong(16.5), wkLong(15), wkLong(13)]), {
    race, unitSystem: 'imperial', target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
  }));
  assert.equal(reached.distance!.plan?.kind, 'build');
  assert.equal(reached.reasons.find(r => r.kind === 'long_run')?.text, 'Long run peak 11 mi — on target');
});

test('d0: no "No training sessions logged" watch line on the day the goal is set (endurance only)', () => {
  const p = computeGoalProgress(input([], { start: { weightKg: null, startedAt: null, startedDay: TODAY } }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.reasons.some(r => r.kind === 'sessions'), false);
  // A day later it is a fair thing to say.
  const next = computeGoalProgress(input([], { start: { weightKg: null, startedAt: null, startedDay: addDays(TODAY, -1) } }));
  assert.equal(next.reasons.some(r => r.kind === 'sessions' && /No training sessions logged/.test(r.text)), true);
});
