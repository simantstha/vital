/**
 * Wave 25e - the endurance week plan, round 7 leftovers: a number the runner was given is kept (group 1), and the repetition / wording fixes (group 2).
 * The figures come from the timeline scenarios (lib/timeline/scenarios.ts), the same rows the persona dumps are made of. Every test here was written BEFORE the
 * rule it locks in (the timeline invariants of the "wave 25e" block fail without it).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { enduranceWeekPlan, type PlanRun } from './enduranceProgression';
import { runTimeline } from './timeline/engine';
import { buildScenario, type ScenarioName } from './timeline/scenarios';

const nbsp = (s: string): string => s.replace(/\u00a0/g, ' ');

/** The scenario's running rows as plan runs (the race run left in: the plan drops it itself). */
function runsOf(name: ScenarioName): PlanRun[] {
  return buildScenario(name).workouts
    .filter(w => w.type === 'Running' && w.distanceM)
    .map(w => ({ day: w.day, km: (w.distanceM as number) / 1000, durationMin: w.durationMin }));
}

function planOf(name: ScenarioName, weekStart: string, today: string) {
  const scn = buildScenario(name);
  return enduranceWeekPlan({
    runs: runsOf(name),
    weekStart,
    goalKm: scn.user.weeklyDistanceKm as number,
    race: scn.user.raceDate ? { date: scn.user.raceDate, distanceKm: scn.user.raceDistanceKm } : null,
    today,
    racePeakWeekKm: 30,
    goalStartDay: scn.user.goalStartedDay,
  });
}

const snap = (name: ScenarioName, idx: number) => {
  const s = runTimeline(name).find(x => x.idx === idx);
  assert.ok(s, `${name} day ${idx}`);
  return s;
};

// ── group 1 / item 1 ─────────────────────────────────────────────────────────

test('item 1: the cutback week of runner_on_plan quotes the 8 km Saturday gave on every later day, not the 10.5 km it started with', () => {
  // The week of May 4 (days 63-69): Monday's plan is a 10.5 km long run (75% of the 14 km held), Saturday trims it to 8 km ("keep Sunday's long run to ~8 km"), the runner runs 15 km on Sunday.
  assert.equal(planOf('runner_on_plan', '2026-05-04', '2026-05-04').longRun.planKm, 10.5);
  assert.equal(planOf('runner_on_plan', '2026-05-04', '2026-05-09').longRun.planKm, 8);
  assert.equal(planOf('runner_on_plan', '2026-05-04', '2026-05-10').longRun.planKm, 8);
  // Sunday: "longer than the 8 km plan" (it always was) ...
  assert.equal(planOf('runner_on_plan', '2026-05-04', '2026-05-10').longRun.peakPlan?.plannedKm, 8);
  // ... and on Monday and every day of the week after it the same 8 km, never the 10.5 km (day 70 read "longer than the 10.5 km plan").
  for (const today of ['2026-05-11', '2026-05-12', '2026-05-14', '2026-05-16']) {
    const p = planOf('runner_on_plan', '2026-05-11', today);
    assert.equal(p.longRun.peakPlan?.plannedKm, 8, today);
    assert.equal(p.longRun.peakPlan?.brokenKm, 8, today);
  }
  const monday = snap('runner_on_plan', 70).card?.reasons.find(r => r.kind === 'long_run');
  assert.equal(nbsp(monday?.text ?? ''), 'Long run peak 15 km — longer than the 8 km plan');
  const sunday = snap('runner_on_plan', 69).card?.reasons.find(r => r.kind === 'long_run');
  assert.equal(nbsp(sunday?.text ?? ''), 'Long run peak 15 km — longer than the 8 km plan');
});

test('item 1: the long-run JUMP detection still reads the plan the week started with (the figure the chain keeps), so the hold it asks for is unchanged', () => {
  // The cutback week ran its 15 km long run against an 8 km trim: 15 km is not a jump over the 14 km before it (+1), so Monday plans no hold - as before the fix.
  const monday = planOf('runner_on_plan', '2026-05-11', '2026-05-11');
  assert.equal(monday.longRunJump, null);
  assert.equal(monday.longRunKm, 15);
});

test('item 1: a past week with no trim quotes the plan it started with (nothing to forget)', () => {
  // Week of May 18 (days 77-83): the 17 km Sunday run against the held 15 km long run; Monday's quote of that week is 15 km on every day.
  for (const today of ['2026-05-25', '2026-05-28', '2026-05-30']) {
    assert.equal(planOf('runner_on_plan', '2026-05-25', today).longRun.peakPlan?.plannedKm, 15, today);
  }
});

// ── group 1 / item 2 ─────────────────────────────────────────────────────────

test('item 2: on a Sunday after the long run the coach\'s "next long run" is the coming week\'s, not the week that is over', () => {
  // Day 41 (Sun Apr 12): the 11 km long run is run; the week's trimmed figure was 6 km. Monday plans an 11 km long run (the week that is over planned 6 km after Saturday's trim).
  const d41 = snap('runner_on_plan', 41);
  assert.equal(d41.card?.longRun?.nextKm, snap('runner_on_plan', 42).card?.distance?.plan?.longRunKm);
  assert.match(nbsp(d41.coach?.find(l => l.startsWith('- Long run')) ?? ''), /next long run ~11 km/);
  // Day 69 (Sun May 10): 15 km run, Monday holds the 15 km long run - not "~8 km".
  assert.equal(snap('runner_on_plan', 69).card?.longRun?.nextKm, 15);
  // Before the long run is run (Saturday), "next long run" is still this week's figure.
  assert.equal(snap('runner_on_plan', 68).card?.longRun?.nextKm, 8);
});

test('item 2: the Sunday before race week has no "next long run" (race week plans none)', () => {
  const sunday = snap('runner_on_plan', 104);
  assert.equal(sunday.card?.longRun?.nextKm ?? null, null);
  assert.doesNotMatch(nbsp(sunday.coach?.find(l => l.startsWith('- Long run')) ?? ''), /next long run/);
});

// ── group 1 / item 3 ─────────────────────────────────────────────────────────

test('item 3: a Saturday restart spreads the km over the runner\'s usual run days left (Saturday and Sunday): 2 runs, cap ceil(5 / 2) = 3 km', () => {
  const sat = planOf('runner_no_race', '2026-04-20', '2026-04-25');
  assert.equal(sat.onBreak, true);
  assert.deepEqual(sat.restart?.midWeek, { fullKm: 17, daysLeft: 2, km: 5, longCapKm: 3, pending: true, runs: 2 });
  const card = snap('runner_no_race', 54).card?.reasons.find(r => r.kind === 'plan');
  assert.match(nbsp(card?.text ?? ''), /Starting today\? ~5 km over the rest of this week in two easy runs, nothing over ~3 km; the restart week \(~17 km\) starts Monday/);
});

test('item 3: the same break one day earlier (Friday, usual days Saturday and Sunday): 7 km in two runs of at most 4 km', () => {
  const fri = planOf('runner_no_race', '2026-04-20', '2026-04-24');
  assert.deepEqual(fri.restart?.midWeek, { fullKm: 17, daysLeft: 3, km: 7, longCapKm: 4, pending: true, runs: 2 });
});

// ── group 2 ──────────────────────────────────────────────────────────────────

const opener = (name: ScenarioName, idx: number): string => nbsp(snap(name, idx).opener?.required ?? '');
const review = (name: ScenarioName, idx: number) => snap(name, idx).review?.review;

test('item 4: "Welcome back" is the opener on the first day back only; the next days count the restart week', () => {
  assert.equal(opener('runner_comeback_spike', 70), 'Goal check-in: Building back — restart at ~18 km this week.');
  assert.equal(opener('runner_comeback_spike', 71), 'Welcome back — restart at ~18 km this week.');
  assert.equal(opener('runner_comeback_spike', 72), 'Restart week — ~18 km, 4 km so far.');
  assert.equal(opener('runner_comeback_spike', 76), 'Restart week — ~18 km, 15 km so far.');
});

test('item 5 and 6: "Back out there" is the first week back only; a restart week that ran last week\'s km is "same as last week"', () => {
  assert.equal(nbsp(review('runner_comeback_spike', 70)?.win ?? ''), 'Back out there: 15 km after the break.');
  assert.equal(review('runner_comeback_spike', 77)?.win, null);
  assert.equal(nbsp(review('runner_comeback_spike', 77)?.stats.find(s => s.label === 'Volume')?.comparison ?? ''), 'same as last week');
  assert.equal(nbsp(review('runner_comeback_spike', 70)?.stats.find(s => s.label === 'Volume')?.comparison ?? ''), 'back after 6 km last week');
});

test('item 7: a restart is not a step - "more than the restart called for", and the 7 km run over the ~4 km cap is named once, in the slip', () => {
  const r = review('runner_comeback_spike', 70);
  assert.equal(nbsp(r?.headline ?? ''), '3 sessions, 15 of ~10 km — more than the restart called for · goal 30 km');
  assert.equal(nbsp(r?.slip ?? ''), 'Longest run 7 km, over the ~4 km the restart week called for');
});

test('item 8: no peak date during the scaled restart (the restart week\'s long run is capped at 40% of it)', () => {
  for (const idx of [66, 68, 69]) assert.match(nbsp(snap('runner_messy', idx).card?.reasons.find(r => r.kind === 'long_run')?.text ?? ''), /· peak target 15 km$/);
});

test('item 9: a Sunday that is not one of the runner\'s run days has no "~2 km left" to offer', () => {
  const d139 = snap('runner_messy', 139).card;
  assert.doesNotMatch(nbsp([d139?.headline, ...(d139?.reasons ?? []).map(r => r.text)].join(' | ')), /left|one short easy run/);
  assert.match(nbsp(d139?.reasons.find(r => r.kind === 'plan')?.text ?? ''), /~17 km this week, done$/);
});

test('item 10: the peak date is the plan\'s real one, and the hold-week card has no "— fine."', () => {
  // (Wave 26e group B: the graded long-run step 7, 8, 9, 10, [cutback], 11.5, 13, 14.5, [cutback], 15 gets the obedient runner there on Sunday 2026-05-17: "mid-May", it was "early May" at +2 km a week.)
  assert.match(nbsp(snap('runner_on_plan_obedient', 36).card?.reasons.find(r => r.kind === 'long_run')?.text ?? ''), /build to 15 km by mid-May/);
  const hold = runTimeline('runner_on_plan').map(s => nbsp(s.card?.reasons.find(r => r.kind === 'plan')?.text ?? '')).find(t => /became a normal week/.test(t));
  assert.match(hold ?? '', /^Your cutback became a normal week\. Hold ~25 km this week/);
});
