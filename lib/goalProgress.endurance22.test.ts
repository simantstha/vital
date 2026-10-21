/**
 * Wave 22e - endurance card, round 4: the light-week rule (pace by weekday, the rest of the week, never before a taper) and the
 * pre-taper "easing off" read. (Its own file, like the wave 20 / 21 ones.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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

// ── P1-B: the light week ────────────────────────────────────────────────────

test('light week (22e): a runner exactly on pace on a Friday - the long run is Sunday - is not "light"', () => {
  // Week 1: 15 km (Tue 3 / Thu 3 / Sat 3 / Sun 6). Week 2 by Friday: 6.7 km of ~17, the same pace.
  const fri = '2026-10-09';
  const card = computeGoalProgress(input(weeks(fri, [[[1, 3.4], [3, 3.3]], [[1, 3], [3, 3], [5, 3], [6, 6]]]), { todayKey: fri }));
  assert.doesNotMatch(card.headline, /^Light week/);
  assert.notEqual(card.distance!.plan?.lightWeek, true);
  assert.match(card.headline, /^Building — 15 km last week/);
});

test('light week (22e): an ill runner is light from the Thursday, when the rest of the week cannot fit', () => {
  const thu = '2026-10-08';
  const card = computeGoalProgress(input(weeks(thu, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: thu }));
  assert.equal(card.verdict, 'holding');
  assert.equal(card.headline, 'Light week — 6 of 30 km so far');
  // ... but not on the Wednesday (too early to say).
  const wed = '2026-10-07';
  const early = computeGoalProgress(input(weeks(wed, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: wed }));
  assert.doesNotMatch(early.headline, /^Light week/);
});

// ── P1-B: the week before a taper ───────────────────────────────────────────

const HALF = { date: '2026-10-25', distanceKm: 21.1 }; // Monday 10-05 is 20 days out (build); the next Monday is 13 days out (taper)

test('pre-taper week (22e): behind the target on a Saturday is "Easing off before your taper", never "Light week"', () => {
  const sat = '2026-10-10';
  // Four 30 km weeks (long run 12), then Tue 3 + Thu 3: 6 of 30 km, and 24 km cannot fit in Sunday.
  const card = computeGoalProgress(input(weeks(sat, [[[1, 3], [3, 3]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sat, race: HALF, racePeakWeekKm: 30 }));
  assert.equal(card.verdict, 'on_track');
  assert.equal(card.headline, 'Easing off before your taper — 6 of 30 km so far');
  const plan = card.reasons.find(r => r.kind === 'plan')!;
  assert.match(plan.text, /^Easing off before your taper — fine; keep Sunday's long run ~\d+(\.5)?–\d+(\.5)? km easy$/);
  assert.equal(card.distance!.plan?.easingOff, true);
  assert.equal(card.distance!.plan?.preTaper, 'taper');
  assert.equal(card.distance!.plan?.lightWeek, undefined);
  assert.doesNotMatch(texts(card), /Light week/i);
});

test('pre-taper week (22e): on the last day the headline judges the week - "Eased off early", taper starts tomorrow', () => {
  const sun = '2026-10-11';
  const card = computeGoalProgress(input(weeks(sun, [[[1, 3.4], [3, 3.3], [5, 3.3], [6, 12]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race: HALF, racePeakWeekKm: 30 }));
  assert.equal(card.verdict, 'on_track');
  assert.equal(card.headline, 'Eased off early — 22 of 30 km; taper starts tomorrow');
  // A week that reached its target says nothing of the kind.
  const full = computeGoalProgress(input(weeks(sun, [wk(30), wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race: HALF, racePeakWeekKm: 30 }));
  assert.doesNotMatch(full.headline, /Eased off|Easing off/);
});

// ── P1-C: the skipped cutback on the card ──────────────────────────────────

test('a cutback week that ran far past its lowered number says so on the card, in the on-track race headline too (22e)', () => {
  // Build weeks 15..25, then the calendar's cutback week of 2026-10-19 (~20 km), ended with 25 km: above it, under the spike line.
  const sun = '2026-10-25';
  const build = computeGoalProgress(input(weeks(sun, [wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun }));
  assert.equal(build.distance!.plan?.cutback, true);
  assert.equal(build.distance!.stepTargetKm, 20);
  assert.equal(build.headline, 'Cutback week — 25 of ~20 km, above the cutback');
  // A cutback week of a runner at the goal (race build): 30 km of a ~24 km cutback week is "on track ... above the ~24 km cutback".
  const sun2 = '2026-11-22';
  const race = { date: '2027-01-31', distanceKm: 21.1 };
  const history = [wk(30), wk(30), wk(30), wk(30), wk(24), wk(28), wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];
  const atGoal = computeGoalProgress(input(weeks(sun2, history), { todayKey: sun2, race, racePeakWeekKm: 30 }));
  assert.equal(atGoal.distance!.plan?.cutback, true);
  assert.equal(atGoal.distance!.stepTargetKm, 24);
  assert.equal(atGoal.headline, 'On track for the half — 30 km, above the ~24 km cutback');
  assert.equal(atGoal.distance!.text, '30 of ~24 km running this week · goal 30 km');
  // Kept (24 km): no talk of the cutback in the headline.
  const kept = computeGoalProgress(input(weeks(sun2, [wk(24), ...history.slice(1)]), { todayKey: sun2, race, racePeakWeekKm: 30 }));
  assert.doesNotMatch(kept.headline, /above the/);
});

// ── P2.1: a skipped cutback is not rewarded ────────────────────────────────

test('the Monday after a skipped cutback holds at the week the cutback replaced - "You skipped the cutback" (22e)', () => {
  const monday = '2026-10-26';
  const card = computeGoalProgress(input(weeks(monday, [[], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: monday }));
  assert.equal(card.verdict, 'holding');
  assert.equal(card.headline, 'You skipped the cutback — hold ~25 km this week');
  assert.equal(card.distance!.stepTargetKm, 25);
  assert.equal(card.distance!.plan?.kind, 'hold');
  assert.equal(card.distance!.plan?.skippedCutback, true);
  assert.match(card.reasons.find(r => r.kind === 'volume')!.text, /^Last week's 25 km was above the ~20 km cutback/);
  // A kept cutback builds on the week before it (23 -> 25), as before.
  const kept = computeGoalProgress(input(weeks(monday, [[], wk(20), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: monday }));
  assert.equal(kept.distance!.plan?.kind, 'build');
  assert.equal(kept.distance!.stepTargetKm, 25);
  assert.equal(kept.distance!.plan?.skippedCutback, undefined);
});
