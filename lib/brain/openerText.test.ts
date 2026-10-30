import assert from 'node:assert/strict';
import test from 'node:test';
import { goalFallbackOpener, goalOpenerLine, newUserGoalOpener, requiredOpenerLine, returningUserOpener } from './openerText';
import { REACHED_ASK_DAYS } from '../weightWeekPlan';
import type { GoalProgress } from '../goalProgress';

function gp(over: Partial<GoalProgress> = {}): GoalProgress {
  return {
    goal: 'weight_loss',
    target: { weightKg: 76, date: '2026-12-30', weeklySessions: null, weeklyDistanceKm: null },
    distance: null,
    current: { weightKg: 82, startWeightKg: 83.7, changeKg: -1.7, progressPct: 22 },
    ratePerWeek: { kg: -0.6, pctBodyweight: -0.73 },
    safeBand: { minPct: 0.25, maxPct: 1 },
    eta: '2026-12-16',
    onPaceForTargetDate: true,
    verdict: 'on_track',
    headline: 'On track — about 6 kg to go, around Dec 16',
    reasons: [],
    dataSufficiency: { weighIns: 11, needed: 3, sessionsLast28d: 0 },
    ...over,
  };
}

test('weight-loss opener states amount done, total and pace vs target date in kg', () => {
  assert.equal(
    goalOpenerLine(gp(), 'metric'),
    "You're 1.7 of 7.7 kg down and about 2 weeks ahead of your Dec 30 target.",
  );
});

test('weight-loss opener converts to lb for imperial users', () => {
  assert.equal(
    goalOpenerLine(gp(), 'imperial'),
    "You're 3.7 of 17 lb down and about 2 weeks ahead of your Dec 30 target.",
  );
});

test('opener says on pace within a week and behind when the ETA is later', () => {
  assert.match(goalOpenerLine(gp({ eta: '2026-12-28' }), 'metric') ?? '', /right on pace for your Dec 30 target/);
  assert.match(goalOpenerLine(gp({ eta: '2027-01-20', verdict: 'behind' }), 'metric') ?? '', /about 3 weeks behind your Dec 30 target/);
});

test('opener omits the pace clause without an ETA', () => {
  assert.equal(goalOpenerLine(gp({ eta: null }), 'metric'), "You're 1.7 of 7.7 kg down.");
});

test('muscle gain reads "up"', () => {
  const line = goalOpenerLine(
    gp({ goal: 'muscle', target: { weightKg: 82, date: null, weeklySessions: 4, weeklyDistanceKm: null }, current: { weightKg: 79, startWeightKg: 78, changeKg: 1, progressPct: 25 }, eta: null }),
    'metric',
  );
  assert.equal(line, "You're 1 of 4 kg up.");
});

test('non-weight goals fall back to the card headline', () => {
  const line = goalOpenerLine(
    gp({ goal: 'endurance', target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 }, current: { weightKg: 70, startWeightKg: null, changeKg: null, progressPct: null }, verdict: 'building', headline: 'Building — distance up 12%' }),
    'metric',
  );
  assert.equal(line, 'Goal check-in: Building — distance up 12%.');
});

test('a headline that ends in its own "!" keeps it: no "!." after Congratulations', () => {
  const done = gp({
    goal: 'endurance', target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    current: { weightKg: 70, startWeightKg: null, changeKg: null, progressPct: null },
    verdict: 'on_track', headline: 'Half marathon done — 21.1 km in 2:01. Congratulations!',
  });
  assert.equal(goalOpenerLine(done, 'metric'), 'Goal check-in: Half marathon done — 21.1 km in 2:01. Congratulations!');
  assert.equal(goalFallbackOpener(done, 'endurance', 'metric'), 'Goal check-in: Half marathon done — 21.1 km in 2:01. Congratulations! What would you like to dig into?');
  // A headline that ends in a full stop gets exactly one.
  const stop = gp({
    goal: 'endurance', target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    current: { weightKg: 70, startWeightKg: null, changeKg: null, progressPct: null },
    verdict: 'holding', headline: 'Holding steady — 4 sessions a week.',
  });
  assert.equal(goalOpenerLine(stop, 'metric'), 'Goal check-in: Holding steady — 4 sessions a week.');
});

test('a runner on a break: the opener says "On a break" once, never counts the days, and "Welcome back" waits for the first run back', () => {
  const brk = (headline: string, thisWeekKm: number | null = 0, plan: 'restart' | 'build' = 'restart') => gp({
    goal: 'endurance', target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    current: { weightKg: 70, startWeightKg: null, changeKg: null, progressPct: null },
    verdict: 'building', headline, lastSessionDaysAgo: 15,
    distance: { targetKm: 30, thisWeekKm, avg4wKm: 12, weekStart: '2026-10-05', stepTargetKm: 15, text: 'x', plan: { kind: plan, targetKm: 15, longRunKm: null, purpose: 'x' } },
  });
  const days = [7, 8, 11, 15].map(n => goalOpenerLine(brk(`On a break — ${n} days since your last run. Restart at ~15 km.`), 'metric'));
  assert.deepEqual([...new Set(days)], ['Goal check-in: On a break — restart at ~15 km.']);
  // The card already shows a restart plan: no second "quick reset plan" offer, whatever the days since the last session.
  assert.equal(returningUserOpener(brk('On a break — 15 days since your last run. Restart at ~15 km.')), null);
  assert.equal(returningUserOpener(brk('Building back — restart at ~15 km this week', 3.5)), null);
  assert.equal(requiredOpenerLine(brk('On a break — 15 days since your last run. Restart at ~15 km.'), 'endurance', 'metric'), 'Goal check-in: On a break — restart at ~15 km.');
  // Welcome back only once a run is in; before it the restart week is the plain check-in.
  assert.equal(goalOpenerLine(brk('Building back — restart at ~15 km this week', 3.5), 'metric'), 'Welcome back — restart at ~15 km this week.');
  assert.equal(goalOpenerLine(brk('Building back — restart at ~15 km this week', 0), 'metric'), 'Goal check-in: Building back — restart at ~15 km this week.');
  assert.equal(goalFallbackOpener(brk('Building back — restart at ~15 km this week', 3.5), 'endurance', 'metric'), 'Welcome back — restart at ~15 km this week. What would you like to dig into?');
  // A runner with a gap and no plan (no weekly distance goal) still gets the reset offer.
  const noPlan = gp({ goal: 'endurance', verdict: 'holding', headline: 'Holding steady', lastSessionDaysAgo: 20 });
  assert.match(returningUserOpener(noPlan) ?? '', /quick reset plan/);
});

test('needs_target / insufficient_data / missing progress yield no progress line', () => {
  assert.equal(goalOpenerLine(gp({ verdict: 'needs_target' }), 'metric'), null);
  assert.equal(goalOpenerLine(gp({ verdict: 'insufficient_data' }), 'metric'), null);
  assert.equal(goalOpenerLine(undefined, 'metric'), null);
});

test('new-user opener states the onboarding goal instead of asking for it', () => {
  const text = newUserGoalOpener('weight_loss') ?? '';
  assert.match(text, /^Your goal is to lose weight\./);
  assert.match(text, /want to set a target weight\?/);
  assert.doesNotMatch(text, /Tell me your goal/i);
  assert.equal(newUserGoalOpener('nonsense'), null);
  assert.equal(newUserGoalOpener(undefined), null);
});

test('requiredOpenerLine prefers progress, then the goal, then null', () => {
  assert.match(requiredOpenerLine(gp(), 'weight_loss', 'metric') ?? '', /^You're 1\.7 of 7\.7 kg down/);
  assert.match(requiredOpenerLine(gp({ verdict: 'needs_target', target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: null } }), 'general', 'metric') ?? '', /^Your goal is to lose weight/);
  assert.match(requiredOpenerLine(undefined, 'muscle', 'metric') ?? '', /^Your goal is to build muscle/);
  assert.equal(requiredOpenerLine(undefined, undefined, 'metric'), null);
});

test('goalFallbackOpener appends the invite to a progress line only', () => {
  assert.match(goalFallbackOpener(gp(), 'weight_loss', 'metric') ?? '', /target\. What would you like to dig into\?$/);
  assert.match(goalFallbackOpener(undefined, 'weight_loss', 'metric') ?? '', /want to set a target weight\?$/);
  assert.equal(goalFallbackOpener(undefined, null, 'metric'), null);
});

test('new-user opener states an existing target weight instead of asking for one', () => {
  const withTarget = gp({ target: { weightKg: 71.67, date: null, weeklySessions: null, weeklyDistanceKm: null } });
  const imperial = newUserGoalOpener('weight_loss', withTarget, 'imperial') ?? '';
  assert.match(imperial, /^Your goal: 158 lb\. Once you've logged a few days I'll tell you how it's going\.$/);
  assert.doesNotMatch(imperial, /want to set/);
  assert.match(newUserGoalOpener('weight_loss', withTarget, 'metric') ?? '', /^Your goal: 71\.7 kg\./);
  const noTarget = gp({ target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: null } });
  assert.match(newUserGoalOpener('weight_loss', noTarget, 'imperial') ?? '', /want to set a target weight\?$/);
});

// ── honest openers: every existing target, returning users, reached goals ────

const NO_TARGETS = { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: null };

test('new-user opener states a weekly distance, sessions a week and the race instead of asking for them', () => {
  const endurance = gp({
    goal: 'endurance',
    target: { ...NO_TARGETS, weeklyDistanceKm: 30, weeklySessions: 4 },
    race: { date: '2027-03-15', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 24, daysToGo: 160 },
    verdict: 'insufficient_data',
  });
  const metric = newUserGoalOpener('endurance', endurance, 'metric') ?? '';
  assert.equal(metric, "Your goal: 30 km a week, 4 sessions a week and the half marathon on Mar 15. Once you've logged a few days I'll tell you how it's going.");
  assert.doesNotMatch(metric, /want to set/);
  const imperial = newUserGoalOpener('endurance', endurance, 'imperial') ?? '';
  assert.match(imperial, /^Your goal: 18\.6 mi a week, 4 sessions a week and the half marathon on Mar 15\./);

  // One target alone is enough to stop the ask.
  const distanceOnly = gp({ goal: 'endurance', target: { ...NO_TARGETS, weeklyDistanceKm: 30 }, verdict: 'insufficient_data' });
  assert.equal(newUserGoalOpener('endurance', distanceOnly, 'metric'), "Your goal: 30 km a week. Once you've logged a few days I'll tell you how it's going.");
  const sessionsOnly = gp({ goal: 'muscle', target: { ...NO_TARGETS, weeklySessions: 1 }, verdict: 'insufficient_data' });
  assert.equal(newUserGoalOpener('muscle', sessionsOnly, 'metric'), "Your goal: 1 session a week. Once you've logged a few days I'll tell you how it's going.");
  const raceOnly = gp({
    goal: 'endurance', target: NO_TARGETS, verdict: 'insufficient_data',
    race: { date: '2027-03-15', distanceKm: null, label: 'Race', weeksToGo: 24, daysToGo: 160 },
  });
  assert.match(newUserGoalOpener('endurance', raceOnly, 'metric') ?? '', /^Your goal: the race on Mar 15\. Once/);
  // A race that is already done (recovery) is not a target the user still has: it is not quoted back.
  const raceDone = gp({
    goal: 'endurance', target: { ...NO_TARGETS, weeklyDistanceKm: 30 }, verdict: 'insufficient_data',
    race: { date: '2026-10-03', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 0, phase: 'recovery', daysSince: 3 },
  });
  assert.equal(newUserGoalOpener('endurance', raceDone, 'metric'), "Your goal: 30 km a week. Once you've logged a few days I'll tell you how it's going.");
  // A target weight still carries its date.
  const dated = gp({ target: { ...NO_TARGETS, weightKg: 71.67, date: '2026-12-30' } });
  assert.match(newUserGoalOpener('weight_loss', dated, 'metric') ?? '', /^Your goal: 71\.7 kg by Dec 30\. Once/);
  // No target at all still asks; a weight-loss goal with only sessions set still asks for the weight.
  assert.match(newUserGoalOpener('endurance', gp({ goal: 'endurance', target: NO_TARGETS }), 'metric') ?? '', /want to set a weekly distance goal\?$/);
  assert.match(
    newUserGoalOpener('weight_loss', gp({ target: { ...NO_TARGETS, weeklySessions: 3 } }), 'metric') ?? '',
    /^Your goal: 3 sessions a week\. Once you've logged a few days I'll tell you how it's going — want to set a target weight\?$/,
  );
});

test('returning user: a weigh-in or session more than 14 days ago gets a welcome-back reset offer', () => {
  const lapsed = gp({ verdict: 'insufficient_data', lastWeighInDaysAgo: 23 });
  assert.equal(
    requiredOpenerLine(lapsed, 'weight_loss', 'metric'),
    'Welcome back — your last weigh-in was 23 days ago. Want a quick reset plan?',
  );
  assert.equal(goalFallbackOpener(lapsed, 'weight_loss', 'metric'), 'Welcome back — your last weigh-in was 23 days ago. Want a quick reset plan?');
  // 14 days is not yet "returning".
  assert.doesNotMatch(requiredOpenerLine(gp({ lastWeighInDaysAgo: 14 }), 'weight_loss', 'metric') ?? '', /Welcome back/);
  assert.doesNotMatch(requiredOpenerLine(gp({ lastWeighInDaysAgo: 3 }), 'weight_loss', 'metric') ?? '', /Welcome back/);
  // Non-weight goals key off the last session; a stale weigh-in alone does not matter for them.
  const runner = gp({ goal: 'endurance', target: { ...NO_TARGETS, weeklyDistanceKm: 30 }, verdict: 'insufficient_data', lastSessionDaysAgo: 19, lastWeighInDaysAgo: 40 });
  assert.equal(requiredOpenerLine(runner, 'endurance', 'metric'), 'Welcome back — your last session was 19 days ago. Want a quick reset plan?');
  assert.doesNotMatch(
    requiredOpenerLine(gp({ goal: 'endurance', target: { ...NO_TARGETS, weeklyDistanceKm: 30 }, verdict: 'building', headline: 'Building', lastSessionDaysAgo: 2, lastWeighInDaysAgo: 40 }), 'endurance', 'metric') ?? '',
    /Welcome back/,
  );
  assert.equal(returningUserOpener(undefined), null);
  assert.equal(returningUserOpener(gp({ lastWeighInDaysAgo: null })), null);
});

test('reached goal: the opener congratulates and asks for a new target or maintenance, with no second invitation', () => {
  const reached = gp({
    verdict: 'reached', headline: 'Goal reached — 76 kg (Sep 20)', eta: null,
    current: { weightKg: 75.8, startWeightKg: 83.7, changeKg: -7.9, progressPct: 100 },
  });
  // (How far down the weekly average really is - the card's "-7.9 kg since start" - not the size of the goal.)
  const line = "Congratulations — you've reached 76 kg (7.9 kg down). Want to set a new target or switch to maintenance?";
  assert.equal(goalOpenerLine(reached, 'metric'), line);
  assert.equal(requiredOpenerLine(reached, 'weight_loss', 'metric'), line);
  assert.equal(goalFallbackOpener(reached, 'weight_loss', 'metric'), line);
  assert.equal(goalOpenerLine(reached, 'imperial'), "Congratulations — you've reached 167.6 lb (17.4 lb down). Want to set a new target or switch to maintenance?");
  // Muscle goals reach a weight target the same way.
  assert.match(goalOpenerLine({ ...reached, goal: 'muscle' }, 'metric') ?? '', /^You've reached 76 kg/);
});

test('wave 23w: the reach is congratulated on the reach day and on the Monday after it - the question stays, the confetti does not', () => {
  // Reached Fri Jun 12; today is reachedAt + reachedDaysAgo.
  const reached = (reachedDaysAgo: number) => gp({
    verdict: 'reached', headline: 'Goal reached — 84 kg (Jun 12)', eta: null, reachedAt: '2026-06-12',
    target: { weightKg: 84, date: null, weeklySessions: null, weeklyDistanceKm: null },
    current: { weightKg: 84.2, startWeightKg: 92, changeKg: -7.8, progressPct: 100 },
    weightRead: { ...READ, state: 'reached', weekMeanKg: 84.2, scaleKg: 84, reachedDaysAgo, plan: { state: 'reached', action: { kind: 'next_target', text: 'Set a new target or switch to maintenance' } } as unknown as NonNullable<GoalProgress['weightRead']>['plan'] },
  });
  const celebrate = "Congratulations — you've reached 84 kg (7.8 kg down). Want to set a new target or switch to maintenance?";
  const plain = "You've reached 84 kg — want to set a new target or switch to maintenance?";
  assert.equal(goalOpenerLine(reached(0), 'metric'), celebrate, 'the reach day (a Friday)');
  assert.equal(goalOpenerLine(reached(1), 'metric'), plain, 'Saturday');
  assert.equal(goalOpenerLine(reached(2), 'metric'), plain, 'Sunday');
  assert.equal(goalOpenerLine(reached(3), 'metric'), celebrate, 'the Monday after');
  for (const n of [4, 5, 6, 7]) assert.equal(goalOpenerLine(reached(n), 'metric'), plain, `${n} days on`);
  assert.equal(goalFallbackOpener(reached(1), 'weight_loss', 'metric'), plain, 'it still ends in its own question');
});

test('wave 23w: once the step toward maintenance is given the opener is one short sentence, not the plan\'s whole instruction', () => {
  const planWith = (step: Record<string, unknown>, action: Record<string, unknown>) => ({ state: 'maintenance', action, step }) as unknown as NonNullable<GoalProgress['weightRead']>['plan'];
  const reached = (plan: NonNullable<GoalProgress['weightRead']>['plan'], weekMeanKg = 84) => gp({
    verdict: 'reached', headline: 'Goal reached — 84 kg (Jun 12)', eta: null, reachedAt: '2026-06-12',
    target: { weightKg: 84, date: null, weeklySessions: null, weeklyDistanceKm: null },
    current: { weightKg: weekMeanKg, startWeightKg: 92, changeKg: -8, progressPct: 100 },
    weightRead: { ...READ, state: 'reached', weekMeanKg, scaleKg: 84, reachedDaysAgo: 12, plan },
  });
  const standing = planWith({ phase: 'standing', loKcal: 2150, hiKcal: 2200, food: false, logsShow: true }, { kind: 'maintenance_target', text: "Stay at ~2,150–2,200 kcal (the step you started Jun 5); we'll read it on Mon, Jun 22", kcalTarget: 2150 });
  assert.equal(goalOpenerLine(reached(standing), 'metric'), "You're holding at 84 kg — stay around ~2,150–2,200 kcal this week and keep weighing in.");
  assert.equal(goalOpenerLine(reached(standing, 83.7), 'metric'), "You're holding at 83.7 kg — stay around ~2,150–2,200 kcal this week and keep weighing in.");
  // Wave 25w: until the logs show the step it is "aim for", the plan's own verb ("Aim for ~2,150–2,200 kcal a day").
  const notYet = planWith({ phase: 'standing', loKcal: 2150, hiKcal: 2200, food: false, logsShow: false }, { kind: 'maintenance_target', text: "Aim for ~2,150–2,200 kcal a day; we'll read it on Mon, Jun 22", kcalTarget: 2150 });
  assert.equal(goalOpenerLine(reached(notYet), 'metric'), "You're holding at 84 kg — aim for ~2,150–2,200 kcal this week and keep weighing in.");
  const settled = planWith({ phase: 'settled', loKcal: 2050, hiKcal: 2050, food: false }, { kind: 'hold', text: 'Stay at ~2,050 kcal — your maintenance; if your average drifts 1 kg above or below your target, that is your cue to act', kcalTarget: 2050 });
  assert.equal(goalOpenerLine(reached(settled), 'metric'), "You're holding at 84 kg — stay around ~2,050 kcal this week and keep weighing in.");
  const snack = planWith({ phase: 'standing', loKcal: null, hiKcal: null, food: true }, { kind: 'maintenance_target', text: "Keep the daily snack (from Jun 5); we'll read it on Mon, Jun 22" });
  assert.equal(goalOpenerLine(reached(snack), 'metric'), "You're holding at 84 kg — keep your daily snack this week and keep weighing in.");
  // The week the step is read says so, in the plan's words (without the date of the next read).
  const read = planWith({ phase: 'read', loKcal: 2150, hiKcal: 2200, food: false }, { kind: 'maintenance_target', text: "Your weekly average held within 0.5 kg on ~2,150–2,200 kcal — keep it, that's your maintenance", kcalTarget: 2150 });
  assert.equal(goalOpenerLine(reached(read), 'metric'), "Your weekly average held within 0.5 kg on ~2,150–2,200 kcal — keep it, that's your maintenance.");
  const more = planWith({ phase: 'given', loKcal: 2300, hiKcal: 2350, food: false }, { kind: 'maintenance_target', text: "Your weekly average is still falling (down 0.7 kg in a week) — add another ~150 kcal a day (to ~2,300–2,350 kcal); we'll read it on Mon, Jun 1", kcalTarget: 2300 });
  assert.equal(goalOpenerLine(reached(more), 'metric'), 'Your weekly average is still falling (down 0.7 kg in a week) — add another ~150 kcal a day (to ~2,300–2,350 kcal).');
});

// ── Wave 19b: a lifter who has already logged sessions is not "yet to log a few days" ──

test('muscle opener after the first sessions: says how many are in and when the 4-week lift trend starts', () => {
  const gp = {
    goal: 'muscle', verdict: 'insufficient_data', headline: '4-week lift trend from Mar 30',
    target: { weightKg: null, date: null, weeklySessions: 4, weeklyDistanceKm: null },
    dataSufficiency: { weighIns: 3, needed: 3, sessionsLast28d: 4 },
  } as unknown as Parameters<typeof newUserGoalOpener>[1];
  assert.equal(newUserGoalOpener('muscle', gp, 'metric'), "Your goal: 4 sessions a week. You've logged 4 sessions so far — your 4-week lift trend starts Mar 30.");
  // Not enough yet (one session): the original line stands.
  const one = { ...(gp as object), dataSufficiency: { weighIns: 1, needed: 3, sessionsLast28d: 1 } } as unknown as Parameters<typeof newUserGoalOpener>[1];
  assert.match(newUserGoalOpener('muscle', one, 'metric') ?? '', /Once you've logged a few days/);
});

// ── wave 19c: the opener says what the card says ─────────────────────────────

const READ = { state: 'pace' as const, scaleKg: 82, scaleDay: '2026-10-06', weekMeanKg: 82.2, weeksVsTarget: null, returned: null, reachedDaysAgo: null };

test('opener pace phrase comes from the card: one 7-day margin, so an ETA 10 days early is "about 1 week ahead", 6 days is on pace', () => {
  assert.match(goalOpenerLine(gp({ verdict: 'ahead', eta: '2026-12-20' }), 'metric') ?? '', /about 1 week ahead of your Dec 30 target\.$/);
  assert.match(goalOpenerLine(gp({ verdict: 'on_track', eta: '2026-12-24' }), 'metric') ?? '', /right on pace for your Dec 30 target\.$/);
  assert.match(goalOpenerLine(gp({ verdict: 'on_track', eta: '2027-01-05' }), 'metric') ?? '', /right on pace/);
  assert.match(goalOpenerLine(gp({ verdict: 'behind', eta: '2027-01-12' }), 'metric') ?? '', /about 2 weeks behind your Dec 30 target\.$/);
});

test('a weight-loss card that made no pace call gets no pace phrase: too fast, stalled, progressing and early reads', () => {
  for (const verdict of ['too_fast', 'stalled', 'progressing', 'holding'] as const) {
    const line = goalOpenerLine(gp({ verdict, eta: '2026-12-01' }), 'metric') ?? '';
    assert.doesNotMatch(line, /ahead|behind|on pace/, `${verdict}: ${line}`);
  }
  assert.equal(goalOpenerLine(gp({ verdict: 'too_fast', eta: null }), 'metric'), "You're 1.7 of 7.7 kg down, but losing faster than is easy to keep.");
  assert.equal(goalOpenerLine(gp({ verdict: 'stalled', eta: null }), 'metric'), "You're 1.7 of 7.7 kg down, but your weight has been flat lately.");
  assert.equal(
    goalOpenerLine(gp({ verdict: 'progressing', eta: null, ratePerWeek: { kg: -0.58, pctBodyweight: -0.7 } }), 'metric'),
    // Wave 23w: "about 0.6 kg a week" (one decimal) in the headline and the opener alike; the rate line keeps the two decimals.
    "You're 1.7 of 7.7 kg down and losing about 0.6 kg a week.",
  );
});

test('early read: the amount down is the card\'s one progress weight (the weekly average), not the trend or the last reading, and says the pace is not read yet', () => {
  const early = gp({
    verdict: 'progressing', eta: null, current: { weightKg: 83.5, startWeightKg: 83.7, changeKg: -0.3, progressPct: 4 },
    weightRead: { ...READ, state: 'early', scaleKg: 83.0, weekMeanKg: 83.4 },
  });
  // Wave 21w (finding 4): the number is the 7-day average, so the line says "weekly average" — "on the scale" is a single reading only.
  assert.equal(goalOpenerLine(early, 'metric'), "Your weekly average is 0.3 kg below your start; your pace settles after 3 weeks.");
  assert.equal(goalOpenerLine(early, 'imperial'), "Your weekly average is 0.7 lb below your start; your pace settles after 3 weeks.");
  // Without a weekly average (fewer than 3 weigh-ins that week) the latest scale reading is the progress weight.
  const sparse = gp({ ...early, weightRead: { ...READ, state: 'early', scaleKg: 83.0, weekMeanKg: null } });
  assert.equal(goalOpenerLine(sparse, 'metric'), "You're 0.7 of 7.7 kg down on the scale; your pace settles after 3 weeks.");
});

test('an older goal without a pace says a few more weigh-ins bring it back, not "settles after 3 weeks"', () => {
  const old = (goalAgeDays: number | null) => gp({
    verdict: 'progressing', eta: null, current: { weightKg: 83.5, startWeightKg: 83.7, changeKg: -0.3, progressPct: 4 },
    weightRead: { ...READ, state: 'early', scaleKg: 83.0, weekMeanKg: 83.4, goalAgeDays },
  });
  assert.equal(goalOpenerLine(old(84), 'metric'), "Your weekly average is 0.3 kg below your start; a few more weigh-ins and your pace is back.");
  assert.equal(goalOpenerLine(old(21), 'metric'), "Your weekly average is 0.3 kg below your start; a few more weigh-ins and your pace is back.");
  assert.equal(goalOpenerLine(old(20), 'metric'), "Your weekly average is 0.3 kg below your start; your pace settles after 3 weeks.");
  assert.equal(goalOpenerLine(old(null), 'metric'), "Your weekly average is 0.3 kg below your start; your pace settles after 3 weeks.");
});

test('a plateau and a weekly average: "down" is measured from the weekly average', () => {
  const plateau = gp({ verdict: 'holding', eta: null, weightRead: { ...READ, state: 'plateau', weekMeanKg: 81.4 } });
  assert.equal(goalOpenerLine(plateau, 'metric'), "You're 2.3 of 7.7 kg down, though your weekly average has been flat for 3 weeks.");
});

test('welcome back after a gap: leads with the change on the scale since the last weigh-in, until 3 weigh-ins are back', () => {
  const back = (weighInsSince: number) => gp({
    verdict: 'progressing', eta: null,
    weightRead: { ...READ, state: 'returning', scaleKg: 85.4, returned: { gapDays: 12, sinceDay: '2026-05-10', sinceKg: 86.5, weighInsSince } },
  });
  assert.equal(
    goalOpenerLine(back(1), 'metric'),
    'Welcome back — you\'re 1.1 kg lighter than on May 10; weigh in a couple more mornings.',
  );
  assert.equal(requiredOpenerLine(back(1), 'weight_loss', 'metric'), goalOpenerLine(back(1), 'metric'));
  assert.equal(
    goalFallbackOpener(back(1), 'weight_loss', 'metric'),
    'Welcome back — you\'re 1.1 kg lighter than on May 10; weigh in a couple more mornings. What would you like to dig into?',
  );
  assert.equal(
    goalOpenerLine({ ...back(1), weightRead: { ...back(1).weightRead!, returned: { gapDays: 12, sinceDay: '2026-05-10', sinceKg: 85.0, weighInsSince: 1 } } }, 'metric'),
    'Welcome back — you\'re 0.4 kg heavier than on May 10; weigh in a couple more mornings.',
  );
  assert.equal(
    goalOpenerLine({ ...back(1), weightRead: { ...back(1).weightRead!, returned: { gapDays: 12, sinceDay: '2026-05-10', sinceKg: 86.5, weighInsSince: 1 } } }, 'imperial'),
    'Welcome back — you\'re 2.4 lb lighter than on May 10; weigh in a couple more mornings.',
  );
  // Still returning on the second weigh-in back (the card's "returning" state lasts until 3 are back): not "pace settles after 3 weeks".
  assert.equal(
    goalOpenerLine(back(2), 'metric'),
    'Welcome back — you\'re 1.1 kg lighter than on May 10; weigh in a couple more mornings.',
  );
  // The scale back where it was: said plainly.
  assert.equal(
    goalOpenerLine({ ...back(1), weightRead: { ...back(1).weightRead!, returned: { gapDays: 12, sinceDay: '2026-05-10', sinceKg: 85.4, weighInsSince: 1 } } }, 'metric'),
    'Welcome back — your weight is about the same as on May 10; weigh in a couple more mornings.',
  );
});

test('reached: asks about a new target or maintenance in the first 7 days after reachedAt only (the week plan\'s window), then reports where the weight holds', () => {
  const reached = (reachedDaysAgo: number | null) => gp({
    verdict: 'reached', headline: 'Goal reached — 76 kg', eta: null,
    current: { weightKg: 76.4, startWeightKg: 83.7, changeKg: -7.3, progressPct: 100 },
    weightRead: { ...READ, state: 'reached', weekMeanKg: 76.1, scaleKg: 76.3, reachedDaysAgo },
  });
  const ask = "Congratulations — you've reached 76 kg (7.3 kg down). Want to set a new target or switch to maintenance?";
  assert.equal(REACHED_ASK_DAYS, 7, 'the plan asks for 7 days after the reach; the opener has no window of its own');
  assert.equal(goalOpenerLine(reached(0), 'metric'), ask);
  assert.equal(goalOpenerLine(reached(REACHED_ASK_DAYS), 'metric'), ask);
  assert.equal(goalFallbackOpener(reached(REACHED_ASK_DAYS), 'weight_loss', 'metric'), ask, 'it ends in its own question: no second invitation');
  assert.equal(goalOpenerLine(reached(REACHED_ASK_DAYS + 1), 'metric'), 'Holding at 76.1 kg, within 1 kg of 76 kg.');
  assert.equal(goalOpenerLine(reached(10), 'imperial'), 'Holding at 167.8 lb, within 2.2 lb of 167.6 lb.');
  assert.equal(goalFallbackOpener(reached(10), 'weight_loss', 'metric'), 'Holding at 76.1 kg, within 1 kg of 76 kg. What would you like to dig into?');
  // Unknown crossing: no daily nag either.
  assert.equal(goalOpenerLine(reached(null), 'metric'), 'Holding at 76.1 kg, within 1 kg of 76 kg.');
  // Drifting well under the target says so instead.
  const under = gp({ ...reached(10), weightRead: { ...READ, state: 'reached', weekMeanKg: 74.2, reachedDaysAgo: 10 } });
  assert.equal(goalOpenerLine(under, 'metric'), 'At 74.2 kg, 1.8 kg under your 76 kg target.');
});

test('reached: with a week plan the opener asks exactly when the plan\'s action is the new-target one, and repeats a calorie instruction in the plan\'s words', () => {
  const planOf = (action: Record<string, unknown>) => ({ state: 'reached', action }) as unknown as NonNullable<GoalProgress['weightRead']>['plan'];
  const reached = (action: Record<string, unknown>, reachedDaysAgo: number) => gp({
    verdict: 'reached', headline: 'Goal reached — 76 kg', eta: null,
    current: { weightKg: 76.4, startWeightKg: 83.7, changeKg: -7.3, progressPct: 100 },
    weightRead: { ...READ, state: 'reached', weekMeanKg: 76.1, scaleKg: 76.3, reachedDaysAgo, plan: planOf(action) },
  });
  const ask = "Congratulations — you've reached 76 kg (7.3 kg down). Want to set a new target or switch to maintenance?";
  // The plan decides, whatever the day count says (the card and the coach lines read the same plan).
  assert.equal(goalOpenerLine(reached({ kind: 'next_target', text: 'Set a new target or switch to maintenance' }, 9), 'metric'), ask);
  assert.equal(goalOpenerLine(reached({ kind: 'keep_weighing', text: 'x' }, 2), 'metric'), 'Holding at 76.1 kg, within 1 kg of 76 kg.');
  assert.equal(
    goalOpenerLine(reached({ kind: 'maintenance_target', text: "You've held 76 kg on ~2,050 kcal — make that your maintenance target", kcalTarget: 2050 }, 12), 'metric'),
    "You've held 76 kg on ~2,050 kcal — make that your maintenance target.",
  );
  // A calorie target that already is maintenance is not asked to "switch": the opener says what the card says.
  const atMaintenance = reached({ kind: 'hold', text: 'Your calorie target is already at maintenance — keep it there and the weight should hold.', kcalTarget: 2200 }, 2);
  assert.equal(goalOpenerLine(atMaintenance, 'metric'), 'Your calorie target is already at maintenance — keep it there and the weight should hold.');
  assert.equal(goalFallbackOpener(atMaintenance, 'weight_loss', 'metric'), 'Your calorie target is already at maintenance — keep it there and the weight should hold. What would you like to dig into?');
});

// ── Wave 20b: a lifter a week or more past the last session ─────────────────

test('muscle opener past the lapse threshold: states the lapse (no praise) and asks about getting back in, once', () => {
  const lapsed = gp({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 4, weeklyDistanceKm: null },
    verdict: 'holding', headline: 'No sessions for 8 days — Squat was est. 1RM 142 kg, week of Apr 20', lastSessionDaysAgo: 8,
  });
  const line = 'Goal check-in: No sessions for 8 days — Squat was est. 1RM 142 kg, week of Apr 20. Want to plan how to get back in?';
  assert.equal(goalOpenerLine(lapsed, 'metric'), line);
  assert.equal(requiredOpenerLine(lapsed, 'muscle', 'metric'), line);
  assert.equal(goalFallbackOpener(lapsed, 'muscle', 'metric'), line, 'no second invitation after its own question');
  // Still away at 15 days: the lapse check-in stays — "Welcome back" is for the first session back (wave 21).
  const away = { ...lapsed, headline: 'No sessions for 15 days — Squat was est. 1RM 142 kg, week of Apr 20', lastSessionDaysAgo: 15 };
  const awayLine = 'Goal check-in: No sessions for 15 days — Squat was est. 1RM 142 kg, week of Apr 20. Want to plan how to get back in?';
  assert.equal(requiredOpenerLine(away, 'muscle', 'metric'), awayLine);
  assert.equal(goalFallbackOpener(away, 'muscle', 'metric'), awayLine);
  assert.equal(returningUserOpener(away), null);
  assert.doesNotMatch(requiredOpenerLine({ ...away, lastSessionDaysAgo: 27 }, 'muscle', 'metric') ?? '', /Welcome back/);
  // 3 days (or any other verdict): the plain check-in. The threshold is 4 days for 4 a week, a week for 2 (wave 21).
  assert.doesNotMatch(goalOpenerLine({ ...lapsed, lastSessionDaysAgo: 3 }, 'metric') ?? '', /get back in/);
  assert.match(goalOpenerLine({ ...lapsed, lastSessionDaysAgo: 4 }, 'metric') ?? '', /get back in/);
  assert.doesNotMatch(goalOpenerLine({ ...lapsed, verdict: 'progressing', lastSessionDaysAgo: 8 }, 'metric') ?? '', /get back in/);
  const two = { ...lapsed, target: { weightKg: null, date: null, weeklySessions: 2, weeklyDistanceKm: null } };
  assert.doesNotMatch(goalOpenerLine({ ...two, lastSessionDaysAgo: 6 }, 'metric') ?? '', /get back in/);
  assert.match(goalOpenerLine({ ...two, lastSessionDaysAgo: 7 }, 'metric') ?? '', /get back in/);
  // A lapse the card has no lift to date (no 'holding' lapse headline): no "Welcome back" either, a plain reset offer.
  const undated = gp({ goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 4, weeklyDistanceKm: null }, verdict: 'behind', headline: 'Sessions behind — 3 of 16 planned', lastSessionDaysAgo: 20 });
  assert.equal(requiredOpenerLine(undated, 'muscle', 'metric'), "It's been 20 days since your last session. Want a quick reset plan?");
});

test('muscle opener: "Welcome back" is for the first session after a break, and only then (wave 21)', () => {
  const back = (over: Partial<GoalProgress> = {}) => gp({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 4, weeklyDistanceKm: null },
    verdict: 'building', headline: 'Building back — Squat est. 1RM 136 of 142 kg pre-break',
    lastSessionDaysAgo: 0, lastSessionOn: '2026-05-11',
    liftReturn: { exercise: 'squat', name: 'Squat', breakDays: 15, endedOn: '2026-05-10', preBreakKg: 141.8, recentKg: 135.7, pct: 95, regained: false },
    ...over,
  });
  const welcome = 'Welcome back — your first session after 15 days off. Want a quick plan to build back up?';
  assert.equal(requiredOpenerLine(back(), 'muscle', 'metric'), welcome);
  assert.equal(goalFallbackOpener(back(), 'muscle', 'metric'), welcome, 'ends in its own question: no second invitation');
  assert.equal(requiredOpenerLine(back({ lastSessionDaysAgo: 1 }), 'muscle', 'metric'), welcome); // the morning after, before a second session
  // The second session back, or two days on: the normal check-in.
  assert.equal(requiredOpenerLine(back({ lastSessionOn: '2026-05-12' }), 'muscle', 'metric'), 'Goal check-in: Building back — Squat est. 1RM 136 of 142 kg pre-break.');
  assert.doesNotMatch(requiredOpenerLine(back({ lastSessionDaysAgo: 2 }), 'muscle', 'metric') ?? '', /Welcome back/);
  // No break on record: no welcome.
  assert.doesNotMatch(requiredOpenerLine(back({ liftReturn: null }), 'muscle', 'metric') ?? '', /Welcome back/);
});
