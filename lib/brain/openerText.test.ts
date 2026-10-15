import assert from 'node:assert/strict';
import test from 'node:test';
import { goalFallbackOpener, goalOpenerLine, newUserGoalOpener, requiredOpenerLine, returningUserOpener } from './openerText';
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
  // A headline that ends in a full stop (the break line) gets exactly one.
  const brk = gp({
    goal: 'endurance', target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    current: { weightKg: 70, startWeightKg: null, changeKg: null, progressPct: null },
    verdict: 'building', headline: 'On a break — 7 days since your last run. Restart at ~15 km.',
  });
  assert.equal(goalOpenerLine(brk, 'metric'), 'Goal check-in: On a break — 7 days since your last run. Restart at ~15 km.');
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
  const line = "You've reached 76 kg — want to set a new target or switch to maintenance?";
  assert.equal(goalOpenerLine(reached, 'metric'), line);
  assert.equal(requiredOpenerLine(reached, 'weight_loss', 'metric'), line);
  assert.equal(goalFallbackOpener(reached, 'weight_loss', 'metric'), line);
  assert.equal(goalOpenerLine(reached, 'imperial'), "You've reached 167.6 lb — want to set a new target or switch to maintenance?");
  // Muscle goals reach a weight target the same way.
  assert.match(goalOpenerLine({ ...reached, goal: 'muscle' }, 'metric') ?? '', /^You've reached 76 kg/);
});

// ── Wave 19b: a lifter who has already logged sessions is not "yet to log a few days" ──

test('muscle opener after the first sessions: says how many are in and when the first lift comparison lands', () => {
  const gp = {
    goal: 'muscle', verdict: 'insufficient_data', headline: 'First lift comparison on Mar 30 · 4 of 4 sessions so far',
    target: { weightKg: null, date: null, weeklySessions: 4, weeklyDistanceKm: null },
    dataSufficiency: { weighIns: 3, needed: 3, sessionsLast28d: 4 },
  } as unknown as Parameters<typeof newUserGoalOpener>[1];
  assert.equal(newUserGoalOpener('muscle', gp, 'metric'), "Your goal: 4 sessions a week. You've logged 4 sessions so far — your first lift comparison is on Mar 30.");
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
    "You're 1.7 of 7.7 kg down and losing about 0.6 kg a week.",
  );
});

test('early read: the amount down is the card\'s one progress weight (the weekly average), not the trend or the last reading, and says the pace is not read yet', () => {
  const early = gp({
    verdict: 'progressing', eta: null, current: { weightKg: 83.5, startWeightKg: 83.7, changeKg: -0.3, progressPct: 4 },
    weightRead: { ...READ, state: 'early', scaleKg: 83.0, weekMeanKg: 83.4 },
  });
  assert.equal(goalOpenerLine(early, 'metric'), "You're 0.3 of 7.7 kg down on the scale; your pace settles after 3 weeks.");
  assert.equal(goalOpenerLine(early, 'imperial'), "You're 0.7 of 17 lb down on the scale; your pace settles after 3 weeks.");
  // Without a weekly average (fewer than 3 weigh-ins that week) the latest scale reading is the progress weight.
  const sparse = gp({ ...early, weightRead: { ...READ, state: 'early', scaleKg: 83.0, weekMeanKg: null } });
  assert.equal(goalOpenerLine(sparse, 'metric'), "You're 0.7 of 7.7 kg down on the scale; your pace settles after 3 weeks.");
});

test('an older goal without a pace says a few more weigh-ins bring it back, not "settles after 3 weeks"', () => {
  const old = (goalAgeDays: number | null) => gp({
    verdict: 'progressing', eta: null, current: { weightKg: 83.5, startWeightKg: 83.7, changeKg: -0.3, progressPct: 4 },
    weightRead: { ...READ, state: 'early', scaleKg: 83.0, weekMeanKg: 83.4, goalAgeDays },
  });
  assert.equal(goalOpenerLine(old(84), 'metric'), "You're 0.3 of 7.7 kg down on the scale; a few more weigh-ins and your pace is back.");
  assert.equal(goalOpenerLine(old(21), 'metric'), "You're 0.3 of 7.7 kg down on the scale; a few more weigh-ins and your pace is back.");
  assert.equal(goalOpenerLine(old(20), 'metric'), "You're 0.3 of 7.7 kg down on the scale; your pace settles after 3 weeks.");
  assert.equal(goalOpenerLine(old(null), 'metric'), "You're 0.3 of 7.7 kg down on the scale; your pace settles after 3 weeks.");
});

test('a plateau and a weekly average: "down" is measured from the weekly average', () => {
  const plateau = gp({ verdict: 'holding', eta: null, weightRead: { ...READ, state: 'plateau', weekMeanKg: 81.4 } });
  assert.equal(goalOpenerLine(plateau, 'metric'), "You're 2.3 of 7.7 kg down, though the scale has been flat for 3 weeks.");
});

test('welcome back after a gap: leads with the change on the scale since the last weigh-in, until 3 weigh-ins are back', () => {
  const back = (weighInsSince: number) => gp({
    verdict: 'progressing', eta: null,
    weightRead: { ...READ, state: 'returning', scaleKg: 85.4, returned: { gapDays: 12, sinceDay: '2026-05-10', sinceKg: 86.5, weighInsSince } },
  });
  assert.equal(
    goalOpenerLine(back(1), 'metric'),
    'Welcome back — the scale is down 1.1 kg since May 10; keep weighing in so your trend catches up.',
  );
  assert.equal(requiredOpenerLine(back(1), 'weight_loss', 'metric'), goalOpenerLine(back(1), 'metric'));
  assert.equal(
    goalFallbackOpener(back(1), 'weight_loss', 'metric'),
    'Welcome back — the scale is down 1.1 kg since May 10; keep weighing in so your trend catches up. What would you like to dig into?',
  );
  assert.equal(
    goalOpenerLine({ ...back(1), weightRead: { ...back(1).weightRead!, returned: { gapDays: 12, sinceDay: '2026-05-10', sinceKg: 85.0, weighInsSince: 1 } } }, 'metric'),
    'Welcome back — the scale is up 0.4 kg since May 10; keep weighing in so your trend catches up.',
  );
  assert.equal(
    goalOpenerLine({ ...back(1), weightRead: { ...back(1).weightRead!, returned: { gapDays: 12, sinceDay: '2026-05-10', sinceKg: 86.5, weighInsSince: 1 } } }, 'imperial'),
    'Welcome back — the scale is down 2.4 lb since May 10; keep weighing in so your trend catches up.',
  );
  // Still returning on the second weigh-in back (the card's "returning" state lasts until 3 are back): not "pace settles after 3 weeks".
  assert.equal(
    goalOpenerLine(back(2), 'metric'),
    'Welcome back — the scale is down 1.1 kg since May 10; keep weighing in so your trend catches up.',
  );
});

test('reached: asks about a new target or maintenance in the first 3 days after reachedAt only, then reports where the weight holds', () => {
  const reached = (reachedDaysAgo: number | null) => gp({
    verdict: 'reached', headline: 'Goal reached — 76 kg', eta: null,
    current: { weightKg: 76.4, startWeightKg: 83.7, changeKg: -7.3, progressPct: 100 },
    weightRead: { ...READ, state: 'reached', weekMeanKg: 76.1, scaleKg: 76.3, reachedDaysAgo },
  });
  const ask = "You've reached 76 kg — want to set a new target or switch to maintenance?";
  assert.equal(goalOpenerLine(reached(0), 'metric'), ask);
  assert.equal(goalOpenerLine(reached(3), 'metric'), ask);
  assert.equal(goalFallbackOpener(reached(3), 'weight_loss', 'metric'), ask, 'it ends in its own question: no second invitation');
  assert.equal(goalOpenerLine(reached(4), 'metric'), 'Holding at 76.1 kg, within 1 kg of 76 kg.');
  assert.equal(goalOpenerLine(reached(10), 'imperial'), 'Holding at 167.8 lb, within 2.2 lb of 167.6 lb.');
  assert.equal(goalFallbackOpener(reached(10), 'weight_loss', 'metric'), 'Holding at 76.1 kg, within 1 kg of 76 kg. What would you like to dig into?');
  // Unknown crossing: no daily nag either.
  assert.equal(goalOpenerLine(reached(null), 'metric'), 'Holding at 76.1 kg, within 1 kg of 76 kg.');
  // Drifting well under the target says so instead.
  const under = gp({ ...reached(10), weightRead: { ...READ, state: 'reached', weekMeanKg: 74.2, reachedDaysAgo: 10 } });
  assert.equal(goalOpenerLine(under, 'metric'), 'At 74.2 kg, 1.8 kg under your 76 kg target.');
});
