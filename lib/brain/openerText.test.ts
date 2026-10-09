import assert from 'node:assert/strict';
import test from 'node:test';
import { goalFallbackOpener, goalOpenerLine, newUserGoalOpener, requiredOpenerLine } from './openerText';
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
