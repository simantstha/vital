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

// ── P2.2: the restart number does not change overnight ─────────────────────

test('on a break the restart number is "if you restart tomorrow": Sunday quotes the number Monday will, and says why it dropped (22e)', () => {
  // Last run Sunday 2026-10-11: two empty weeks, now Sunday 10-25 (14 days off) and Monday 10-26 (15).
  const history = (todayKey: string) => weeks(todayKey, [[], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]);
  const sunday = computeGoalProgress(input(history('2026-10-25'), { todayKey: '2026-10-25' }));
  const monday = computeGoalProgress(input(weeks('2026-10-26', [[], [], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: '2026-10-26' }));
  const number = (headline: string): string => /Restart at ~(\d+) km/.exec(headline)![1];
  assert.match(sunday.headline, /^On a break — 14 days since your last run\. Restart at ~\d+ km\.$/);
  assert.equal(number(sunday.headline), number(monday.headline));
  assert.match(sunday.reasons.find(r => r.kind === 'plan')!.text, /^Two weeks off now — restart a bit lower, ~\d+ km, with easy runs/);
  // Saturday (13 days off, "restart tomorrow" is a 14-day gap) is still the higher band.
  const saturday = computeGoalProgress(input(history('2026-10-24'), { todayKey: '2026-10-24' }));
  assert.ok(Number(number(saturday.headline)) > Number(number(sunday.headline)), `${saturday.headline} / ${sunday.headline}`);
  assert.doesNotMatch(saturday.reasons.find(r => r.kind === 'plan')!.text, /Two weeks off/);
});

// ── P2.4: race day ──────────────────────────────────────────────────────────

test('race day shows the race, not the week: "Race done — 21.1 km", no "N of ~M km running this week" (22e)', () => {
  const race = { date: '2026-10-11', distanceKm: 21.1 }; // Sunday; Monday 10-05 is 6 days out (race week)
  const sunday = '2026-10-11';
  const runs = [...weeks(sunday, [[[1, 4], [3, 4], [5, 4]], wk(30), wk(30), wk(30)]), run(sunday, 21.1)];
  const card = computeGoalProgress(input(runs, { todayKey: sunday, race, racePeakWeekKm: 30 }));
  assert.equal(card.race?.daysToGo, 0);
  assert.equal(card.distance!.thisWeekKm, null);
  assert.equal(card.distance!.text, 'Race done — 21.1 km');
  assert.match(card.headline, /^Half marathon done — 21\.1 km/);
  // The morning of the race, before it is logged: no week figure either.
  const morning = computeGoalProgress(input(weeks(sunday, [[[1, 4], [3, 4], [5, 4]], wk(30), wk(30), wk(30)]), { todayKey: sunday, race, racePeakWeekKm: 30 }));
  assert.equal(morning.distance!.text, 'Race day');
  assert.equal(morning.distance!.thisWeekKm, null);
});

// ── P2.6: a warning before the spike ───────────────────────────────────────

test('from 70% of the week\'s target, not yet run, the card says "keep the rest to one short easy run" (22e)', () => {
  // A cutback week (~20 km, 2026-10-19) read on its Thursday with 18.7 km in: the next two runs are where it becomes a 25 km week.
  const thu = '2026-10-22';
  const card = computeGoalProgress(input(weeks(thu, [[[1, 9.4], [3, 9.3]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: thu }));
  assert.equal(card.distance!.plan?.cutback, true);
  assert.equal(card.distance!.text, '18.7 of ~20 km running this week · goal 30 km');
  assert.equal(card.reasons[0].text, '18.7 of ~20 km — keep the rest to one short easy run');
  assert.equal(card.reasons[0].tone, 'neutral');
  // Below 70% there is nothing to say yet; at the target the existing "step is done" warning speaks.
  const early = computeGoalProgress(input(weeks(thu, [[[1, 6], [3, 6]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: thu }));
  assert.ok(!early.reasons.some(r => /one short easy run|step is done|goal is done/.test(r.text)), texts(early));
  const done = computeGoalProgress(input(weeks(thu, [[[1, 10], [3, 10.5]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: thu }));
  assert.match(done.reasons[0].text, /the week's step is done/);
});

// ── P2.7: "peak reached" is not praise for a long run that broke the plan ──

test('a peak long run that broke the plan is not praised: neutral "longer than the 15 km plan", in the taper too (22e)', () => {
  const race = { date: '2026-10-25', distanceKm: 21.1 }; // Monday 10-12 is the taper (13 days out)
  const big = [[1, 4], [3, 4], [5, 4], [6, 18]] as Array<[number, number]>; // 18 km of 30: 60%, the plan said 15 km
  const taper = computeGoalProgress(input(weeks('2026-10-13', [[[1, 5]], big, wk(30), wk(30), wk(30)]), { todayKey: '2026-10-13', race, racePeakWeekKm: 30 }));
  const lr = taper.reasons.find(r => r.kind === 'long_run')!;
  assert.equal(lr.text, 'Long-run peak done — 18 km, longer than the 15 km plan');
  assert.equal(lr.tone, 'neutral');
  assert.equal(taper.longRun?.overPlan, true);
  // A peak that kept to the plan is still praised.
  const fine = computeGoalProgress(input(weeks('2026-10-13', [[[1, 5]], [[1, 5], [3, 5], [5, 5], [6, 14]], wk(30), wk(30), wk(30)]), { todayKey: '2026-10-13', race, racePeakWeekKm: 30 }));
  assert.equal(fine.reasons.find(r => r.kind === 'long_run')!.text, 'Peak long run 14 km — done');
  assert.equal(fine.longRun?.overPlan, undefined);
});
