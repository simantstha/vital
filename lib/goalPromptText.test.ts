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

test('week plan: the coach is told the week\'s ONE target for every plan kind', () => {
  const d = (plan: { kind: 'baseline' | 'build' | 'hold' | 'restart' | 'maintain' | 'rebuild'; targetKm: number | null; longRunKm: number | null }, stepTargetKm: number) => ({
    targetKm: 30, thisWeekKm: 8, avg4wKm: 24, weekStart: '2026-10-05', stepTargetKm, text: 'x', plan: { ...plan, purpose: 'x' },
  });
  const lines = (distance: ReturnType<typeof d>, units: 'metric' | 'imperial' = 'metric') =>
    formatGoalProgressLines(gp({ goal: 'endurance', distance }), units).join('\n');
  assert.match(lines(d({ kind: 'baseline', targetKm: null, longRunKm: null }, 30)), /- This week's target: none yet — a baseline week; next week's step is built from this week's total/);
  assert.match(lines(d({ kind: 'build', targetKm: 27, longRunKm: 14 }, 27)), /- This week's target: build to ~27\.0 km \(a safe ~10% step over last week; long run 14 km\); the 30\.0 km\/week goal comes after — do not push past the step this week/);
  assert.match(lines(d({ kind: 'maintain', targetKm: 30, longRunKm: 15 }, 30)), /- This week's target: hold the 30\.0 km\/week goal; long run 15 km \(the long run keeps growing ~2 km a week toward its peak\), the rest easy — the runner is at the goal, do not add volume/);
  assert.match(lines(d({ kind: 'hold', targetKm: 28, longRunKm: 12 }, 28)), /- This week's target: hold ~28\.0 km — last week was over the safe step; do not push higher or step up from the jump/);
  assert.match(lines(d({ kind: 'restart', targetKm: 15, longRunKm: 7 }, 15)), /- This week's target: restart at ~15\.0 km with easy runs; long run 7 km — the runner is coming back from a break; do not push toward the 30\.0 km\/week goal yet/);
  assert.match(lines(d({ kind: 'rebuild', targetKm: 14, longRunKm: null }, 14)), /- This week's target: rebuilding after the race, ~14\.0 km, easy runs; add about 10% a week/);
  // Imperial long runs are rounded to the nearest half mile.
  assert.match(lines(d({ kind: 'build', targetKm: 27, longRunKm: 17.7 }, 27), 'imperial'), /long run 11 mi/);
});

test('race day and race done: the coach is told to let them start relaxed, then to congratulate', () => {
  const distance = { targetKm: 30, thisWeekKm: 8, avg4wKm: 24, weekStart: '2026-10-05', stepTargetKm: 15, text: 'x' };
  const day = formatGoalProgressLines(gp({
    goal: 'endurance', distance,
    race: { date: '2026-10-11', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 0, phase: 'race_week' },
  }), 'metric').join('\n');
  assert.match(day, /- Race phase: race day — warm up easy and start relaxed; no training advice, no volume talk/);
  const done = formatGoalProgressLines(gp({
    goal: 'endurance', distance,
    race: { date: '2026-10-11', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 0, phase: 'race_week', completed: { km: 21.1, durationMin: 121 } },
  }), 'metric').join('\n');
  assert.match(done, /- Race phase: race day, and the race is DONE \(21\.1 km in 2:01\) — congratulate them; recovery starts now, no training advice/);
  const after = formatGoalProgressLines(gp({
    goal: 'endurance', distance,
    race: { date: '2026-10-11', distanceKm: 21.1, label: 'Half marathon', weeksToGo: 0, daysToGo: 0, phase: 'recovery', daysSince: 1, completed: { km: 21.1, durationMin: null } },
  }), 'metric').join('\n');
  assert.match(after, /- Race phase: just raced \(21\.1 km\) — congratulate them; recovery week 1 after the race/);
  assert.doesNotMatch(after, /in null|NaN/);
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
  assert.ok(taper.includes('- Race phase: taper — this week\'s target ~30.0 km; cut volume, keep the long run easy, plus 3×1 km at race pace midweek — do not push volume or build the long run'), taper.join('\n'));
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
  assert.match(metric.join('\n'), /- Long run \(running only\): longest run in the last 14 days 14\.0 km; 28-day peak 16\.0 km; peak target 18 km before the taper/);
  // The target is rounded to the nearest half mile ("11 mi", not "11.2 mi"); a measured run keeps its decimal.
  assert.match(formatGoalProgressLines(g, 'imperial').join('\n'), /last 14 days 8\.7 mi; 28-day peak 9\.9 mi; peak target 11 mi/);
  // The plan's next long run is quoted when there is one.
  const next = formatGoalProgressLines(gp({ goal: 'endurance', longRun: { lastKm: 14, peakKm: 16, targetPeakKm: 18, nextKm: 16 } }), 'metric').join('\n');
  assert.match(next, /longest run in the last 14 days 14\.0 km; next long run ~16 km; 28-day peak 16\.0 km/);
  // No race distance → no target clause.
  const noTarget = formatGoalProgressLines(gp({ goal: 'endurance', longRun: { lastKm: 14, peakKm: 16, targetPeakKm: null } }), 'metric').join('\n');
  assert.match(noTarget, /- Long run \(running only\): longest run in the last 14 days 14\.0 km; 28-day peak 16\.0 km$/m);
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

// ── Wave 19b: returning from a break, and the same lift as the card ─────────

test('returning from a break: the coach is told the lifts are rebuilding — no stall, no deload', () => {
  const lines = formatGoalProgressLines(gp({
    goal: 'muscle',
    verdict: 'building',
    headline: 'Building back — Squat est. 1RM 136 of 142 kg pre-break',
    reasons: [{ kind: 'lift', text: 'Squat est. 1RM 136 kg, 95% of your 142 kg pre-break best', tone: 'neutral' }],
    liftReturn: { exercise: 'squat', name: 'Squat', breakDays: 15, endedOn: '2026-05-10', preBreakKg: 142, recentKg: 136, pct: 95, regained: false },
  }), 'metric');
  assert.ok(lines.includes('- Returning from a 15-day break (ended 2026-05-10): lifts are rebuilding — do not call this a stall or suggest a deload.'), lines.join('\n'));
  // Right before the verdict, so the verdict is read in that light.
  assert.ok(lines.findIndex(l => l.startsWith('- Returning from')) < lines.findIndex(l => l.startsWith('- Verdict:')));
  // Once the pre-break best is regained the lifts are no longer "rebuilding".
  const back = formatGoalProgressLines(gp({
    goal: 'muscle',
    liftReturn: { exercise: 'squat', name: 'Squat', breakDays: 15, endedOn: '2026-05-10', preBreakKg: 142, recentKg: 145, pct: 102, regained: true },
  }), 'metric').join('\n');
  assert.doesNotMatch(back, /Returning from/);
  assert.doesNotMatch(formatGoalProgressLines(gp({ goal: 'muscle' }), 'metric').join('\n'), /Returning from/);
});

test('brief goal section: the lift lines lead with the card\'s headline lift (most-trained), the same number', () => {
  const wk = (weekStart: string, e: number, sessions: number, sets: number) => ({ weekStart, bestEstimatedOneRepMaxKg: e, volumeKg: 1, totalSets: sets, totalReps: sets * 5, sessions });
  const text = buildBriefGoalSection(
    {
      goal: 'muscle',
      progress: gp({ goal: 'muscle' }),
      todayKey: '2026-10-07',
      progression: {
        // Bench has far more SETS and the bigger drop; squat is trained in as many sessions and wins the tie by the fixed order.
        'bench press': [wk('2026-08-31', 100, 2, 20), wk('2026-09-14', 100, 2, 20), wk('2026-09-28', 94, 2, 20)],
        squat: [wk('2026-08-31', 120, 2, 5), wk('2026-09-14', 120, 2, 5), wk('2026-09-28', 118, 2, 5)],
      },
    },
    'metric',
  );
  const lines = text.split('\n').filter(l => /est\. 1RM/.test(l));
  assert.match(lines[0], /^- squat: est\. 1RM -2\.0 kg vs 4 weeks ago \(120 kg -> 118 kg\)$/);
  assert.match(lines[1], /^- bench press: est\. 1RM -6\.0 kg vs 4 weeks ago/);
});

// ── wave 19c: the coach reads the same pace and the same reads as the card ───

const WEIGHT_READ = { state: 'pace' as const, scaleKg: 81.6, scaleDay: '2026-10-06', weekMeanKg: 81.9, weeksVsTarget: null, returned: null, reachedDaysAgo: null };

test('coach lines label the trend as smoothed, add the scale and weekly average, and say what the rate is', () => {
  const text = formatGoalProgressLines(gp({ weightRead: WEIGHT_READ }), 'metric').join('\n');
  assert.match(text, /trend 82\.1 kg \(smoothed\)/);
  assert.match(text, /scale 81\.6 kg, weekly average 81\.9 kg/);
  assert.match(text, /rate -0\.45 kg\/wk \(-0\.55% bw\) over the last 3 weeks of weigh-ins/);
  const imperial = formatGoalProgressLines(gp({ weightRead: WEIGHT_READ }), 'imperial').join('\n');
  assert.match(imperial, /scale 179\.9 lb, weekly average 180\.6 lb/);
});

test('coach lines tell the coach not to quote a rate or a weeks-ahead call during an early read, and welcome a returning user', () => {
  const early = formatGoalProgressLines(gp({ eta: null, ratePerWeek: { kg: null, pctBodyweight: null }, verdict: 'progressing', headline: 'Early read — down 0.7 kg on the scale in 9 days', weightRead: { ...WEIGHT_READ, state: 'early' } }), 'metric').join('\n');
  assert.match(early, /Early read: the pace is not settled yet — quote the scale against the start, but no weekly rate, no projected date and no "weeks ahead\/behind"/);
  assert.doesNotMatch(early, /rate -/);
  assert.doesNotMatch(early, /ETA/);
  const back = formatGoalProgressLines(gp({ eta: null, weightRead: { ...WEIGHT_READ, state: 'returning' } }), 'metric').join('\n');
  assert.match(back, /back after a gap in weigh-ins: welcome them back/);
  const plateau = formatGoalProgressLines(gp({ eta: null, weightRead: { ...WEIGHT_READ, state: 'plateau' } }), 'metric').join('\n');
  assert.match(plateau, /Plateau on the raw weekly averages \(flat for 3 weeks\): often water/);
});

// ── Wave 20b: when the lifter last trained ──────────────────────────────────

test('muscle: the coach is told when the last strength session was; a week or more ago it must not praise lift progress', () => {
  const muscle = (over: Partial<GoalProgress>) => gp({ goal: 'muscle', verdict: 'holding', headline: 'No sessions for 8 days — Squat was est. 1RM 142 kg, week of Apr 20', ...over });
  const lapsed = formatGoalProgressLines(muscle({ lastSessionDaysAgo: 8, lastSessionOn: '2026-04-25' }), 'metric');
  assert.ok(lapsed.includes('- Last strength session 8 days ago (Apr 25) — do not praise lift progress; ask about getting back in'), lapsed.join('\n'));
  // Right before the verdict, so the verdict is read in that light.
  assert.ok(lapsed.findIndex(l => l.startsWith('- Last strength session')) < lapsed.findIndex(l => l.startsWith('- Verdict:')));
  // 7 days is the first lapsed day; 6 is just the date.
  assert.match(formatGoalProgressLines(muscle({ lastSessionDaysAgo: 7, lastSessionOn: '2026-04-26' }), 'metric').join('\n'), /Last strength session 7 days ago \(Apr 26\) — do not praise lift progress/);
  const recent = formatGoalProgressLines(muscle({ lastSessionDaysAgo: 6, lastSessionOn: '2026-04-27' }), 'metric').join('\n');
  assert.match(recent, /^- Last strength session 6 days ago \(Apr 27\)$/m);
  assert.doesNotMatch(recent, /do not praise/);
  assert.match(formatGoalProgressLines(muscle({ lastSessionDaysAgo: 0, lastSessionOn: '2026-05-03' }), 'metric').join('\n'), /^- Last strength session today$/m);
  assert.match(formatGoalProgressLines(muscle({ lastSessionDaysAgo: 1, lastSessionOn: '2026-05-02' }), 'metric').join('\n'), /^- Last strength session yesterday \(May 2\)$/m);
  // No session in the last 28 days, or another goal: no line.
  assert.doesNotMatch(formatGoalProgressLines(muscle({ lastSessionDaysAgo: null }), 'metric').join('\n'), /Last strength session/);
  assert.doesNotMatch(formatGoalProgressLines(gp({ lastSessionDaysAgo: 9, lastSessionOn: '2026-04-25' }), 'metric').join('\n'), /Last strength session/);
});

// ── wave 20c: the coach plateau note leads with the logs, "since start" is the one progress weight, the pace window is honest ──

test('coach plateau note: with logged days over target it leads with the logs and does not blame water', () => {
  const intake = { avgKcal: 2157, targetKcal: 2000, loggedDays: 4, daysWithinTarget: 1, low: true };
  const over = formatGoalProgressLines(gp({ eta: null, weightRead: { ...WEIGHT_READ, state: 'plateau', intake } }), 'metric').join('\n');
  assert.match(over, /Plateau on the raw weekly averages \(flat for 3 weeks\) while the logged days ran over target \(averaging ~2160 vs 2000 kcal\): lead with the logs — getting back to target is the first lever, do not blame water\./);
  assert.doesNotMatch(over, /often water/);
  // On target (or no logs): the existing note, unchanged.
  const fine = formatGoalProgressLines(gp({ eta: null, weightRead: { ...WEIGHT_READ, state: 'plateau', intake: { ...intake, avgKcal: 1950, daysWithinTarget: 4, low: false } } }), 'metric').join('\n');
  assert.match(fine, /Plateau on the raw weekly averages \(flat for 3 weeks\): often water — not a failure/);
  assert.match(formatGoalProgressLines(gp({ eta: null, weightRead: { ...WEIGHT_READ, state: 'plateau', intake: null } }), 'metric').join('\n'), /often water/);
});

test('coach lines: "since start" for a fat-loss goal names its basis (the weekly average, else the latest scale reading)', () => {
  const withMean = formatGoalProgressLines(gp({ weightRead: WEIGHT_READ }), 'metric').join('\n');
  assert.match(withMean, /since start at [\d.]+ kg \(weekly average\)/);
  const noMean = formatGoalProgressLines(gp({ weightRead: { ...WEIGHT_READ, weekMeanKg: null } }), 'metric').join('\n');
  assert.match(noMean, /since start at [\d.]+ kg \(latest scale reading\)/);
  // Other goals are untouched.
  assert.doesNotMatch(formatGoalProgressLines(gp({ goal: 'muscle', weightRead: WEIGHT_READ }), 'metric').join('\n'), /weekly average\)/);
});

test('coach lines: the pace window is 3 weeks, or 4 while a gap in weigh-ins is bridged', () => {
  assert.match(formatGoalProgressLines(gp({ weightRead: { ...WEIGHT_READ, paceWindowDays: 21 } }), 'metric').join('\n'), /over the last 3 weeks of weigh-ins/);
  assert.match(formatGoalProgressLines(gp({ weightRead: { ...WEIGHT_READ, paceWindowDays: 28 } }), 'metric').join('\n'), /over the last 4 weeks of weigh-ins/);
});
