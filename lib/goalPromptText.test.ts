import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBriefGoalSection, formatGoalProgressLines } from './goalPromptText';
import type { GoalProgress } from './goalProgress';

function gp(over: Partial<GoalProgress> = {}): GoalProgress {
  return {
    goal: 'weight_loss',
    target: { weightKg: 76, date: '2026-12-25', weeklySessions: 4, weeklyDistanceKm: null },
    distance: null,
    current: { weightKg: 82.1, startWeightKg: 85, changeKg: -2.9, progressPct: 32 },
    ratePerWeek: { kg: -0.45, pctBodyweight: -0.55 },
    safeBand: { minPct: 0.25, maxPct: 1 },
    eta: '2026-12-10',
    onPaceForTargetDate: true,
    verdict: 'on_track',
    headline: 'On track — about 6.1 kg to go, around Dec 10',
    reasons: [
      { kind: 'rate', text: 'Losing 0.45 kg a week, inside the safe band', tone: 'good' },
      { kind: 'calorie_adherence', text: 'Within calories on 5 of 7 logged days', tone: 'neutral' },
      { kind: 'under_eating', text: 'Two days well under your floor', tone: 'watch' },
    ],
    dataSufficiency: { weighIns: 20, needed: 3, sessionsLast28d: 12 },
    ...over,
  };
}

test('formatGoalProgressLines quotes verdict, headline, rate, ETA and reasons in kg, within ~12 lines', () => {
  const lines = formatGoalProgressLines(gp(), 'metric');
  const text = lines.join('\n');
  assert.ok(lines.length <= 12, `got ${lines.length} lines`);
  assert.match(text, /Goal: fat loss; target 76\.0 kg, by 2026-12-25, 4 sessions\/week/);
  assert.match(text, /trend 82\.1 kg/);
  assert.match(text, /rate -0\.45 kg\/wk \(-0\.55% bw\)/);
  assert.match(text, /ETA 2026-12-10/);
  assert.match(text, /Verdict: on_track — "On track — about 6\.1 kg to go, around Dec 10"/);
  assert.match(text, /Two days well under your floor \(watch\)/);
});

test('formatGoalProgressLines converts weights to lb for imperial users', () => {
  const text = formatGoalProgressLines(gp(), 'imperial').join('\n');
  assert.match(text, /target 167\.6 lb/); // 76 kg
  assert.match(text, /trend 181\.0 lb/); // 82.1 kg
  assert.match(text, /rate -0\.99 lb\/wk/); // -0.45 kg
  assert.doesNotMatch(text, /82\.1 kg/);
});

test('a user with no target sees "no target set" and the needs_target hint', () => {
  const text = formatGoalProgressLines(
    gp({
      target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: null },
      current: { weightKg: null, startWeightKg: null, changeKg: null, progressPct: null },
      ratePerWeek: { kg: null, pctBodyweight: null },
      eta: null,
      onPaceForTargetDate: null,
      verdict: 'needs_target',
      headline: 'Set a target weight to track your fat-loss progress',
      reasons: [],
    }),
    'metric',
  ).join('\n');
  assert.match(text, /no target set/);
  assert.match(text, /Verdict: needs_target/);
  assert.match(text, /No target set yet/);
  assert.doesNotMatch(text, /Now:/);
});

test('brief goal section: fat loss centers on the verdict, with no lift or volume blocks', () => {
  const text = buildBriefGoalSection({ goal: 'weight_loss', progress: gp() }, 'metric');
  assert.match(text, /## Goal Progress \(fat loss\)/);
  assert.match(text, /Verdict: on_track/);
  assert.match(text, /calorie adherence/);
  assert.doesNotMatch(text, /Lift progression/);
  assert.doesNotMatch(text, /Weekly training volume/);
});

test('brief goal section: muscle lists top lifts with e1RM change in the user\'s unit', () => {
  const text = buildBriefGoalSection(
    {
      goal: 'muscle',
      progress: gp({ goal: 'muscle' }),
      todayKey: '2026-10-07',
      progression: {
        'Back Squat': [
          { weekStart: '2026-08-31', bestEstimatedOneRepMaxKg: 100, volumeKg: 1, totalSets: 4, totalReps: 20 },
          { weekStart: '2026-09-28', bestEstimatedOneRepMaxKg: 110, volumeKg: 1, totalSets: 4, totalReps: 20 },
        ],
        'Bench Press': [
          { weekStart: '2026-09-27', bestEstimatedOneRepMaxKg: 80, volumeKg: 1, totalSets: 3, totalReps: 15 },
        ],
      },
    },
    'imperial',
  );
  assert.match(text, /Lift progression/);
  // +10 kg vs 4 weeks ago, same definition as lib/liftChange.ts (22.0 lb).
  assert.match(text, /Back Squat: est\. 1RM \+22\.0 lb vs 4 weeks ago \(220 lb -> 243 lb\)/);
  assert.match(text, /Bench Press: est\. 1RM 176 lb \(no 4-week comparison yet\)/);
  assert.match(text, /protein/);
});

test('brief goal section: endurance lists all-sport weekly volume', () => {
  const text = buildBriefGoalSection(
    {
      goal: 'endurance',
      progress: gp({ goal: 'endurance' }),
      weeklyVolume: [{ weekStart: '2026-10-04', sessions: 3, minutes: 140 }],
    },
    'metric',
  );
  assert.match(text, /Weekly training volume, any sport/);
  assert.match(text, /week of 2026-10-04: 3 sessions, 140 min/);
});

test('brief goal section: general stays on consistency and never invites a weight verdict', () => {
  const text = buildBriefGoalSection({ goal: 'general', progress: gp({ goal: 'general', verdict: 'building' }) }, 'metric');
  assert.match(text, /consistency/);
});

test('brief goal section: a missing verdict is stated as unavailable, never invented', () => {
  const text = buildBriefGoalSection({ goal: 'weight_loss', progress: null }, 'metric');
  assert.match(text, /unavailable right now/);
  assert.doesNotMatch(text, /Verdict:/);
});

test('endurance distance target and this-week progress are quoted unit-aware', () => {
  const g = gp({
    goal: 'endurance',
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    distance: { targetKm: 30, thisWeekKm: 8, avg4wKm: 24.5, weekStart: '2026-10-05', stepTargetKm: 30, text: '8 of 30 km this week' },
  });
  const metric = formatGoalProgressLines(g, 'metric').join('\n');
  assert.match(metric, /30\.0 km\/week/);
  assert.match(metric, /8 of 30 km this week/);
  const imperial = formatGoalProgressLines(g, 'imperial').join('\n');
  assert.match(imperial, /18\.6 mi\/week/);
});

test('endurance step below the goal: the coach is told this week\'s target, unit-aware; none when the step is the goal', () => {
  const g = gp({
    goal: 'endurance',
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    distance: { targetKm: 30, thisWeekKm: 22.7, avg4wKm: 22.6, weekStart: '2026-10-05', stepTargetKm: 27, text: '22.7 of ~27 km running this week · goal 30 km' },
  });
  const metric = formatGoalProgressLines(g, 'metric');
  assert.ok(
    metric.includes("- This week's target: build to ~27.0 km (a safe ~10% step over last week); the 30.0 km/week goal comes after — do not push past the step this week"),
    metric.join('\n'),
  );
  assert.match(metric.join('\n'), /22\.7 of ~27 km running this week · goal 30 km/);
  assert.match(formatGoalProgressLines(g, 'imperial').join('\n'), /build to ~16\.8 mi .* the 18\.6 mi\/week goal comes after/);
  const atGoal = formatGoalProgressLines({ ...g, distance: { ...g.distance!, stepTargetKm: 30 } }, 'metric').join('\n');
  assert.doesNotMatch(atGoal, /This week's target/);
});

test('formatGoalProgressLines includes the race countdown when present', () => {
  const text = formatGoalProgressLines(
    gp({ goal: 'endurance', race: { date: '2026-12-30', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 12, daysToGo: 84 } }),
    'metric',
  ).join('\n');
  assert.match(text, /- Race: Half marathon on 2026-12-30 \(in 12 weeks\)/);
  assert.doesNotMatch(formatGoalProgressLines(gp(), 'metric').join('\n'), /Race:/);
  // Build phase: no phase line.
  const build = formatGoalProgressLines(
    gp({ goal: 'endurance', race: { date: '2026-12-30', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 12, daysToGo: 84, phase: 'build' } }),
    'metric',
  ).join('\n');
  assert.doesNotMatch(build, /Race phase:/);
});

test('race lifecycle: taper / race week / recovery each get ONE phase line with the target, and no "build to" step', () => {
  const distance = { targetKm: 50, thisWeekKm: 8, avg4wKm: 30, weekStart: '2026-10-05', stepTargetKm: 30, text: '8 of ~30 km running this week · goal 50 km' };
  const taper = formatGoalProgressLines(gp({
    goal: 'endurance',
    distance,
    race: { date: '2026-10-22', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 3, daysToGo: 17, phase: 'taper' },
  }), 'metric');
  assert.equal(taper.filter(l => l.startsWith('- Race phase')).length, 1);
  assert.ok(taper.includes('- Race phase: taper — this week\'s target ~30.0 km; cut volume, keep a little intensity — do not push volume or build the long run'), taper.join('\n'));
  assert.doesNotMatch(taper.join('\n'), /build to|This week's target/);

  const raceWeek = formatGoalProgressLines(gp({
    goal: 'endurance',
    distance: { ...distance, stepTargetKm: 16 },
    race: { date: '2026-10-09', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 3, phase: 'race_week' },
  }), 'metric').join('\n');
  assert.match(raceWeek, /- Race: Half marathon on 2026-10-09 \(in 3 days\)/);
  assert.match(raceWeek, /- Race phase: race week — ~16\.0 km before the race at most; short easy runs, rest 1–2 days before race day — no new volume or hard sessions/);

  const recovery = formatGoalProgressLines(gp({
    goal: 'endurance',
    distance: { ...distance, stepTargetKm: 16 },
    race: { date: '2026-10-03', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 0, phase: 'recovery', daysSince: 3 },
  }), 'imperial').join('\n');
  assert.match(recovery, /- Race: Half marathon on 2026-10-03 \(done 3 days ago\)/);
  assert.match(recovery, /- Race phase: recovery week 1 after the race — easy only, up to 9\.9 mi; do not push volume or intensity — the next step is a new goal/);
  assert.doesNotMatch(recovery, /in 0 days|today/);

  // Without a weekly distance goal the phase line carries no number.
  const noDistance = formatGoalProgressLines(gp({
    goal: 'endurance',
    race: { date: '2026-10-22', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 3, daysToGo: 17, phase: 'taper' },
  }), 'metric').join('\n');
  assert.match(noDistance, /- Race phase: taper; cut volume/);
});

test('formatGoalProgressLines adds one long-run line (unit-aware) only when long-run data exists', () => {
  const g = gp({
    goal: 'endurance',
    longRun: { lastKm: 14, peakKm: 16, targetPeakKm: 18 },
  });
  const metric = formatGoalProgressLines(g, 'metric');
  assert.equal(metric.filter(l => l.startsWith('- Long run')).length, 1);
  assert.match(metric.join('\n'), /- Long run \(running only\): last 14\.0 km; 28-day peak 16\.0 km; peak target 18\.0 km before the taper/);
  assert.match(formatGoalProgressLines(g, 'imperial').join('\n'), /last 8\.7 mi; 28-day peak 9\.9 mi; peak target 11\.2 mi/);
  // No race distance → no target clause.
  const noTarget = formatGoalProgressLines(gp({ goal: 'endurance', longRun: { lastKm: 14, peakKm: 16, targetPeakKm: null } }), 'metric').join('\n');
  assert.match(noTarget, /- Long run \(running only\): last 14\.0 km; 28-day peak 16\.0 km$/m);
  assert.doesNotMatch(formatGoalProgressLines(gp(), 'metric').join('\n'), /Long run/);
});

test('a reached goal tells the coach the next step is a new target or maintenance', () => {
  const text = formatGoalProgressLines(
    gp({
      verdict: 'reached',
      headline: 'Goal reached — 76 kg (Sep 20)',
      eta: null,
      current: { weightKg: 75.6, startWeightKg: 85, changeKg: -9.4, progressPct: 100 },
      reasons: [
        { kind: 'reached', text: 'Trend weight 75.6 kg is at or past your 76 kg target', tone: 'good' },
        { kind: 'next_step', text: 'Set a new target or switch to maintenance', tone: 'neutral' },
      ],
    }),
    'metric',
  ).join('\n');
  assert.match(text, /Verdict: reached — "Goal reached — 76 kg \(Sep 20\)"/);
  assert.match(text, /Set a new target or switch to maintenance/);
  assert.match(text, /Target reached — the next step is a new target or maintenance/);
  assert.doesNotMatch(formatGoalProgressLines(gp(), 'metric').join('\n'), /Target reached/);
});
