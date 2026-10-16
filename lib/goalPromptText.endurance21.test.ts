/**
 * Wave 21e - the coach's goal lines follow the card: light week, cutback, strides, "up to" comeback ceilings, a held long
 * run that is not "growing", the long-run cap note's cadence, a race eve with no km. (Its own file, like the wave 20 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeGoalProgress, type GoalProgress, type GoalProgressInput } from './goalProgress';
import { formatGoalProgressLines } from './goalPromptText';

const TODAY = '2026-10-06'; // Tuesday

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

const coach = (gp: GoalProgress, units: 'metric' | 'imperial' = 'metric'): string => formatGoalProgressLines(gp, units).join('\n');
const targetLine = (text: string): string => text.split('\n').find(l => l.startsWith("- This week's target")) ?? '';

test('light week: the coach is told not to make it up and where the long run stops - never "hold the goal, add nothing" or on track', () => {
  const sat = '2026-10-10';
  const gp = computeGoalProgress(input(weeks(sat, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sat, race: { date: '2026-12-20', distanceKm: 21.1 } }));
  const text = coach(gp);
  assert.match(targetLine(text), /^- This week's target: light week — don't make it up; long run ≤ ~8 km easy, or skip it if you were ill; no catch-up volume, and do not call the week behind$/);
  assert.match(text, /Verdict: holding — "Light week — 6 of 30 km so far"/);
  assert.doesNotMatch(text, /On track for the half|the runner is at the goal/);
  assert.match(text, /next long run ~8 km/);
});

test('cutback and strides: the coach line says so, with the same numbers as the card', () => {
  const todayKey = '2026-10-20'; // the calendar's cutback week
  const gp = computeGoalProgress(input(weeks(todayKey, [[], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey }));
  assert.match(targetLine(coach(gp)), /^- This week's target: a cutback week, ~20\.0 km; long run [\d.]+ km held — absorb the last three weeks; do not push past it$/);
  assert.equal(gp.distance!.stepTargetKm, 20);
  // Strides in the last 2 build weeks before the taper.
  const race = { date: '2026-11-08', distanceKm: 21.1 };
  const strides = computeGoalProgress(input(weeks('2026-10-13', [[], wk(30), wk(30), wk(30), wk(30)]), { todayKey: '2026-10-13', race }));
  assert.match(targetLine(coach(strides)), /; plus 4–6 strides after one easy run$/);
});

test('a comeback target above the plain step is a ceiling: "build up to", not "build to"', () => {
  const monday = '2026-11-02';
  const gp = computeGoalProgress(input(weeks(monday, [[], [[1, 3], [3, 3], [5, 5]], [], [], [[1, 4.6], [3, 4.6], [5, 4.6], [6, 9.2]], wk(21), wk(19), wk(17)]), { todayKey: monday }));
  const line = targetLine(coach(gp));
  assert.equal(gp.distance!.plan?.upTo, true);
  assert.match(line, /^- This week's target: build up to ~\d+\.0 km \(a ceiling for a careful comeback/);
  assert.doesNotMatch(line, /% step on last week/);
});

test('a held long run is not "keeps growing ~2 km a week toward its peak"', () => {
  // Last week's long run jumped (14 km where 10 was planned): this week holds it. The runner is at the goal.
  const mondayKey = '2026-10-12';
  const jump: Array<[number, number]> = [[1, 5], [3, 5], [5, 6], [6, 14]];
  const gp = computeGoalProgress(input(weeks(mondayKey, [[], jump, [[1, 7], [3, 7], [5, 7], [6, 9]], [[1, 6], [3, 6], [5, 6], [6, 8]], [[1, 6], [3, 6], [5, 6], [6, 7]], [[1, 5], [3, 5], [5, 5], [6, 6]]]), {
    todayKey: mondayKey, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 }, race: { date: '2026-12-20', distanceKm: 21.1 },
  }));
  assert.equal(gp.distance!.plan?.longRunHeld, true);
  const line = targetLine(coach(gp));
  assert.doesNotMatch(line, /keeps growing/);
  // A long run that does grow still says so.
  const growing = computeGoalProgress(input(weeks('2026-10-13', [[], wk(30), wk(30), wk(30), wk(30)]), { todayKey: '2026-10-13', race: { date: '2026-12-20', distanceKm: 21.1 } }));
  assert.equal(growing.distance!.plan?.kind, 'maintain');
  assert.equal(growing.distance!.plan?.longRunHeld, undefined);
  assert.match(targetLine(coach(growing)), /keeps growing/);
});

test('the long-run cap note reaches the coach in the weeks the plan says it is due - not in a taper, race week or on race day', () => {
  const race = { date: '2026-11-22', distanceKm: 21.1 };
  const started = '2026-09-28';
  const lr = (todayKey: string) => computeGoalProgress(input(weeks(todayKey, [[], wk(30), wk(30), wk(30), wk(30)]), {
    todayKey, race, racePeakWeekKm: 30, start: { weightKg: null, startedAt: null, startedDay: started },
  }));
  const said = (gp: GoalProgress): boolean => /raise the goal to ~36 km/.test(coach(gp));
  assert.equal(said(lr('2026-09-29')), true); // the goal's first week has no long run yet: baseline
  const weeksInto = (n: number) => addDays(started, 7 * n + 1);
  assert.equal(said(lr(weeksInto(1))), false);
  assert.equal(said(lr(weeksInto(2))), false);
  assert.equal(said(lr(weeksInto(4))), true);
  // Taper (Mon 11-09 is 13 days out), race week, race day and the eve: never.
  for (const day of ['2026-11-10', '2026-11-17', '2026-11-21', '2026-11-22']) {
    const gp = lr(day);
    assert.equal(said(gp), false, day);
    assert.doesNotMatch(coach(gp), /fit a 15 km long run/, day);
  }
});

test('race eve: the coach line carries no km of the week, only the rest and the start-conservatively note when the week ran 1.5x the plan', () => {
  const race = { date: addDays(TODAY, 1), distanceKm: 21.1 };
  const history = [run(addDays(TODAY, -3), 10), run(addDays(TODAY, -9), 12), run(addDays(TODAY, -16), 9), run(addDays(TODAY, -23), 10)];
  const heavy = computeGoalProgress(input([run(TODAY, 14), run(addDays(TODAY, -1), 16), ...history], { target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 }, race, racePeakWeekKm: 40 }));
  const text = coach(heavy);
  assert.match(text, /Race phase: race tomorrow — rest or a 15-min shakeout; lay out your kit; no training advice, no volume talk, no remarks about this week's km/);
  assert.doesNotMatch(text, /- Now: .*\d+ of/);
  assert.doesNotMatch(text, /\d+ of ~?\d+/);
  assert.match(text, /Start conservatively — the first few km easy/);
});

test('coach lines keep plain spaces: the taper reps read "3×1 km" / "3×0.5 mi" with an ASCII space (no U+00A0 in the coach)', () => {
  const race = { date: '2026-10-18', distanceKm: 21.1 };
  for (const [unitSystem, units, rep] of [['metric', 'metric', '3×1 km'], ['imperial', 'imperial', '3×0.5 mi']] as const) {
    const gp = computeGoalProgress(input(weeks('2026-10-07', [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: '2026-10-07', race, racePeakWeekKm: 30, unitSystem }));
    const text = coach(gp, units);
    assert.ok(text.includes(`plus ${rep} at race pace midweek`), text);
    assert.equal(text.includes(' '), false);
  }
});
