/**
 * Wave 22e - the coach's goal lines follow the card, round 4. (Its own file, like the wave 20 / 21 ones.)
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

test('pre-taper week (22e): the coach hears "easing off is fine", not "light week" and not "hold the goal"', () => {
  const sat = '2026-10-10';
  const gp = computeGoalProgress(input(weeks(sat, [[[1, 3], [3, 3]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sat, race: { date: '2026-10-25', distanceKm: 21.1 }, racePeakWeekKm: 30 }));
  const line = targetLine(coach(gp));
  assert.match(line, /^- This week's target: easing off before your taper — fine; keep Sunday's long run ~\d+(\.5)?–\d+(\.5)? km easy; no catch-up volume, and do not call the week behind$/);
  assert.doesNotMatch(coach(gp), /light week|Hold 30|hold the 30/i);
});

test('comeback ceiling (22e): a touch over is "fine, said once"; far over is a hold AT the ceiling - never "hold here, up to" a higher number', () => {
  const monday = '2026-10-26';
  const hist = (lastKm: number) => [[], wk(lastKm), wk(12), [], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];
  const lines = (lastKm: number) => coach(computeGoalProgress(input(weeks(monday, hist(lastKm)), { todayKey: monday })));
  const touch = targetLine(lines(18));
  assert.match(touch, /^- This week's target: build up to ~18\.0 km \(last week ran a touch over its ceiling — fine, said once; the new ceiling climbs from the old one, not from the overshoot/);
  assert.doesNotMatch(touch, /hold here/i);
  const well = targetLine(lines(20));
  assert.match(well, /^- This week's target: stay at ~15\.0 km — last week was well over its comeback ceiling \(a spike\); do not build on the jump/);
});
