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

test('skipped cutback (22e, wave 23e: no guilt): the coach is told to hold at the week the cutback replaced, as an easier week, without scolding', () => {
  const monday = '2026-10-26';
  const gp = computeGoalProgress(input(weeks(monday, [[], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: monday }));
  assert.match(targetLine(coach(gp)), /^- This week's target: hold ~25\.0 km — last week's cutback ran as a normal week \(fine, not a failure\); do not build 10% on it, and do not scold/);
});

test('cutback coach line (22e): a long run the lowered week cannot carry is "eased to N km (eased for the cutback)", not "held"', () => {
  const monday = '2026-10-19'; // the calendar's cutback week: ~17 km after 15 .. 23
  // The last long run was 14 km (75% of it is 10.5 km, but the 17 km cutback carries 8.5 km at most: half the week).
  const hist = [[], [[1, 5], [3, 5], [5, 5], [6, 14]], wk(21), wk(19), wk(17), wk(15)] as Array<Array<[number, number]>>;
  const eased = targetLine(coach(computeGoalProgress(input(weeks(monday, hist), { todayKey: monday }))));
  assert.match(eased, /^- This week's target: a cutback week, ~17\.0 km; long run eased to 8\.5 km \(eased for the cutback\)/);
  assert.doesNotMatch(eased, /held/);
});

test('last day of a pre-taper week that ended short (22e follow-up): the coach target line is the card\'s plan line, not "hold the 30 km goal"', () => {
  const sun = '2026-10-11';
  const gp = computeGoalProgress(input(weeks(sun, [[[1, 3.4], [3, 3.3], [5, 3.3], [6, 12]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race: { date: '2026-10-25', distanceKm: 21.1 }, racePeakWeekKm: 30 }));
  const line = targetLine(coach(gp));
  assert.equal(line, "- This week's target: taper starts tomorrow — no need to make up this week's km; no catch-up volume, and do not call the week behind");
  assert.doesNotMatch(coach(gp), /Hold 30|hold the 30|do not add volume/i);
  const gpMi = computeGoalProgress(input(weeks(sun, [[[1, 3.4], [3, 3.3], [5, 3.3], [6, 12]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race: { date: '2026-10-25', distanceKm: 21.1 }, racePeakWeekKm: 30, unitSystem: 'imperial' }));
  const imperial = targetLine(coach(gpMi, 'imperial'));
  assert.match(imperial, /no need to make up this week's miles/);
});

test('on a break the coach\'s "Now" line is not the stale week target (22e follow-up)', () => {
  const sun = '2026-10-25';
  const gp = computeGoalProgress(input(weeks(sun, [[], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun }));
  const lines = coach(gp).split('\n');
  assert.equal(lines.find(l => l.startsWith('- Now:')), '- Now: 0 km this week · on a break');
  assert.match(targetLine(coach(gp)), /^- This week's target: restart at ~\d+(\.\d)? km/);
});
