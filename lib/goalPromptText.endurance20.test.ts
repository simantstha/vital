/** Wave 20a — the coach's endurance lines: race eve, the next-goal nudge, the cap note. (Own file: the older tests stay untouched.) */
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGoalProgressLines } from './goalPromptText';
import type { GoalProgress } from './goalProgress';

function gp(over: Partial<GoalProgress> = {}): GoalProgress {
  return {
    goal: 'endurance',
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    distance: { targetKm: 30, thisWeekKm: 8, avg4wKm: 24, weekStart: '2026-10-05', stepTargetKm: 15, text: 'x' },
    current: { weightKg: null, startWeightKg: null, changeKg: null, progressPct: null },
    ratePerWeek: { kg: null, pctBodyweight: null },
    safeBand: null,
    eta: null,
    onPaceForTargetDate: null,
    verdict: 'on_track',
    headline: 'h',
    reasons: [],
    dataSufficiency: { weighIns: 0, needed: 3, sessionsLast28d: 12 },
    ...over,
  };
}

const lines = (g: GoalProgress, units: 'metric' | 'imperial' = 'metric'): string => formatGoalProgressLines(g, units).join('\n');

test('race eve: the coach is told rest or a shakeout, and not to talk about the week\'s km', () => {
  const text = lines(gp({ race: { date: '2026-10-11', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 1, phase: 'race_week' } }));
  assert.match(text, /- Race phase: race tomorrow — rest or a 15-min shakeout; lay out your kit; no training advice, no volume talk, no remarks about this week's km/);
  assert.doesNotMatch(text, /before the race at most/);
});

test('recovery: the next-goal nudge is week 1 only and never offers a weekly distance target the runner has', () => {
  const recovery = (daysSince: number, weeklyDistanceKm: number | null) => lines(gp({
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm },
    race: { date: '2026-10-01', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 0, phase: 'recovery', daysSince },
  }));
  assert.match(recovery(3, 30), /recovery week 1 after the race — easy only, up to 15\.0 km; do not push volume or intensity — the next step is a new goal \(a new race or maintenance\)/);
  assert.match(recovery(3, null), /\(a new race, a weekly distance target, or maintenance\)/);
  assert.match(recovery(10, 30), /recovery week 2 after the race — easy only, up to 15\.0 km; do not push volume or intensity$/m);
  assert.doesNotMatch(recovery(10, null), /next step is a new goal/);
});

test('the long-run line names the cap once: what fits and what would carry the race peak', () => {
  const text = lines(gp({
    race: { date: '2026-12-30', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 12, daysToGo: 84, phase: 'build' },
    longRun: { lastKm: 12, peakKm: 12, targetPeakKm: 15, raceTargetKm: 18, nextKm: 14 },
  }));
  assert.match(text, /peak target 15 km before the taper \(your 30 km weeks fit a 15 km long run; for an 18 km peak, raise the goal to ~36 km\)/);
  const fits = lines(gp({
    race: { date: '2026-12-30', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 12, daysToGo: 84, phase: 'build' },
    longRun: { lastKm: 12, peakKm: 12, targetPeakKm: 18, nextKm: 14 },
  }));
  assert.doesNotMatch(fits, /raise the goal/);
});
