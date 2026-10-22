/**
 * Wave 23e - the coach's goal lines follow the card, round 5: ONE number for the rest of the week. (Its own file, like the wave 20 / 21 / 22 ones.)
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
const CUTBACK_HISTORY = [wk(23), wk(21), wk(19), wk(17), wk(15)];

const coach = (gp: GoalProgress, units: 'metric' | 'imperial' = 'metric'): string => formatGoalProgressLines(gp, units).join('\n');
const targetLine = (text: string): string => text.split('\n').find(l => l.startsWith("- This week's target")) ?? '';

test('trimmed long run: the coach target line, the long-run line and the card say the same number', () => {
  const thu = '2026-10-22';
  const gp = computeGoalProgress(input(weeks(thu, [[[1, 7], [3, 7]], ...CUTBACK_HISTORY]), { todayKey: thu }));
  const text = coach(gp);
  assert.match(targetLine(text), /^- This week's target: a cutback week, ~20\.0 km — absorb the last three weeks; do not push past it — keep Sunday's long run to ~6 km so the week stays at ~20\.0 km$/);
  assert.match(text, /next long run ~6 km/);
  assert.doesNotMatch(text, /long run 10 km|one short easy run/);
});

test('week done: the coach says the km are done and to skip the long run, with no long run anywhere', () => {
  const fri = '2026-10-23';
  const gp = computeGoalProgress(input(weeks(fri, [[[1, 6], [3, 6], [4, 6]], ...CUTBACK_HISTORY]), { todayKey: fri }));
  const text = coach(gp);
  assert.match(targetLine(text), /the week's km are done: skip the long run \(rest or a 20-min jog\), no catch-up volume$/);
  assert.doesNotMatch(text, /next long run/);
  assert.doesNotMatch(text, /long run \d/);
});

test('the trimmed taper long run: the race-phase line and the card keep one number', () => {
  const race = { date: '2026-11-01', distanceKm: 21.1 }; // taper week of Monday 2026-10-19 (13 days out)
  const sat = '2026-10-24';
  const gp = computeGoalProgress(input(weeks(sat, [[[1, 7], [3, 7], [5, 4]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sat, race, racePeakWeekKm: 30 }));
  const text = coach(gp);
  const phase = text.split('\n').find(l => l.startsWith('- Race phase')) ?? '';
  const card = gp.reasons.map(r => r.text).join(' | ');
  assert.equal(gp.race?.phase, 'taper');
  // 18 of ~23 km (75% of the 30 km peak is 22.5): the taper long run (65% of the 12 km peak) is 8 km, past the 5 km left - cut to it.
  const left = gp.distance!.plan!.longRunKm;
  assert.notEqual(left, null);
  assert.match(phase, new RegExp(`long run ${left} km easy`));
  assert.match(card, new RegExp(`keep Sunday's run ≤ ${(gp.distance!.stepTargetKm - 18).toString().replace('.', '\\.')}`));
});

test('the week after a cutback: the coach quotes the step against the last full week and says so (23e P2-4)', () => {
  const mon = '2026-10-26';
  const gp = computeGoalProgress(input(weeks(mon, [[], [[1, 4], [3, 4], [5, 4], [6, 8]], wk(23), wk(21), wk(19), wk(17)]), { todayKey: mon }));
  assert.match(targetLine(coach(gp)), /^- This week's target: build to ~25\.0 km \(a \+9% step on your last full week \(23\.0 km\), back on the build after the cutback; long run [\d.]+ km\)/);
  // A week that did not follow a cutback keeps "on last week".
  const plain = computeGoalProgress(input(weeks('2026-10-12', [[], wk(21), wk(19), wk(17), wk(15)]), { todayKey: '2026-10-12' }));
  assert.match(targetLine(coach(plain)), /step on last week/);
});
