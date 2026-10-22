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

test('a long run quoted next to the restart number is at most 40% of it: past two weeks off the restart is the lower band and so is the long run (23e P3-h)', () => {
  // Sunday, 14 days after the last run: "Two weeks off now - restart a bit lower"; the plan's own long run was worked out from the higher week number.
  const sun = '2026-10-25';
  const gp = computeGoalProgress(input(weeks(sun, [[], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun }));
  const restartKm = gp.distance!.plan!.restartKm ?? gp.distance!.plan!.targetKm!;
  const line = targetLine(coach(gp));
  const m = /restart at ~(\d+(?:\.\d+)?) km with easy runs; long run (\d+(?:\.\d+)?) km/.exec(line);
  assert.ok(m != null, line);
  assert.equal(Number(m[1]), restartKm);
  assert.ok(Number(m[2]) <= restartKm * 0.4 + 1e-9, `${m[2]} km is over 40% of the ${restartKm} km restart`);
  assert.equal(Number(m[2]) % 0.5, 0); // floored to the half km
  // A restart whose long run was already under 40% keeps it.
  const first = computeGoalProgress(input(weeks('2026-10-22', [[], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: '2026-10-22' }));
  const keep = /restart at ~(\d+(?:\.\d+)?) km with easy runs; long run (\d+(?:\.\d+)?) km/.exec(targetLine(coach(first)));
  if (keep) assert.ok(Number(keep[2]) <= Number(keep[1]) * 0.4 + 1e-9);
});

test('the coach never says "hold the goal" after a week under it: it says build back to it, and do not go past it (23e P3-c)', () => {
  const monday = '2026-04-20';
  const after28 = targetLine(coach(computeGoalProgress(input(weeks(monday, [[], wk(28), wk(40), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: monday }))));
  assert.match(after28, /^- This week's target: build back to the 30\.0 km\/week goal; long run [\d.]+ km.*last week was under it, so build back to the goal and do not go past it$/);
  assert.doesNotMatch(after28, /hold the|the runner is at the goal/);
  const after30 = targetLine(coach(computeGoalProgress(input(weeks(monday, [[], wk(30), wk(28), wk(25), wk(23), wk(21), wk(19), wk(17)]), { todayKey: monday }))));
  assert.match(after30, /^- This week's target: hold the 30\.0 km\/week goal; /);
});

test('"fine, said once" is said once: the coach has it on the Monday after a touch over and not from Tuesday (23e P3-a)', () => {
  const hist = [[], wk(18), wk(12), [], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];
  const line = (todayKey: string) => targetLine(coach(computeGoalProgress(input(weeks(todayKey, hist), { todayKey }))));
  assert.match(line('2026-10-26'), /last week ran a touch over its ceiling — fine, said once/);
  assert.match(line('2026-10-27'), /^- This week's target: build up to ~18\.0 km \(a ceiling for a careful comeback/);
  assert.doesNotMatch(line('2026-10-27'), /touch over|said once/);
});
