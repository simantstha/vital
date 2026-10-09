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
