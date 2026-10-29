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

test('light week (22e, wave 23e): an ill runner is light from the Friday, when the rest of the week cannot fit - not on the Thursday, when his Thursday run is still ahead', () => {
  const fri = '2026-10-09';
  const card = computeGoalProgress(input(weeks(fri, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: fri }));
  assert.equal(card.verdict, 'holding');
  assert.equal(card.headline, 'Light week — 6 of 30 km so far');
  // ... but not on the Thursday (wave 23e): a runner who did exactly what the plan said on Tuesday has the same week so far on Thursday morning,
  // with Thursday's run still to come - he is never "behind" before it.
  const thu = '2026-10-08';
  const early = computeGoalProgress(input(weeks(thu, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: thu }));
  assert.doesNotMatch(early.headline, /^Light week/);
  // And not on the Wednesday either (too early to say).
  const wed = '2026-10-07';
  const earlier = computeGoalProgress(input(weeks(wed, [[[1, 6]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: wed }));
  assert.doesNotMatch(earlier.headline, /^Light week/);
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
  assert.equal(build.headline, 'Cutback week — 25 of ~20 km, ran as a normal week'); // (wave 23e: no guilt)
  // A cutback week of a runner at the goal (race build): 30 km of a ~24 km cutback week is "on track ... above the ~24 km cutback".
  const sun2 = '2026-11-22';
  const race = { date: '2027-01-31', distanceKm: 21.1 };
  const history = [wk(30), wk(30), wk(30), wk(30), wk(24), wk(28), wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)];
  const atGoal = computeGoalProgress(input(weeks(sun2, history), { todayKey: sun2, race, racePeakWeekKm: 30 }));
  assert.equal(atGoal.distance!.plan?.cutback, true);
  assert.equal(atGoal.distance!.stepTargetKm, 24);
  assert.equal(atGoal.headline, 'On track for the half — 30 km, your cutback ran as a normal week');
  assert.equal(atGoal.distance!.text, '30 of ~24 km running this week · goal 30 km');
  // Kept (24 km): no talk of the cutback in the headline.
  const kept = computeGoalProgress(input(weeks(sun2, [wk(24), ...history.slice(1)]), { todayKey: sun2, race, racePeakWeekKm: 30 }));
  assert.doesNotMatch(kept.headline, /above the/);
});

// ── P2.1: a skipped cutback is not rewarded ────────────────────────────────

test('the Monday after a skipped cutback holds at the week the cutback replaced - "Your cutback became a normal week" (22e, wave 23e: no guilt)', () => {
  const monday = '2026-10-26';
  const card = computeGoalProgress(input(weeks(monday, [[], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: monday }));
  assert.equal(card.verdict, 'holding');
  assert.equal(card.headline, 'Your cutback became a normal week — hold ~25 km this week');
  assert.equal(card.distance!.stepTargetKm, 25);
  assert.equal(card.distance!.plan?.kind, 'hold');
  assert.equal(card.distance!.plan?.skippedCutback, true);
  const info = card.reasons.find(r => r.kind === 'volume')!;
  assert.equal(info.text, "Last week's 25 km ran as a normal week, not the ~20 km cutback — your bar stays ~25 km");
  assert.equal(info.tone, 'neutral');
  assert.match(card.reasons.find(r => r.kind === 'plan')!.text, /^Your cutback became a normal week — fine\. Hold ~25 km this week, long run [\d.]+ km — an easier week before building again$/);
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

test('the remaining-km line says a NUMBER (wave 23e; it was "keep the rest to one short easy run" from a flat 70% of the target, next to a plan line that still said "long run 10 km")', () => {
  // A cutback week (~20 km, 2026-10-19, long run 10 km) read on its Thursday with 18.7 km in two 9 km runs: the long run is behind, 1.3 km are left.
  const thu = '2026-10-22';
  const card = computeGoalProgress(input(weeks(thu, [[[1, 9.4], [3, 9.3]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: thu }));
  assert.equal(card.distance!.plan?.cutback, true);
  assert.equal(card.distance!.text, '18.7 of ~20 km running this week · goal 30 km');
  assert.equal(card.reasons[0].text, "18.7 of ~20 km — this week's km are done; rest or an easy 20-min jog");
  assert.equal(card.reasons[0].tone, 'neutral');
  assert.equal(card.distance!.plan?.longRunKm, null);
  assert.equal(card.distance!.plan?.purpose, 'Cutback week: ~20 km this week, done — no long run (rest or a 20-min jog)');
  // 14 km in two 7 km runs with the 10 km long run still ahead would be 24 km (110% of 20 is 22). On the Thursday two usual run days are left (Saturday and
  // Sunday), so the rest of the week is a TOTAL (wave 24e): "6 km left this week - one easy run of ~6 km, or two of ~3 km", no long run of its own.
  const trimmed = computeGoalProgress(input(weeks(thu, [[[1, 7], [3, 7]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: thu }));
  assert.equal(trimmed.reasons[0].text, '14 of ~20 km — 6 km left this week: one easy run of ~6 km, or two of ~3 km');
  assert.equal(trimmed.distance!.plan?.longRunKm, null);
  assert.equal(trimmed.distance!.plan?.purpose, 'Cutback week: ~20 km this week, 6 km left: one easy run of ~6 km, or two of ~3 km');
  assert.doesNotMatch(texts(trimmed), /one short easy run/);
  // Saturday evening, Saturday's run in: ONE usual run day is left, the day is named and the long run is the number ("keep Sunday's long run to ~6 km").
  const sat = '2026-10-24';
  const named = computeGoalProgress(input(weeks(sat, [[[1, 5], [3, 5], [5, 4]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sat }));
  assert.equal(named.reasons[0].text, "14 of ~20 km — keep Sunday's long run to ~6 km");
  assert.equal(named.distance!.plan?.longRunKm, 6);
  assert.equal(named.longRun?.nextKm, 6);
  assert.equal(named.distance!.plan?.purpose, 'Cutback week: ~20 km, long run 6 km — absorb the last three weeks');
  // With room for the full long run (12 + 10 = 22, exactly 110%) there is nothing to say.
  const fits = computeGoalProgress(input(weeks(thu, [[[1, 6], [3, 6]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: thu }));
  assert.ok(!fits.reasons.some(r => /one short easy run|km are done|long run to/.test(r.text)), texts(fits));
  assert.equal(fits.distance!.plan?.longRunTrim, undefined);
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

// ── P2.8: an imperial runner reads one set of numbers ──────────────────────

test('the long-run watch note speaks the goal\'s own numbers and the runner\'s unit: "keep long runs ~9 mi on 18.6 mi weeks, or add easy miles" (22e)', () => {
  const monday = '2026-10-12'; // the Monday after the oversized week: the one day the note is said
  const bigLong: Array<[number, number]> = [[1, 4], [3, 4], [5, 4], [6, 18]]; // 18 km (11.2 mi) in a 30 km week: 60%
  const history = [[], bigLong, wk(30), wk(30), wk(30)];
  const metric = computeGoalProgress(input(weeks(monday, history), { todayKey: monday, race: { date: '2026-11-22', distanceKm: 21.1 } }));
  assert.equal(metric.reasons.find(r => r.kind === 'long_run')!.text, '18 km was 60% of your week — keep long runs ~15 km on 30 km weeks, or add easy km');
  const imperial = computeGoalProgress(input(weeks(monday, history), { todayKey: monday, unitSystem: 'imperial', race: { date: '2026-11-22', distanceKm: 21.1 } }));
  assert.equal(imperial.reasons.find(r => r.kind === 'long_run')!.text, '11.2 mi was 60% of your week — keep long runs ~9 mi on 18.6 mi weeks, or add easy miles');
});

test('the race-eve conservative-start line speaks the runner\'s unit (22e)', () => {
  const race = { date: '2026-10-11', distanceKm: 21.1 };
  const eve = '2026-10-10'; // Saturday: a week 1.5x the plan or more adds "Start conservatively"
  const heavy = [[[1, 15], [3, 15], [5, 15]], wk(30), wk(30), wk(30)] as Array<Array<[number, number]>>;
  const metric = computeGoalProgress(input(weeks(eve, heavy), { todayKey: eve, race, racePeakWeekKm: 30 }));
  const imperial = computeGoalProgress(input(weeks(eve, heavy), { todayKey: eve, race, racePeakWeekKm: 30, unitSystem: 'imperial' }));
  assert.ok(metric.reasons.some(r => r.text === 'Start conservatively — the first few km easy'), texts(metric));
  assert.ok(imperial.reasons.some(r => r.text === 'Start conservatively — the first few miles easy'), texts(imperial));
});

// ── P2.9: the last day judges this week ────────────────────────────────────

test('the Sunday headline judges the week that is done, in the words the Monday review will use (22e)', () => {
  const sun = '2026-10-11'; // a build week, ~25 km (the step over 23)
  const history = (thisWeek: number) => weeks(sun, [wk(thisWeek), wk(23), wk(21), wk(19), wk(17), wk(15)]);
  const card = (km: number) => computeGoalProgress(input(history(km), { todayKey: sun }));
  assert.equal(card(25).headline, 'Week done — 25 of ~25 km, on plan');
  assert.equal(card(21).headline, 'Week done — 21 of ~25 km, a bit under the step');
  assert.equal(card(13).headline, 'Behind — 13 of ~25 km this week');
  assert.equal(card(13).verdict, 'behind');
  assert.equal(card(29).headline, 'Week done — 29 of ~25 km, above the step');
  // Saturday is still last week's read.
  const sat = computeGoalProgress(input(weeks('2026-10-10', [[[1, 5], [3, 5], [5, 5]], wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: '2026-10-10' }));
  assert.match(sat.headline, /last week/);
});

// ── P3: small copy honesty ─────────────────────────────────────────────────

test('day 0 reads "baseline week"; a break card carries the illness guard; the sessions line says "before your break" (22e)', () => {
  const day0 = computeGoalProgress(input([], { todayKey: '2026-10-05', start: { weightKg: null, startedAt: null, startedDay: '2026-10-05' } }));
  assert.equal(day0.distance!.text, '0 km so far · baseline week');
  // Two empty weeks after a run of 4-run weeks: on a break, with the guard, and the usual run count named.
  const sun = '2026-10-25';
  const card = computeGoalProgress(input(weeks(sun, [[], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun }));
  assert.match(card.headline, /^On a break/);
  assert.match(card.reasons.find(r => r.kind === 'plan')!.text, /If you were ill, wait until you've been symptom-free for 24–48 h first$/);
  assert.equal(card.reasons.find(r => r.kind === 'sessions')!.text, '4 runs a week before your break');
});

test('a race-week day with most of the budget used says to rest tomorrow and shake out the day before - not "keep the days before the race <= N km" (22e)', () => {
  const race = { date: '2026-10-11', distanceKm: 21.1 };
  const thu = '2026-10-08'; // 3 days out
  const card = computeGoalProgress(input(weeks(thu, [[[1, 6], [3, 6]], wk(30), wk(30), wk(30)]), { todayKey: thu, race, racePeakWeekKm: 30 }));
  const line = card.reasons.find(r => r.kind === 'race_phase')!.text;
  assert.equal(line, 'Race week: 12 of ~15 km — rest tomorrow, then a 15-min shakeout the day before the race');
});

// ── wave 22e follow-up: no two lines of one day disagree ───────────────────

test('the last day of a pre-taper week that ended short: headline, plan line and coach all say "taper starts tomorrow - no need to make up this week\'s km" (22e follow-up)', () => {
  const sun = '2026-10-11';
  const card = computeGoalProgress(input(weeks(sun, [[[1, 3.4], [3, 3.3], [5, 3.3], [6, 12]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race: HALF, racePeakWeekKm: 30 }));
  assert.equal(card.headline, 'Eased off early — 22 of 30 km; taper starts tomorrow');
  assert.equal(card.reasons.find(r => r.kind === 'plan')!.text, "Taper starts tomorrow — no need to make up this week's km");
  assert.equal(card.distance!.plan?.purpose, "Taper starts tomorrow — no need to make up this week's km");
  assert.equal(card.distance!.plan?.easingOff, true);
  // The runner's own unit.
  const imperial = computeGoalProgress(input(weeks(sun, [[[1, 3.4], [3, 3.3], [5, 3.3], [6, 12]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race: HALF, racePeakWeekKm: 30, unitSystem: 'imperial' }));
  assert.equal(imperial.reasons.find(r => r.kind === 'plan')!.text, "Taper starts tomorrow — no need to make up this week's miles");
  // A week that reached its target keeps its plan line (the goal still applied, and was met).
  const full = computeGoalProgress(input(weeks(sun, [wk(30), wk(30), wk(30), wk(30), wk(30)]), { todayKey: sun, race: HALF, racePeakWeekKm: 30 }));
  assert.doesNotMatch(full.reasons.find(r => r.kind === 'plan')!.text, /no need to make up/);
  // The day before (Saturday) is still "easing off", with the long run to keep.
  const sat = computeGoalProgress(input(weeks('2026-10-10', [[[1, 3], [3, 3]], wk(30), wk(30), wk(30), wk(30)]), { todayKey: '2026-10-10', race: HALF, racePeakWeekKm: 30 }));
  assert.match(sat.reasons.find(r => r.kind === 'plan')!.text, /^Easing off before your taper — fine; keep Sunday's long run/);
});

test('the Sunday of a hold week judges THIS week - "Week done - N of ~M km", not the jump two weeks back (22e follow-up)', () => {
  // The skipped cutback (25 km in a ~20 km week) makes 2026-10-26 a hold at 25; on its Sunday the week is read, not last week.
  const sun = '2026-11-01';
  const card = (km: number) => computeGoalProgress(input(weeks(sun, [wk(km), wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun }));
  assert.equal(card(25).distance!.plan?.kind, 'hold');
  assert.equal(card(25).headline, 'Week done — 25 of ~25 km, on plan');
  assert.match(card(19).headline, /^Week done — 19 of ~25 km/);
  // Monday still speaks of last week's skip.
  const monday = computeGoalProgress(input(weeks('2026-10-26', [[], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: '2026-10-26' }));
  assert.equal(monday.headline, 'Your cutback became a normal week — hold ~25 km this week');
});

test('on a break the distance text does not quote the stale week target: "0 km this week · on a break" (22e follow-up)', () => {
  const sun = '2026-10-25';
  const card = computeGoalProgress(input(weeks(sun, [[], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun }));
  assert.match(card.headline, /^On a break/);
  assert.equal(card.distance!.text, '0 km this week · on a break');
  assert.doesNotMatch(card.distance!.text, / of ~/);
  const imperial = computeGoalProgress(input(weeks(sun, [[], [], wk(25), wk(23), wk(21), wk(19), wk(17), wk(15)]), { todayKey: sun, unitSystem: 'imperial' }));
  assert.equal(imperial.distance!.text, '0 mi this week · on a break');
});

test('the sessions line names the usual run count whenever the window held a break, not a range like "1–4 runs a week" (22e follow-up)', () => {
  // This Tuesday: last week back with 3 runs, the week before ill (one Tuesday run, then nothing until Thursday of the next week), two full weeks.
  const back = computeGoalProgress(input(weeks(TODAY, [[], [[3, 4], [5, 4], [6, 7]], [[1, 6]], wk(30), wk(30)]), {}));
  assert.equal(back.reasons.find(r => r.kind === 'sessions')!.text, '4 runs a week before your break');
  // A plain quiet-ish stretch with no run-free week keeps its range.
  const steady = computeGoalProgress(input(weeks(TODAY, [[], [[1, 5], [3, 5], [5, 5], [6, 10]], [[1, 8], [5, 8]], wk(25), wk(25)]), {}));
  assert.match(steady.reasons.find(r => r.kind === 'sessions')!.text, /^2–4 runs a week|^2 or 4 runs a week/);
});
