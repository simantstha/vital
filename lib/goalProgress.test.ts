import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeGoalProgress as computeGoalProgressRaw,
  HEADLINE_MAX_CHARS,
  isRunningWorkoutType,
  isStrengthWorkoutType,
  longRunTargetKm,
  mixedReturnLead,
  raceLabel,
  weekFitsSessionTarget,
  type GoalProgress,
  type GoalProgressInput,
} from './goalProgress';
import { NBSP, plainSpaces } from './displayText';
import { detectStalledLift } from './insights/goalDetectors';
import { computeWeightTrend, type WeightReading } from './weightTrend';
import type { ProgressionSummary } from './workoutRepository';

const TODAY = '2026-10-06';

/**
 * Display copy glues numbers to their units (and "a → b" pairs) with U+00A0 so
 * a narrow line never wraps mid-value. These tests read the copy with plain
 * spaces; the NBSP tests at the end of the file assert the raw output.
 */
function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  return JSON.parse(plainSpaces(JSON.stringify(computeGoalProgressRaw(input)))) as GoalProgress;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** One reading a day for the last `n` days (oldest first), kg following `kgAt(i)` with i = 0 oldest. */
function series(n: number, kgAt: (i: number) => number): WeightReading[] {
  return Array.from({ length: n }, (_, i) => {
    const day = addDays(TODAY, -(n - 1 - i));
    return { measuredAt: `${day}T08:00:00.000Z`, valueKg: kgAt(i), source: 'manual' as const, localDay: day };
  });
}

/** Steady change of `kgPerDay` over `n` days, ending near `endKg`. */
function ramp(n: number, startKg: number, kgPerDay: number): WeightReading[] {
  return series(n, i => startKg + kgPerDay * i);
}

function base(over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return {
    goal: 'weight_loss',
    todayKey: TODAY,
    target: { weightKg: null, date: null, weeklySessions: null },
    start: { weightKg: null, startedAt: null },
    weightReadings: [],
    intakeDays: [],
    budget: null,
    progression: {},
    trainingDays: [],
    workouts: [],
    restingHr: [],
    hrv: [],
    sleepMinutes: [],
    sleepGoalMinutes: 480,
    ...over,
  };
}

function assertWellFormed(p: GoalProgress): void {
  assert.ok(p.headline.length > 0 && p.headline.length <= HEADLINE_MAX_CHARS, `headline length: "${p.headline}"`);
  assert.ok(p.reasons.length <= 3, 'at most 3 reasons');
  for (const r of p.reasons) {
    assert.ok(['good', 'watch', 'neutral'].includes(r.tone));
    assert.ok(r.text.length > 0 && r.kind.length > 0);
  }
}

// ── Fat loss ────────────────────────────────────────────────────────────────

test('weight_loss with no target weight → needs_target inviting the user to set one', () => {
  const p = computeGoalProgress(base({ weightReadings: ramp(40, 90, -0.07) }));
  assert.equal(p.verdict, 'needs_target');
  assert.match(p.headline, /Set a target weight/);
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assertWellFormed(p);
});

test('weight_loss with too few weigh-ins → insufficient_data and no ETA', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 80, date: addDays(TODAY, 120), weeklySessions: null },
    weightReadings: series(2, i => 90 - i),
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assert.equal(p.ratePerWeek.kg, null);
  assert.equal(p.dataSufficiency.weighIns, 2);
  assert.equal(p.dataSufficiency.needed, 3);
  assertWellFormed(p);
});

test('weight_loss with 3 weigh-ins spanning under 7 days → insufficient_data, no ETA', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 80, date: null, weeklySessions: null },
    weightReadings: series(5, i => 90 - i * 0.3),
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.eta, null);
});

test('weight_loss losing at a safe pace: on_track / ahead / behind hinge on ETA vs target date', () => {
  const readings = ramp(60, 95, -0.07); // ~0.5 kg/wk
  const target = { weightKg: 85, weeklySessions: null };

  const noDate = computeGoalProgress(base({ weightReadings: readings, target: { ...target, date: null } }));
  assert.ok(noDate.eta, 'expected an ETA');
  assert.ok(noDate.ratePerWeek.kg! < 0);
  assert.ok(noDate.ratePerWeek.pctBodyweight! < 0);
  assert.deepEqual(noDate.safeBand, { minPct: 0.25, maxPct: 1.0 });
  assert.equal(noDate.verdict, 'on_track');
  assert.equal(noDate.onPaceForTargetDate, null);
  assert.match(noDate.headline, /^On track — about [\d.]+ kg to go, around \w{3} \d+/);
  assertWellFormed(noDate);

  const eta = noDate.eta!;
  const onTrack = computeGoalProgress(base({ weightReadings: readings, target: { ...target, date: addDays(eta, 3) } }));
  assert.equal(onTrack.verdict, 'on_track');
  assert.equal(onTrack.onPaceForTargetDate, true);

  const ahead = computeGoalProgress(base({ weightReadings: readings, target: { ...target, date: addDays(eta, 60) } }));
  assert.equal(ahead.verdict, 'ahead');
  assert.equal(ahead.onPaceForTargetDate, true);
  assert.match(ahead.headline, /^Ahead of pace/);

  // Behind by 40 days (under 8 weeks): the projected date is stated.
  const behind = computeGoalProgress(base({ weightReadings: readings, target: { ...target, date: addDays(eta, -40) } }));
  assert.equal(behind.verdict, 'behind');
  assert.equal(behind.onPaceForTargetDate, false);
  assert.equal(behind.eta, eta);
  assertWellFormed(behind);

  // Wave 21w: more than 8 weeks past the target date (here 60 days) the projection is not quoted: the date won't hold.
  const far = computeGoalProgress(base({ weightReadings: readings, target: { ...target, date: addDays(eta, -60) } }));
  assert.equal(far.verdict, 'behind');
  assert.equal(far.onPaceForTargetDate, false);
  assert.equal(far.eta, null);
  assert.match(far.headline, /^Behind pace — at this rate the \w{3} \d{1,2}(, \d{4})? date won't hold$/);
  assertWellFormed(far);
});

test('weight_loss losing above 1%/wk → too_fast', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 75, date: null, weeklySessions: null },
    weightReadings: ramp(60, 100, -0.17), // ~1.2 kg/wk on ~90 kg ≈ 1.3%/wk
  }));
  assert.equal(p.verdict, 'too_fast');
  assert.ok(Math.abs(p.ratePerWeek.pctBodyweight!) > 1);
  assert.match(p.headline, /Losing too fast/);
  assertWellFormed(p);
});

test('weight_loss flat scale for 2+ weeks → stalled, no ETA', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 78, date: addDays(TODAY, 90), weeklySessions: null },
    weightReadings: series(15, () => 85),
  }));
  assert.equal(p.verdict, 'stalled');
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assertWellFormed(p);
});

test('weight_loss with weight trending the WRONG way → no ETA, never on_track', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 78, date: addDays(TODAY, 90), weeklySessions: null },
    weightReadings: ramp(45, 84, 0.06), // gaining ~0.4 kg/wk
  }));
  assert.equal(p.eta, null);
  assert.equal(p.verdict, 'behind');
  assert.equal(p.onPaceForTargetDate, false);
  assert.ok(p.ratePerWeek.kg! > 0);
  assertWellFormed(p);
});

test('weight_loss already at/below target → reached ("Goal reached"), progress 100%', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 86, date: null, weeklySessions: null },
    start: { weightKg: 92, startedAt: '2026-08-01T00:00:00.000Z' },
    weightReadings: ramp(40, 88, -0.07),
  }));
  assert.equal(p.verdict, 'reached');
  assert.match(p.headline, /^Goal reached — 86 kg/);
  assert.equal(p.current.progressPct, 100);
  assert.equal(p.eta, null);
  assertWellFormed(p);
});

test('current.* is derived from the trend and the stored start weight', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 80, date: null, weeklySessions: null },
    start: { weightKg: 95, startedAt: '2026-08-01T00:00:00.000Z' },
    weightReadings: ramp(60, 95, -0.07),
  }));
  assert.equal(p.current.startWeightKg, 95);
  assert.ok(p.current.weightKg! < 95);
  assert.ok(p.current.changeKg! < 0);
  assert.ok(p.current.progressPct! > 0 && p.current.progressPct! < 100);
});

test('start weight unknown → changeKg and progressPct are null, never invented', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 80, date: null, weeklySessions: null },
    weightReadings: ramp(60, 95, -0.07),
  }));
  assert.equal(p.current.startWeightKg, null);
  assert.equal(p.current.changeKg, null);
  assert.equal(p.current.progressPct, null);
});

test('weight_loss reasons are grounded: calorie adherence + weekend overeating + learned TDEE (max 3)', () => {
  // 28 days of intake: weekdays 1,800, weekends 2,700 → weekend_overeating fires; last-7 mostly on target.
  const intakeDays = Array.from({ length: 28 }, (_, i) => {
    const day = addDays(TODAY, -(27 - i));
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const kcal = dow === 0 || dow === 6 ? 2700 : 1800;
    return { day, kcal, proteinG: 120, source: 'logged' as const };
  });
  const p = computeGoalProgress(base({
    target: { weightKg: 85, date: null, weeklySessions: null },
    weightReadings: ramp(60, 95, -0.07),
    intakeDays,
    budget: {
      targetKcal: 1900, proteinG: 150, floorKcal: 1500,
      formulaTdee: 2600, learnedTdee: 2350, tdeeConfidence: 'high',
    },
  }));
  assert.equal(p.reasons.length, 3);
  assert.equal(p.reasons[0].kind, 'rate');
  const kinds = p.reasons.map(r => r.kind);
  assert.ok(kinds.includes('weekend_overeating'), `kinds: ${kinds}`);
  const weekend = p.reasons.find(r => r.kind === 'weekend_overeating')!;
  assert.match(weekend.text, /2,700 kcal vs 1,800/);
  assert.equal(weekend.tone, 'watch');
  assertWellFormed(p);
});

test('learned-vs-formula TDEE reason cites both numbers when confidence is medium+', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 85, date: null, weeklySessions: null },
    weightReadings: ramp(60, 95, -0.07),
    budget: { targetKcal: 1900, proteinG: 150, floorKcal: 1500, formulaTdee: 2600, learnedTdee: 2350, tdeeConfidence: 'medium' },
  }));
  const tdee = p.reasons.find(r => r.kind === 'tdee');
  assert.ok(tdee);
  assert.match(tdee!.text, /2,350/);
  assert.match(tdee!.text, /2,600/);
});

// ── Muscle ──────────────────────────────────────────────────────────────────

function lifts(prior: number, recent: number): ProgressionSummary {
  // Five steady weeks per lift (no break), so a flat lift is a real stall; Bench Press is the most-trained lift (3 sessions a week vs 2).
  const wk = (weekStart: string, e: number, sessions: number) => ({
    weekStart, bestEstimatedOneRepMaxKg: e, volumeKg: 1000, totalSets: 6, totalReps: 36, sessions,
  });
  const weeks = (a: number, b: number, sessions: number) => [
    wk('2026-09-07', a, sessions), wk('2026-09-14', a, sessions), wk('2026-09-21', b, sessions),
    wk('2026-09-28', b, sessions), wk('2026-10-05', b, sessions),
  ];
  return {
    'Bench Press': weeks(prior, recent, 3),
    Squat: weeks(140, recent > prior ? 145 : 140, 2),
  };
}

test('muscle with neither a weekly-sessions nor a weight target → needs_target', () => {
  const p = computeGoalProgress(base({ goal: 'muscle', progression: lifts(100, 105) }));
  assert.equal(p.verdict, 'needs_target');
  assertWellFormed(p);
});

test('muscle: a lift whose best e1RM beats its best from 4 weeks ago → progressing, with grounded lift reasons', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i * 2)),
    intakeDays: Array.from({ length: 7 }, (_, i) => ({ day: addDays(TODAY, -i), kcal: 2800, proteinG: 170, source: 'logged' as const })),
    budget: { targetKcal: 2800, proteinG: 170, floorKcal: 1500, formulaTdee: null, learnedTdee: null, tdeeConfidence: null },
  }));
  assert.equal(p.verdict, 'progressing');
  assert.match(p.headline, /Bench Press/);
  assert.deepEqual(p.safeBand, { minPct: 0.1, maxPct: 0.5 });
  const lift = p.reasons.find(r => r.kind === 'lift');
  assert.ok(lift);
  assert.match(lift!.text, /\+5 kg vs 4 weeks ago \(100 → 105 kg\)/);
  assert.equal(lift!.tone, 'good');
  const adherence = p.reasons.find(r => r.kind === 'adherence');
  assert.equal(adherence!.text, '12 of 16 planned sessions in 4 weeks (75%)');
  assert.equal(adherence!.tone, 'neutral');
  // Without a session target the older "averaging" wording is kept.
  const noTarget = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 85, date: null, weeklySessions: null },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i * 2)),
  }));
  assert.match(noTarget.reasons.find(r => r.kind === 'sessions')!.text, /3 sessions a week/);
  assert.ok(p.reasons.some(r => r.kind === 'protein' && /7 of 7/.test(r.text)));
  assertWellFormed(p);
});

test('muscle: no e1RM gain vs 4 weeks ago → stalled', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 3 },
    progression: lifts(100, 100),
  }));
  assert.equal(p.verdict, 'stalled');
  assert.match(p.headline, /no lift is up 1% on 4 weeks ago/i);
  assertWellFormed(p);
});

test('muscle: gaining weight faster than 0.5%/wk → too_fast', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 90, date: null, weeklySessions: 4 },
    weightReadings: ramp(60, 75, 0.1), // ~0.7 kg/wk on ~79 kg ≈ 0.9%/wk
    progression: lifts(100, 105),
  }));
  assert.equal(p.verdict, 'too_fast');
  assert.ok(p.ratePerWeek.pctBodyweight! > 0.5);
  assertWellFormed(p);
});

test('muscle: gaining inside the band with no lift data → progressing, ETA toward target weight', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 85, date: null, weeklySessions: 4 },
    weightReadings: ramp(60, 75, 0.04), // ~0.28 kg/wk ≈ 0.35%/wk
    trainingDays: Array.from({ length: 14 }, (_, i) => addDays(TODAY, -i * 2)), // 14 of 16 planned
  }));
  assert.equal(p.verdict, 'progressing');
  assert.ok(p.eta);
});

test('muscle: adherence reason reads "9 of 16 planned sessions in 4 weeks (56%)" and leads, in watch tone, below 60%', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 9 }, (_, i) => addDays(TODAY, -i * 3)),
  }));
  // 56% of planned sessions: lifts are up but the verdict is not the strongest positive.
  assert.equal(p.verdict, 'behind');
  assert.match(p.headline, /^Lifts up, sessions behind/);
  assert.equal(p.reasons[0].kind, 'adherence');
  assert.equal(p.reasons[0].text, '9 of 16 planned sessions in 4 weeks (56%)');
  assert.equal(p.reasons[0].tone, 'watch');
  assertWellFormed(p);
});

test('muscle: adherence 60-74% is a watch but does not lead; 75-89% neutral; 90%+ good', () => {
  const mk = (n: number) => computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: n }, (_, i) => addDays(TODAY, -i)),
  }));
  const mid = mk(11); // 69%
  assert.equal(mid.reasons.find(r => r.kind === 'adherence')!.tone, 'watch');
  assert.notEqual(mid.reasons[0].kind, 'adherence');
  assert.equal(mk(13).reasons.find(r => r.kind === 'adherence')!.tone, 'neutral'); // 81%
  assert.equal(mk(15).reasons.find(r => r.kind === 'adherence')!.tone, 'good'); // 94%
});

test('muscle: structured adherence {done, planned, weeklyTarget, pct} matches the adherence reason and the behind verdict', () => {
  const mk = (n: number) => computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: n }, (_, i) => addDays(TODAY, -i)), // inside the 28-day window
  }));
  const behind = mk(9);
  assert.equal(behind.verdict, 'behind');
  assert.deepEqual(behind.adherence, { done: 9, planned: 16, weeklyTarget: 4, pct: 56, windowDays: 28 });
  assert.equal(behind.reasons.find(r => r.kind === 'adherence')!.text, '9 of 16 planned sessions in 4 weeks (56%)');
  // Not behind: the numbers are still reported (the client only uses them for a behind verdict).
  const fine = mk(15);
  assert.equal(fine.verdict, 'progressing');
  assert.deepEqual(fine.adherence, { done: 15, planned: 16, weeklyTarget: 4, pct: 94, windowDays: 28 });
  // JSON survives the wire.
  assert.deepEqual(JSON.parse(JSON.stringify(behind)).adherence, { done: 9, planned: 16, weeklyTarget: 4, pct: 56, windowDays: 28 });
});

test('adherence is null without a weekly sessions target and for non-muscle goals', () => {
  const noTarget = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: 85, date: null, weeklySessions: null },
    progression: lifts(100, 105),
  }));
  assert.equal(noTarget.adherence, null);
  const endurance = computeGoalProgress(base({
    goal: 'endurance', target: { weightKg: null, date: null, weeklySessions: 4 },
    trainingDays: Array.from({ length: 6 }, (_, i) => addDays(TODAY, -i * 3)),
  }));
  assert.equal(endurance.adherence, null);
});

test('muscle: weight gain at/above the top of the band is a watch reason', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 90, date: null, weeklySessions: 4 },
    weightReadings: ramp(60, 75, 0.0675),
    progression: lifts(100, 105),
  }));
  assert.ok(p.ratePerWeek.pctBodyweight! >= 0.5, `rate ${p.ratePerWeek.pctBodyweight}`);
  const rate = p.reasons.find(r => r.kind === 'rate');
  assert.ok(rate, 'rate reason surfaced');
  assert.equal(rate!.tone, 'watch');
  assert.match(rate!.text, /above the 0\.5% of bodyweight a week that keeps gain lean/);
});

test('muscle: ETA toward the target weight when gaining inside the band', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 90, date: null, weeklySessions: 4 },
    weightReadings: ramp(60, 75, 0.04),
  }));
  assert.ok(p.eta, 'expected a muscle ETA');
  assert.ok(p.eta! > TODAY);
});

test('muscle: ETA is null when the gain is the wrong way or the target is already reached', () => {
  const wrong = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 85, date: null, weeklySessions: 4 },
    weightReadings: ramp(60, 80, -0.04),
  }));
  assert.equal(wrong.eta, null);
  const reached = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 75, date: null, weeklySessions: 4 },
    weightReadings: ramp(60, 75, 0.04),
  }));
  assert.equal(reached.eta, null);
});

test('muscle with a session target but no lifts and no weight data → insufficient_data', () => {
  const p = computeGoalProgress(base({ goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 4 } }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.eta, null);
  assertWellFormed(p);
});

// ── Endurance ───────────────────────────────────────────────────────────────

test('endurance with neither a sessions nor a distance target → needs_target', () => {
  const p = computeGoalProgress(base({ goal: 'endurance' }));
  assert.equal(p.verdict, 'needs_target');
  assert.match(p.headline, /weekly distance or session goal/);
  assert.equal(p.distance, null);
});

test('endurance with under 3 sessions in 28 days → insufficient_data', () => {
  const p = computeGoalProgress(base({
    goal: 'endurance',
    target: { weightKg: null, date: null, weeklySessions: 3 },
    trainingDays: [addDays(TODAY, -2)],
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.dataSufficiency.sessionsLast28d, 1);
});

function enduranceInput(sessionsPerWeekByWeek: number[], over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  const trainingDays: string[] = [];
  const workouts: Array<{ day: string; durationMin: number | null }> = [];
  sessionsPerWeekByWeek.forEach((n, wk) => {
    for (let k = 0; k < n; k++) {
      const day = addDays(TODAY, -(wk * 7 + k));
      trainingDays.push(day);
      workouts.push({ day, durationMin: 60 });
    }
  });
  return base({
    goal: 'endurance',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    trainingDays,
    workouts,
    ...over,
  });
}

test('endurance: recent 2 weeks well above the 2 before → building, with volume + resting HR + HRV reasons', () => {
  const restingHr = Array.from({ length: 28 }, (_, i) => ({ day: addDays(TODAY, -i), value: i < 14 ? 50 : 54 }));
  const hrv = Array.from({ length: 28 }, (_, i) => ({ day: addDays(TODAY, -i), value: i < 14 ? 70 : 60 }));
  const p = computeGoalProgress(enduranceInput([4, 3, 2, 2], { restingHr, hrv }));
  assert.equal(p.verdict, 'building');
  assert.match(p.headline, /^Building — time up \d+% \(last 2 weeks vs the 2 before\)/);
  assert.equal(p.reasons.length, 3);
  const kinds = p.reasons.map(r => r.kind);
  // Volume trend first (it drives the verdict), then the rest in priority order; nothing on watch here.
  assert.deepEqual(kinds, ['volume', 'week_sessions', 'resting_hr']);
  const rhr = p.reasons.find(r => r.kind === 'resting_hr')!;
  assert.match(rhr.text, /trending down: 54 → 50 bpm/);
  assert.equal(rhr.tone, 'good');
  assert.equal(p.eta, null);
  assert.equal(p.safeBand, null);
  assertWellFormed(p);
});

test('endurance: keeps the 4-week volume trend (with its window) first, then "N of T sessions this week" (Mon–today)', () => {
  // TODAY 2026-10-06 is a Tuesday: Monday 10-05 + Tuesday 10-06 = 2 sessions this week.
  const p = computeGoalProgress(enduranceInput([2, 3, 3, 3]));
  assert.equal(p.reasons[0].kind, 'volume');
  assert.match(p.reasons[0].text, /last 2 weeks vs the 2 before/);
  const sessions = p.reasons.find(r => r.kind === 'week_sessions');
  assert.equal(sessions?.text, '2 of 4 sessions this week');
});

test('endurance: steady volume → holding', () => {
  const p = computeGoalProgress(enduranceInput([3, 3, 3, 3]));
  assert.equal(p.verdict, 'holding');
  assert.match(p.headline, /^Holding steady — 3 sessions a week vs a target of 4/);
  assertWellFormed(p);
});

// ── General ─────────────────────────────────────────────────────────────────

test('general with almost no data → insufficient_data', () => {
  const p = computeGoalProgress(base({ goal: 'general' }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.eta, null);
  assertWellFormed(p);
});

function generalInput(recentDays: number, priorDays: number): GoalProgressInput {
  const mk = (from: number, n: number) => Array.from({ length: n }, (_, i) => addDays(TODAY, -(from + i)));
  const active = [...mk(0, recentDays), ...mk(14, priorDays)];
  return base({
    goal: 'general',
    trainingDays: active,
    intakeDays: active.map(day => ({ day, kcal: 2000, proteinG: 100, source: 'logged' as const })),
    sleepMinutes: active.map(day => ({ day, value: 470 })),
  });
}

test('general: habits clearly up on the previous 2 weeks → building, with activity/sleep/logging reasons', () => {
  const p = computeGoalProgress(generalInput(11, 4));
  assert.equal(p.verdict, 'building');
  assert.deepEqual(p.reasons.map(r => r.kind), ['activity', 'sleep', 'logging']);
  assert.match(p.reasons[0].text, /Active on 15 of the last 28 days/);
  assert.match(p.reasons[1].text, /sleep goal on 15 of 15 tracked nights/);
  assertWellFormed(p);
});

test('general: consistent habits → holding', () => {
  const p = computeGoalProgress(generalInput(8, 8));
  assert.equal(p.verdict, 'holding');
  assertWellFormed(p);
});

// ── Shape ───────────────────────────────────────────────────────────────────

test('output has exactly the documented top-level keys', () => {
  const p = computeGoalProgress(base());
  assert.deepEqual(Object.keys(p).sort(), [
    'adherence', 'current', 'dataSufficiency', 'distance', 'eta', 'goal', 'headline', 'lastSessionDaysAgo', 'lastSessionOn', 'lastWeighInDaysAgo', 'liftReturn', 'longRun',
    'onPaceForTargetDate', 'race', 'ratePerWeek', 'reachedAt', 'reasons', 'safeBand', 'target', 'verdict', 'weightRead',
  ]);
  // Wave 21w: weight loss carries the additive `trendKg` (the chart's smoothed trend); `weightKg` is the one displayed weight.
  assert.deepEqual(Object.keys(p.current).sort(), ['changeKg', 'progressPct', 'startWeightKg', 'trendKg', 'weightKg']);
  assert.deepEqual(Object.keys(p.dataSufficiency).sort(), ['needed', 'sessionsLast28d', 'weighIns']);
});

// ── Unit-aware text ─────────────────────────────────────────────────────────

test('imperial users get lb in headlines and reasons; structured fields stay in kg', () => {
  const readings = ramp(60, 95, -0.07);
  const input = { weightReadings: readings, target: { weightKg: 85, date: null, weeklySessions: null } };
  const metric = computeGoalProgress(base(input));
  const imperial = computeGoalProgress(base({ ...input, unitSystem: 'imperial' }));

  assert.match(metric.headline, /kg to go/);
  assert.match(imperial.headline, /^On track — about [\d.]+ lb to go/);
  assert.doesNotMatch(imperial.headline, /kg/);
  const rate = imperial.reasons.find(r => r.kind === 'rate');
  assert.match(rate!.text, /lb\/wk/);
  assert.doesNotMatch(rate!.text, /\bkg\b/);

  // lb number is the kg number converted (to-go distance)
  const kgToGo = Number(metric.headline.match(/about ([\d.]+) kg/)![1]);
  const lbToGo = Number(imperial.headline.match(/about ([\d.]+) lb/)![1]);
  assert.ok(Math.abs(lbToGo - kgToGo * 2.20462) < 0.1, `${lbToGo} vs ${kgToGo}`);

  // structured numerics identical regardless of unit
  assert.deepEqual(imperial.current, metric.current);
  assert.deepEqual(imperial.ratePerWeek, metric.ratePerWeek);
  assert.equal(imperial.eta, metric.eta);
  assertWellFormed(imperial);
});

test('null / metric unitSystem keeps kg text', () => {
  const input = { weightReadings: ramp(60, 95, -0.07), target: { weightKg: 85, date: null, weeklySessions: null } };
  assert.match(computeGoalProgress(base({ ...input, unitSystem: null })).headline, /kg to go/);
  assert.match(computeGoalProgress(base({ ...input, unitSystem: 'metric' })).headline, /kg to go/);
});

test('imperial lift reasons and headline are formatted in lb', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    unitSystem: 'imperial',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 14 }, (_, i) => addDays(TODAY, -i)),
  }));
  assert.match(p.headline, /Bench Press est\. 1RM \+11 lb/);
  const lift = p.reasons.find(r => r.kind === 'lift');
  assert.match(lift!.text, /\+11 lb vs 4 weeks ago \(220 → 231 lb\)/);
});

// ── One definition: headline lift, whole-unit e1RM, honest muscle verdict ───

const hl = (weekStart: string, e: number, sets: number) => ({
  weekStart, bestEstimatedOneRepMaxKg: e, volumeKg: 1000, totalSets: sets, totalReps: sets * 6,
});
const fourteen = Array.from({ length: 14 }, (_, i) => addDays(TODAY, -i));

test('muscle: the headline lift is the most-trained lift (sessions over 8 weeks), not the biggest e1RM change', () => {
  const trained = (weekStart: string, e: number, sessions: number) => ({ ...hl(weekStart, e, sessions * 3), sessions });
  const p = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, trainingDays: fourteen,
    progression: {
      'bench press': [trained('2026-09-07', 99.2, 3), trained('2026-10-05', 107.9, 3)], // +9, trained 6 sessions
      squat: [trained('2026-09-07', 120, 1), trained('2026-10-05', 140.4, 1)], // +20, trained 2 sessions
    },
  }));
  assert.equal(p.verdict, 'progressing');
  assert.match(p.headline, /^Progressing — Bench Press est\. 1RM \+9 kg vs 4 weeks ago$/);
  assert.match(p.reasons.find(r => r.kind === 'lift')!.text, /^Bench Press est\. 1RM \+9 kg vs 4 weeks ago \(99 → 108 kg\)$/);
  // Equally trained: the fixed order (squat first) breaks the tie, never the size of the change.
  const tie = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, trainingDays: fourteen,
    progression: {
      'bench press': [trained('2026-09-07', 99.2, 2), trained('2026-10-05', 120, 2)],
      squat: [trained('2026-09-07', 120, 2), trained('2026-10-05', 125, 2)],
    },
  }));
  assert.match(tie.headline, /^Progressing — Squat est\. 1RM \+5 kg/);
});

test('muscle: lift reason change is computed from the rounded endpoints (99.2 → 107.9 reads +9, 99 → 108)', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, trainingDays: fourteen,
    progression: { 'bench press': [hl('2026-09-07', 99.2, 6), hl('2026-10-05', 107.9, 6)] },
  }));
  assert.equal(p.reasons.find(r => r.kind === 'lift')!.text, 'Bench Press est. 1RM +9 kg vs 4 weeks ago (99 → 108 kg)');
});

test('muscle: lifts up but <70% of planned sessions → "Lifts up, sessions behind", not progressing', () => {
  const mk = (n: number) => computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 4 },
    trainingDays: Array.from({ length: n }, (_, i) => addDays(TODAY, -i)),
    progression: { squat: [hl('2026-09-07', 120, 6), hl('2026-10-05', 130, 6)] },
  }));
  const low = mk(10); // 10/16 = 63%
  assert.equal(low.verdict, 'behind');
  assert.equal(low.headline, 'Lifts up, sessions behind — Squat est. 1RM +10 kg');
  assert.equal(mk(12).verdict, 'progressing'); // 75%
  // No weekly target: nothing to be behind on.
  const noTarget = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: 85, date: null, weeklySessions: null },
    progression: { squat: [hl('2026-09-07', 120, 6), hl('2026-10-05', 130, 6)] },
  }));
  assert.equal(noTarget.verdict, 'progressing');
});

test('muscle: the 28-day "sessions behind" call is made as of the last Monday / last session, so a session aging out of the window is no news (wave 21b)', () => {
  // TODAY is a Tuesday (Monday 2026-10-05). 12 sessions, the oldest on 09-08: the 28-day window ending Monday holds all 12 (75%), the one
  // ending today lost it (11 of 16, 69%) - with nothing logged since Saturday the verdict must not turn over on a Tuesday.
  const days = ['2026-09-08', '2026-09-10', '2026-09-12', '2026-09-15', '2026-09-17', '2026-09-19', '2026-09-22', '2026-09-24', '2026-09-26', '2026-09-29', '2026-10-01', '2026-10-03'];
  const at = (todayKey: string, sessions: string[]) => computeGoalProgress(base({
    goal: 'muscle', todayKey, target: { weightKg: null, date: null, weeklySessions: 4 },
    trainingDays: sessions.filter(d => d >= addDays(todayKey, -27)),
    strengthDays: sessions.filter(d => d >= addDays(todayKey, -27)),
    strengthHistoryDays: sessions,
    progression: { squat: [hl('2026-09-07', 120, 6), hl('2026-10-05', 130, 6)] },
  }));
  const monday = at('2026-10-05', days);
  assert.equal(monday.verdict, 'progressing');
  assert.equal(monday.adherence?.pct, 75);
  const tuesday = at('2026-10-06', days);
  assert.equal(tuesday.adherence?.pct, 69, 'the live count and its line still slide');
  assert.equal(tuesday.verdict, 'progressing', 'the call was made on Monday');
  assert.match(tuesday.headline, /^Progressing/);
  // The next Monday is a new call: after a Saturday session the window slid to 10 of 16 (63%).
  assert.equal(at('2026-10-12', [...days, '2026-10-10']).verdict, 'behind');
  // ... and the lapse (9 days without a session) still outranks it.
  assert.equal(at('2026-10-12', days).verdict, 'holding');
  // A session logged on the Tuesday re-makes the call as of that day: 11 + today = 12 of 16.
  const trained = at('2026-10-06', [...days, '2026-10-06']);
  assert.equal(trained.adherence?.pct, 75);
  assert.equal(trained.verdict, 'progressing');
  // Behind on the Monday stays behind through the week (the live count can only fall), until a session lifts it.
  const behindDays = days.slice(2);
  assert.equal(at('2026-10-05', behindDays).verdict, 'behind'); // 10 of 16
  assert.equal(at('2026-10-06', behindDays).verdict, 'behind');
});

// ── Endurance with a weekly distance target ─────────────────────────────────

/** Workouts with distances: `kmByDaysAgo` maps days-ago → km. */
function distanceInput(kmByDaysAgo: Record<number, number>, over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  const workouts = Object.entries(kmByDaysAgo).map(([ago, km]) => ({ day: addDays(TODAY, -Number(ago)), durationMin: 50, distanceKm: km, type: 'Running' }));
  return base({
    goal: 'endurance',
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    trainingDays: workouts.map(w => w.day),
    workouts,
    ...over,
  });
}

/**
 * Runs by calendar week. TODAY is Tuesday 2026-10-06, so `weeks[0]` is this week (Mon 2026-10-05), `weeks[1]` last week
 * (Mon 2026-09-28), and so on; each entry is `[weekday (Mon = 0), km]`. Entries after the day are dropped.
 */
function weekInput(weeks: Array<Array<[number, number]>>, over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  // `weeks[0]` is the week of `over.todayKey` (default TODAY); runs after that day have not happened yet.
  const today = over.todayKey ?? TODAY;
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const thisMonday = addDays(today, -dow);
  const workouts: Array<{ day: string; durationMin: number; distanceKm: number; type: string }> = [];
  weeks.forEach((runs, wk) => {
    for (const [d, km] of runs) {
      const day = addDays(thisMonday, -7 * wk + d);
      if (day <= today) workouts.push({ day, durationMin: Math.round(km * 6), distanceKm: km, type: 'Running' });
    }
  });
  return distanceInput({}, { workouts, trainingDays: workouts.map(w => w.day), ...over });
}
/** One 4-run week totalling `km` (long run 40% on Sunday). */
const wkOf = (km: number): Array<[number, number]> => [[1, km * 0.2], [3, km * 0.2], [5, km * 0.2], [6, km * 0.4]];

test('endurance distance target alone (no sessions target) is a valid target, not needs_target', () => {
  const p = computeGoalProgress(distanceInput({ 1: 8, 3: 10, 9: 12, 12: 9 }));
  assert.notEqual(p.verdict, 'needs_target');
  assert.equal(p.target.weeklyDistanceKm, 30);
});

test('endurance distance: this week (Mon-today, Tue) is the primary progress; ETA is not applicable', () => {
  // TODAY is Tuesday 2026-10-06: Monday 10-05 (1 day ago) + today count; 10-03 (3 days ago) is last week.
  const p = computeGoalProgress(distanceInput({ 0: 3.5, 1: 5, 3: 10, 9: 12, 16: 9, 23: 10 }));
  assert.ok(p.distance);
  assert.equal(p.distance!.weekStart, '2026-10-05');
  assert.equal(p.distance!.thisWeekKm, 8.5);
  // Last week (Sep 28 - Oct 4) held one 10 km run: this week's safe step is ~11 km, the goal stays 30 km.
  assert.equal(p.distance!.stepTargetKm, 11);
  assert.equal(p.distance!.text, '8.5 of ~11 km running this week · goal 30 km');
  // The stat states it; the "Why" does not repeat it.
  assert.equal(p.reasons.some(r => r.kind === 'week_distance'), false);
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assertWellFormed(p);
});

test('endurance distance: last week far short of its own step → behind (only in a build week, from a finished week)', () => {
  // Weeks of 20, 22, 24 km, then 14 km last week (the step from 24 km was ~26 km: 54%, not low enough to be a restart).
  const p = computeGoalProgress(weekInput([[], wkOf(14), wkOf(24), wkOf(22), wkOf(20)]));
  assert.equal(p.distance!.plan?.kind, 'build');
  assert.equal(p.verdict, 'behind');
  assert.equal(p.headline, 'Behind — 14 km last week, ~26 km was the step');
  assertWellFormed(p);
});

test('endurance distance: at the weekly goal and steady → on_track, "30 km a week", no partial week in the average', () => {
  const p = computeGoalProgress(weekInput([[[0, 3]], wkOf(30), wkOf(30), wkOf(30), wkOf(30)]));
  assert.equal(p.distance!.plan?.kind, 'maintain');
  assert.equal(p.verdict, 'on_track');
  assert.equal(p.headline, 'On track — 30 km a week');
  // The average quoted is over finished weeks only: this week's 3 km so far does not drag it down.
  assert.equal(p.distance!.avg4wKm, 30);
  assertWellFormed(p);
});

test('endurance distance: last week on plan and up on the week before → building, one growth number from finished weeks', () => {
  const p = computeGoalProgress(weekInput([[], wkOf(21), wkOf(19), wkOf(17), wkOf(15)]));
  assert.equal(p.distance!.plan?.kind, 'build');
  assert.equal(p.verdict, 'building');
  assert.equal(p.headline, 'Building — 21 km last week (+11%), on plan');
  // No rolling "last 2 weeks vs the 2 before" and no "distance up X%" volume reason on the plan path.
  assert.equal(p.reasons.some(r => r.kind === 'volume'), false);
  assert.doesNotMatch(p.headline, /last 2 weeks/);
  // Early weeks never read "up 993%": a tiny earlier week has no percentage.
  const early = computeGoalProgress(weekInput([[], [[1, 2.5], [5, 2.5]], [[5, 4.4]]]));
  assert.equal(early.headline, 'Building — 5 km last week, on plan');
});

test('endurance distance text is unit-aware (miles) while structured km stay metric', () => {
  const p = computeGoalProgress(weekInput([[[0, 5]], [[1, 8], [3, 8]], [[1, 8], [3, 8]]], { unitSystem: 'imperial' }));
  assert.equal(p.distance!.thisWeekKm, 5);
  assert.equal(p.distance!.targetKm, 30);
  // Last week 16 km = 9.9 mi -> a step of 11 whole miles (17.7 km); the goal 30 km = 18.6 mi.
  assert.equal(p.distance!.stepTargetKm, 17.7);
  assert.equal(p.distance!.text, '3.1 of ~11 mi running this week · goal 18.6 mi');
});

// ── Endurance: ONE target for this week (the safe step from last week) ─────

/** TODAY is Tuesday 2026-10-06: this week = Oct 5-6 (0-1 days ago); last week = Sep 28 - Oct 4 (2-8 days ago). */
test('endurance distance step: 24.5 km last week -> this week builds to ~27 km (goal 30 km), text and field agree', () => {
  // Marcus: 22.7 km so far this week (Mon + Tue), 24.5 km last week in three runs.
  const p = computeGoalProgress(distanceInput({ 0: 12.7, 1: 10, 3: 10, 4: 8, 7: 6.5 }));
  assert.equal(p.distance!.thisWeekKm, 22.7);
  assert.equal(p.distance!.targetKm, 30);
  assert.equal(p.distance!.stepTargetKm, 27);
  assert.equal(p.distance!.text, '22.7 of ~27 km running this week · goal 30 km');
  assertWellFormed(p);
  // The raw copy keeps the unit glued to its number (and "goal 30 km" together).
  const raw = computeGoalProgressRaw(distanceInput({ 0: 12.7, 1: 10, 3: 10, 4: 8, 7: 6.5 }));
  assert.ok(raw.distance!.text.includes(`~27${NBSP}km`) && raw.distance!.text.endsWith(`goal 30${NBSP}km`), raw.distance!.text);
});

test('endurance distance step: last week already within 10% of the goal -> the step IS the goal and the text is unchanged', () => {
  // 28 km last week x 1.10 = 30.8 -> capped at the 30 km goal.
  const p = computeGoalProgress(distanceInput({ 0: 6, 3: 14, 5: 14 }));
  assert.equal(p.distance!.stepTargetKm, 30);
  assert.equal(p.distance!.text, '6 of 30 km running this week');
  // Last week above the goal: still the goal, never more.
  const over = computeGoalProgress(distanceInput({ 0: 6, 3: 20, 5: 20 }));
  assert.equal(over.distance!.stepTargetKm, 30);
  assert.equal(over.distance!.text, '6 of 30 km running this week');
});

test('endurance distance step: a week with no running restarts at ~75% of the recent median (an 8-14 day gap), not at the goal', () => {
  // Weeks of 20, 20, 20 km, then nothing last week (an 8 day gap): restart at 75% of 20 km = 15 km (wave 20: the cut scales with the gap).
  const none = computeGoalProgress(weekInput([[[0, 8]], [], wkOf(20), wkOf(20), wkOf(20)]));
  assert.equal(none.distance!.plan?.kind, 'restart');
  assert.equal(none.distance!.stepTargetKm, 15);
  assert.equal(none.distance!.text, '8 of ~15 km running this week · goal 30 km');
  // A near-zero last week (0.6 km) has no base to take 10% of: the same restart.
  const tiny = computeGoalProgress(weekInput([[[0, 5]], [[4, 0.6]], wkOf(20), wkOf(20), wkOf(20)]));
  assert.equal(tiny.distance!.plan?.kind, 'restart');
  assert.equal(tiny.distance!.stepTargetKm, 15);
  // Distance data nowhere at all: the goal, no plan.
  const noData = computeGoalProgress(enduranceInput([3, 3, 3, 3], {
    target: { weightKg: null, date: null, weeklySessions: 3, weeklyDistanceKm: 30 },
  }));
  assert.equal(noData.distance!.stepTargetKm, 30);
  assert.equal(noData.distance!.text, '0 km so far · baseline week'); // wave 22e: nothing run yet is the baseline, not "0 of 30 km"
  assert.equal(noData.distance!.plan, undefined);
});

test('endurance distance step: only running counts toward last week\'s base, and only last calendar week', () => {
  const workouts = [
    { day: addDays(TODAY, -3), durationMin: 50, distanceKm: 10, type: 'Running' },
    { day: addDays(TODAY, -3), durationMin: 90, distanceKm: 40, type: 'Cycling' },
    // Sunday before last (Sep 27) is two weeks back, not last week.
    { day: addDays(TODAY, -9), durationMin: 70, distanceKm: 15, type: 'Running' },
    { day: TODAY, durationMin: 40, distanceKm: 5, type: 'Running' },
  ];
  const p = computeGoalProgress(distanceInput({}, { workouts, trainingDays: workouts.map(w => w.day) }));
  assert.equal(p.distance!.stepTargetKm, 11); // 10 km x 1.10
  assert.equal(p.distance!.thisWeekKm, 5);
});

test('endurance distance step: miles users get a whole-mile step; the structured field stays km', () => {
  // Marcus in miles: 24.5 km = 15.2 mi last week -> 17 mi (27.4 km), goal 30 km = 18.6 mi; 22.7 km = 14.1 mi so far.
  const p = computeGoalProgress(distanceInput({ 0: 12.7, 1: 10, 3: 10, 4: 8, 7: 6.5 }, { unitSystem: 'imperial' }));
  assert.equal(p.distance!.targetKm, 30);
  assert.equal(p.distance!.stepTargetKm, 27.4);
  assert.equal(p.distance!.text, '14.1 of ~17 mi running this week · goal 18.6 mi');
  // Within 10% of the goal in miles (28 km = 17.4 mi x 1.10 = 19.1 > 18.6): the goal.
  const goal = computeGoalProgress(distanceInput({ 0: 6, 3: 14, 5: 14 }, { unitSystem: 'imperial' }));
  assert.equal(goal.distance!.stepTargetKm, 30);
  assert.equal(goal.distance!.text, '3.7 of 18.6 mi running this week');
});

test('endurance distance target with no distance readings: this week is null, verdict falls back to sessions', () => {
  const p = computeGoalProgress(enduranceInput([3, 3, 3, 3], {
    target: { weightKg: null, date: null, weeklySessions: 3, weeklyDistanceKm: 30 },
  }));
  assert.equal(p.distance!.thisWeekKm, null);
  assert.equal(p.distance!.avg4wKm, null);
  assert.equal(p.verdict, 'holding');
});

test('non-endurance goals never carry a distance block', () => {
  const p = computeGoalProgress(base({ goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3, weeklyDistanceKm: 30 } }));
  assert.equal(p.distance, null);
});

// ── Verdict consistency ─────────────────────────────────────────────────────

const wk = (weekStart: string, e: number | null, volumeKg = 1000, totalSets = 6) => ({
  weekStart, bestEstimatedOneRepMaxKg: e, volumeKg, totalSets, totalReps: 36,
});

test('start weight is derived from the first weigh-in on/after the goal start when none was stored', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 80, date: null, weeklySessions: null },
    start: { weightKg: null, startedAt: `${addDays(TODAY, -20)}T09:00:00.000Z`, startedDay: addDays(TODAY, -20) },
    weightReadings: ramp(40, 90, -0.1),
  }));
  assert.ok(p.current.startWeightKg != null && p.current.startWeightKg < 90 && p.current.startWeightKg > 85);
  assert.notEqual(p.current.changeKg, null);
  assert.notEqual(p.current.progressPct, null);
});

test('start weight falls back to the first weigh-in overall; stays null with no goal start', () => {
  const readings = ramp(10, 90, -0.1);
  const early = computeGoalProgress(base({
    target: { weightKg: 80, date: null, weeklySessions: null },
    start: { weightKg: null, startedAt: `${addDays(TODAY, -100)}T09:00:00.000Z`, startedDay: addDays(TODAY, -100) },
    weightReadings: readings,
  }));
  assert.equal(early.current.startWeightKg, 90);
  const none = computeGoalProgress(base({ target: { weightKg: 80, date: null, weeklySessions: null }, weightReadings: readings }));
  assert.equal(none.current.startWeightKg, null);
  const stored = computeGoalProgress(base({
    target: { weightKg: 80, date: null, weeklySessions: null },
    start: { weightKg: 95, startedAt: `${addDays(TODAY, -5)}T09:00:00.000Z` },
    weightReadings: readings,
  }));
  assert.equal(stored.current.startWeightKg, 95);
});

test('muscle: "Progressing" needs +1%, a +0.5% drift is a stall; names are display-cased', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i));
  const small = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, trainingDays: twelve,
    progression: { 'bench press': [wk('2026-09-07', 100), wk('2026-09-14', 100), wk('2026-09-21', 100), wk('2026-09-28', 100.5), wk('2026-10-05', 100.5)] },
  }));
  assert.equal(small.verdict, 'stalled');
  assert.equal(small.headline, 'Stalled — Bench Press est. 1RM up under 1% vs 4 weeks ago');
  const real = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, trainingDays: twelve,
    progression: { 'bench press': [wk('2026-09-07', 100), wk('2026-10-05', 102)] },
  }));
  assert.equal(real.verdict, 'progressing');
  assert.match(real.headline, /Bench Press est\. 1RM \+2 kg vs 4 weeks ago/);
  assert.match(real.reasons.find(r => r.kind === 'lift')!.text, /^Bench Press est\. 1RM/);
});

test('muscle: an empty current week is skipped, so Monday before training is not a regression', () => {
  // TODAY is Tuesday; current week (10-05) has no sets. End week = 09-28.
  const p = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 },
    trainingDays: Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i)),
    progression: { squat: [wk('2026-08-31', 100), wk('2026-09-28', 104)] },
  }));
  assert.equal(p.verdict, 'progressing');
});

test('muscle sessions count strength days only when strengthDays is provided', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 4 },
    trainingDays: Array.from({ length: 16 }, (_, i) => addDays(TODAY, -i)),
    strengthDays: [addDays(TODAY, -1), addDays(TODAY, -3), addDays(TODAY, -5), addDays(TODAY, -8)],
    progression: lifts(100, 105),
  }));
  assert.equal(p.dataSufficiency.sessionsLast28d, 4);
  const adherence = p.reasons.find(r => r.kind === 'adherence');
  assert.match(adherence!.text, /^4 of 16 planned sessions/);
});

test('isStrengthWorkoutType / isRunningWorkoutType', () => {
  assert.equal(isStrengthWorkoutType('Strength Training'), true);
  assert.equal(isStrengthWorkoutType('Running'), false);
  assert.equal(isStrengthWorkoutType(null), false);
  assert.equal(isRunningWorkoutType('Running'), true);
  assert.equal(isRunningWorkoutType('Walking'), false);
  assert.equal(isRunningWorkoutType(undefined), false);
});

test('endurance distance counts running only', () => {
  const run = { day: TODAY, durationMin: 40, distanceKm: 5, type: 'Running' };
  const ride = { day: TODAY, durationMin: 60, distanceKm: 25, type: 'Cycling' };
  const walk = { day: TODAY, durationMin: 60, distanceKm: 4, type: 'Walking' };
  const p = computeGoalProgress(base({
    goal: 'endurance',
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 },
    trainingDays: [TODAY],
    workouts: [run, ride, walk],
  }));
  assert.equal(p.distance!.thisWeekKm, 5);
  // The first week of running is a baseline week: no step, no "5 of 30 km".
  assert.equal(p.distance!.plan?.kind, 'baseline');
  assert.equal(p.distance!.text, '5 km so far · baseline week');
});

// ETA / pace
function lossInput(over: Partial<GoalProgressInput>): GoalProgressInput {
  return base({ target: { weightKg: 80, date: null, weeklySessions: null }, ...over });
}

test('on pace: ETA within a week either side of the target date is on_track and onPace; further out is ahead / behind', () => {
  const readings = ramp(40, 90, -0.1);
  const free = computeGoalProgress(lossInput({ weightReadings: readings }));
  assert.ok(free.eta);
  const eta = free.eta!;
  // offset > 0: the target date is `offset` days BEFORE the ETA (the user is late); offset < 0: after it (early).
  const at = (offset: number) => computeGoalProgress(lossInput({
    weightReadings: readings, target: { weightKg: 80, date: addDays(eta, -offset), weeklySessions: null },
  }));
  assert.equal(at(1).verdict, 'on_track');
  assert.equal(at(1).onPaceForTargetDate, true);
  assert.equal(at(6).verdict, 'on_track');
  assert.equal(at(-6).verdict, 'on_track', 'one margin both ways: 6 days early is still on pace');
  assert.equal(at(14).verdict, 'behind');
  assert.equal(at(14).onPaceForTargetDate, false);
  assert.equal(at(-14).verdict, 'ahead', 'a fortnight early is ahead (the same 7-day margin the opener and iOS use)');
  assert.equal(at(-14).onPaceForTargetDate, true);
});

test('ETA is anchored to the last weigh-in, not today; lastWeighInDaysAgo is reported', () => {
  const full = ramp(40, 90, -0.1);
  const fresh = computeGoalProgress(lossInput({ weightReadings: full }));
  const stale = computeGoalProgress(lossInput({ weightReadings: full.slice(0, -5) }));
  assert.equal(fresh.lastWeighInDaysAgo, 0);
  assert.equal(stale.lastWeighInDaysAgo, 5);
  assert.ok(stale.eta && fresh.eta);
  // Skipped weigh-ins add no days: the same readings viewed a day earlier give the same date. (Wave 21w: the date is the
  // week's plan, read from the weigh-ins through the Sunday before the week, so "earlier" stays inside the same week.)
  const then = computeGoalProgress(lossInput({ todayKey: addDays(TODAY, -1), weightReadings: full.slice(0, -5) }));
  assert.equal(stale.eta, then.eta);
  assert.equal(computeGoalProgress(base()).lastWeighInDaysAgo, null);
});

test('stalled verdict never carries an ETA or on-pace flag', () => {
  const p = computeGoalProgress(lossInput({
    target: { weightKg: 78, date: addDays(TODAY, 90), weeklySessions: null },
    weightReadings: series(15, () => 85),
  }));
  assert.equal(p.verdict, 'stalled');
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
});

test('endurance race: label, weeks/days to go and the race reason leads (cap 3)', () => {
  const p = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 84), distanceKm: 21.1 } }));
  assert.ok(p.race);
  assert.equal(p.race.label, 'Half marathon');
  assert.equal(p.race.daysToGo, 84);
  assert.equal(p.race.weeksToGo, 12);
  assert.equal(p.reasons[0].kind, 'race');
  assert.match(p.reasons[0].text, /^Half marathon in 12 weeks \(\w{3} \d{1,2}\)$/);
  assert.ok(p.reasons.length <= 3);
});

test('endurance race: race week reads in days with weeksToGo 0; race day is "today"', () => {
  const week = computeGoalProgress(enduranceInput([3, 3, 3, 3], { race: { date: addDays(TODAY, 5), distanceKm: 42.2 } }));
  assert.equal(week.race?.weeksToGo, 0);
  assert.equal(week.race?.label, 'Marathon');
  assert.match(week.reasons[0].text, /^Marathon in 5 days/);
  const today = computeGoalProgress(enduranceInput([3, 3, 3, 3], { race: { date: TODAY, distanceKm: 10 } }));
  assert.equal(today.race?.daysToGo, 0);
  assert.match(today.reasons[0].text, /^10K is today/);
});

test('endurance race: a race passed more than a recovery ago is null; labels cover 5K / custom / no distance; verdict is unchanged', () => {
  const without = computeGoalProgress(enduranceInput([4, 3, 2, 2]));
  // The week of day 15 after a half marathon is still recovery week 2 (read on its Monday); three weeks later it is over.
  const passed = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, -22), distanceKm: 21.1 } }));
  assert.equal(passed.race, null);
  assert.deepEqual(passed.reasons, without.reasons);
  assert.equal(passed.headline, without.headline);
  assert.equal(without.race, null);
  const with5k = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 30), distanceKm: 5 } }));
  assert.equal(with5k.verdict, without.verdict);
  assert.equal(with5k.headline, without.headline);
  assert.equal(with5k.race?.label, '5K');
  assert.equal(computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 30), distanceKm: 15 } })).race?.label, '15 km race');
  assert.equal(computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 30), distanceKm: null } })).race?.label, 'Race');
});

test('race is ignored for non-endurance goals', () => {
  const p = computeGoalProgress(base({ goal: 'muscle', race: { date: addDays(TODAY, 30), distanceKm: 10 } }));
  assert.equal(p.race, null);
});

// ── Race lifecycle: phases, wind-down targets, post-race recovery ───────────
// The race phase is read on the MONDAY of the week (TODAY is Tuesday 2026-10-06, Monday 2026-10-05), so a race
// `daysOut` days after TODAY is `daysOut + 1` days out on the Monday that decides the phase.

/** Weekly goal 50 km, peak week before the taper 40 km; last week held one 10 km run (the growth step would be 11 km). */
function phaseInput(daysOut: number, over: Partial<GoalProgressInput> = {}, raceKm: number | null = 21.1): GoalProgressInput {
  return distanceInput({ 0: 3.5, 1: 5, 3: 10, 9: 12, 16: 9, 23: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, daysOut), distanceKm: raceKm },
    racePeakWeekKm: 40,
    ...over,
  });
}
const MARATHON = 42.2;

const reasonOf = (p: GoalProgress, kind: string): string | undefined => p.reasons.find(r => r.kind === kind)?.text;

test('race phase: build keeps the growth step and adds the phase to the payload only', () => {
  const p = computeGoalProgress(phaseInput(84));
  assert.equal(p.race?.phase, 'build');
  assert.equal(p.race?.daysSince, undefined);
  assert.equal(p.distance!.stepTargetKm, 11); // ~10% over last week's 10 km, not a phase target
  assert.equal(reasonOf(p, 'race_phase'), undefined);
  // A half marathon is still build 15 days out on the Monday; a marathon 22.
  assert.equal(computeGoalProgress(phaseInput(13)).race?.phase, 'taper');
  assert.equal(computeGoalProgress(phaseInput(14)).race?.phase, 'build');
  assert.equal(computeGoalProgress(phaseInput(20, {}, MARATHON)).race?.phase, 'taper');
  assert.equal(computeGoalProgress(phaseInput(21, {}, MARATHON)).race?.phase, 'build');
});

test('race phase (half): ONE taper week x0.75 of the peak week, days 8-14 out on the week\'s Monday', () => {
  const p = computeGoalProgress(phaseInput(12));
  assert.equal(p.race?.phase, 'taper');
  assert.equal(p.distance!.stepTargetKm, 30); // round(40 x 0.75)
  assert.equal(p.distance!.text, '8.5 of ~30 km running this week · goal 50 km');
  assert.equal(p.distance!.plan?.kind, 'taper');
  // The taper copy spells out the intensity ("keep a little intensity" never said what that meant).
  assert.equal(reasonOf(p, 'race_phase'), 'Taper: ~30 km this week, cut the volume; long run 8 km easy, plus 3×1 km at race pace midweek');
  // The whole week has the same target: Monday d=14 (the first taper Monday) to Monday d=8.
  for (const daysOut of [7, 10, 13]) assert.equal(computeGoalProgress(phaseInput(daysOut)).distance!.stepTargetKm, 30, `${daysOut}`);
});

test('race phase (marathon): x0.75 on the Mondays 14-21 days out and x0.6 on 8-13 (unchanged rules)', () => {
  assert.equal(computeGoalProgress(phaseInput(20, {}, MARATHON)).distance!.stepTargetKm, 30); // Monday 21 out
  assert.equal(computeGoalProgress(phaseInput(13, {}, MARATHON)).distance!.stepTargetKm, 30); // Monday 14 out
  assert.equal(computeGoalProgress(phaseInput(12, {}, MARATHON)).distance!.stepTargetKm, 24); // Monday 13 out
  assert.equal(computeGoalProgress(phaseInput(7, {}, MARATHON)).distance!.stepTargetKm, 24); // Monday 8 out
  assert.equal(computeGoalProgress(phaseInput(6, {}, MARATHON)).distance!.stepTargetKm, 16); // race week x0.4
  assert.equal(reasonOf(computeGoalProgress(phaseInput(10, {}, MARATHON)), 'race_phase')!.startsWith('Taper: ~24 km this week'), true);
});

test('race phase: a Sunday seven days out is still the taper week the Monday started (card and review agree)', () => {
  // Sunday 2026-10-11 with the race Sunday 2026-10-18: today-based it was "race week"; the week began 13 days out.
  const sunday = computeGoalProgress(phaseInput(12, { todayKey: '2026-10-11', race: { date: '2026-10-18', distanceKm: 21.1 } }));
  assert.equal(sunday.race?.phase, 'taper');
  assert.equal(sunday.race?.daysToGo, 7);
  assert.equal(sunday.distance!.plan?.kind, 'taper');
  assert.match(sunday.headline, /^Taper week — /);
  const monday = computeGoalProgress(phaseInput(12, { todayKey: '2026-10-12', race: { date: '2026-10-18', distanceKm: 21.1 } }));
  assert.equal(monday.race?.phase, 'race_week');
  assert.match(monday.headline, /^Race week — /);
});

test('race phase: the phase reason sits right behind the race line', () => {
  const taper = computeGoalProgress(phaseInput(10));
  assert.deepEqual(taper.reasons.map(r => r.kind).slice(0, 2), ['race', 'race_phase']);
  assert.ok(taper.reasons.length <= 3);
  assertWellFormed(taper);
});

test('race phase (half): race week targets x0.5 of the peak week (race excluded) and says to keep runs short and easy', () => {
  const p = computeGoalProgress(phaseInput(5));
  assert.equal(p.race?.phase, 'race_week');
  assert.equal(p.race?.weeksToGo, 0);
  assert.equal(p.distance!.stepTargetKm, 20); // round(40 x 0.5)
  assert.equal(reasonOf(p, 'race_phase'), 'Race week: short easy runs, rest 1–2 days before the race');
  assert.equal(computeGoalProgress(phaseInput(6)).race?.phase, 'race_week'); // Monday 7 out
  assert.equal(computeGoalProgress(phaseInput(7)).race?.phase, 'taper'); // Monday 8 out
});

test('race phase (10K): no taper, race week x0.6, 7 days of recovery at most x0.5', () => {
  assert.equal(computeGoalProgress(phaseInput(12, {}, 10)).race?.phase, 'build');
  const week = computeGoalProgress(phaseInput(5, {}, 10));
  assert.equal(week.race?.phase, 'race_week');
  assert.equal(week.distance!.stepTargetKm, 24); // round(40 x 0.6)
  const after = computeGoalProgress(phaseInput(-3, {}, 10));
  assert.equal(after.race?.phase, 'recovery');
  assert.equal(after.distance!.stepTargetKm, 20); // at most x0.5
  // The recovery week is over a week later (10K: 7 days).
  assert.equal(computeGoalProgress(phaseInput(-9, {}, 10)).race, null);
});

test('race phase: race day says "start relaxed" until a race-length run is logged, then the race is done', () => {
  // TODAY is Tuesday; Monday's 5 km is this week's real running.
  const before = computeGoalProgress(distanceInput({ 1: 5, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: TODAY, distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(before.race?.phase, 'race_week');
  assert.equal(before.race?.daysToGo, 0);
  assert.equal(before.headline, 'Race day — start relaxed');
  assert.equal(before.verdict, 'on_track');
  assert.equal(before.race?.completed, undefined);
  // Race day is for the race, not the week's km (wave 22e): no figure of the week on the card.
  assert.equal(before.distance!.thisWeekKm, null);
  assert.equal(before.distance!.text, 'Race day');
  // The race run (2:01) is the race, not training: it is not in the week's km, the headline congratulates.
  const workouts = [
    { day: TODAY, durationMin: 121, distanceKm: 21.1, type: 'Running' },
    { day: addDays(TODAY, -1), durationMin: 30, distanceKm: 5, type: 'Running' },
    { day: addDays(TODAY, -3), durationMin: 60, distanceKm: 10, type: 'Running' },
  ];
  const done = computeGoalProgress(distanceInput({}, {
    workouts, trainingDays: workouts.map(w => w.day),
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: TODAY, distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(done.distance!.thisWeekKm, null); // wave 22e: race day shows the race, not "5 of ~20 km running this week"
  assert.equal(done.distance!.text, 'Race done — 21.1 km');
  assert.equal(done.distance!.stepTargetKm, 20);
  assert.equal(done.headline, 'Half marathon done — 21.1 km in 2:01. Congratulations!');
  assert.deepEqual(done.race?.completed, { km: 21.1, durationMin: 121 });
  assert.equal(done.verdict, 'on_track');
  assert.doesNotMatch(done.reasons.map(r => r.text).join(' | '), /ease off|over the plan/);
  // Day after: still congratulated; later on it is plain recovery copy.
  const next = computeGoalProgress({ ...distanceInput({}, { workouts, trainingDays: workouts.map(w => w.day), target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 }, race: { date: addDays(TODAY, -1), distanceKm: 21.1 }, racePeakWeekKm: 40 }) });
  assert.equal(next.race?.phase, 'recovery');
});

test('race phase: after the race the race stays for the recovery weeks with daysSince and a next step', () => {
  const p = computeGoalProgress(phaseInput(-3));
  assert.ok(p.race);
  assert.equal(p.race.phase, 'recovery');
  assert.equal(p.race.daysSince, 3);
  assert.equal(p.race.daysToGo, 0);
  assert.equal(p.race.weeksToGo, 0);
  assert.equal(p.race.label, 'Half marathon');
  // The headline moves on day by day (no 14 days of the same line).
  assert.equal(p.headline, 'Recovery week 1 — day 3 after your half: easy only');
  assert.equal(computeGoalProgress(phaseInput(-4)).headline, 'Recovery week 1 — day 4 after your half: easy only');
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'race_phase', 'next_step']);
  assert.equal(p.reasons[0].text, 'Half marathon done (Oct 3)');
  // 8.5 of the ~16 km are run: the line says what is left; the plan's own line is the one for the week.
  assert.equal(p.reasons[1].text, 'Recovery: 8.5 of ~16 km — keep the rest of the week ≤ 7.5 km');
  assert.equal(p.distance!.plan?.purpose, 'Recovery: easy only this week (~16 km max)');
  // The runner already has a weekly distance target: it is not offered as a next goal (wave 20).
  assert.deepEqual(p.reasons[2], {
    kind: 'next_step',
    text: 'Set your next goal: a new race or maintenance',
    tone: 'neutral',
  });
  assert.equal(p.distance!.stepTargetKm, 16); // week 1: x0.4 of the 40 km peak
  assertWellFormed(p);
});

test('race phase (half): recovery days 1-7 are at most x0.4, days 8-14 at most x0.7, then the rebuild weeks', () => {
  assert.equal(computeGoalProgress(phaseInput(-1)).race?.phase, 'recovery'); // race Monday: still its race week target
  assert.equal(computeGoalProgress(phaseInput(-6)).distance!.stepTargetKm, 16); // Monday 5 after
  const wk2 = computeGoalProgress(phaseInput(-8)); // Monday 7 after, the last day of recovery week 1 on the Monday
  assert.equal(wk2.distance!.stepTargetKm, 16);
  const second = computeGoalProgress(phaseInput(-9)); // Monday 8 after
  assert.equal(second.headline, 'Recovery week 2 — day 9 after your half: easy only');
  assert.equal(second.distance!.stepTargetKm, 28); // round(40 x 0.7)
  assert.equal(second.distance!.plan?.purpose, 'Recovery: easy only this week (~28 km max)');
  const last = computeGoalProgress(phaseInput(-14)); // Monday 13 after
  assert.equal(last.race?.phase, 'recovery');
  assert.equal(last.race?.daysSince, 14);
  // Monday 14 after is still recovery week 2 (the week is read on its Monday); the next week is the rebuild.
  assert.equal(computeGoalProgress(phaseInput(-15)).race?.phase, 'recovery');
  const gone = computeGoalProgress(phaseInput(-22));
  assert.equal(gone.race, null);
  assert.equal(gone.reasons.some(r => r.kind === 'race_phase'), false);
});

test('race phase: race week counts the running without the race run', () => {
  // Race was Monday (TODAY - 1): Monday's race run is excluded, today's easy 4 km is the week so far.
  const p = computeGoalProgress(distanceInput({ 0: 4, 1: 21.1, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, -1), distanceKm: 21.1 },
    racePeakWeekKm: 40,
  }));
  assert.equal(p.race?.phase, 'recovery');
  assert.equal(p.distance!.thisWeekKm, 4);
  assert.equal(p.distance!.stepTargetKm, 20);
  assert.equal(p.distance!.text, '4 of ~20 km running this week · goal 50 km');
});

test('rebuild: from the week after recovery until 42 days after the race — graded against its step, never "behind"', () => {
  // Race 22 days ago; recovery weeks of 12 and 20 km; last week 20 km.
  const rebuilt = computeGoalProgress(weekInput([[[0, 5]], wkOf(20), wkOf(12), wkOf(20), wkOf(30), wkOf(30), wkOf(30), wkOf(30), wkOf(30), wkOf(30)], {
    race: { date: addDays(TODAY, -22), distanceKm: 21.1 }, racePeakWeekKm: 30,
  }));
  assert.equal(rebuilt.race, null);
  assert.equal(rebuilt.distance!.plan?.kind, 'rebuild');
  assert.equal(rebuilt.verdict, 'building');
  assert.equal(rebuilt.headline, 'Rebuilding after your half — 5 of ~22 km');
  assert.equal(rebuilt.distance!.stepTargetKm, 22);
  // "Set your next goal" is for recovery week 1 only (wave 20): the rebuild weeks do not nag.
  assert.equal(rebuilt.reasons.some(r => r.kind === 'next_step'), false);
  // The race week and the recovery weeks are not in the average (it is the 4 weeks before the taper).
  assert.equal(rebuilt.distance!.avg4wKm, 30);
  assertWellFormed(rebuilt);
  // Past 42 days the plain plan is back.
  const later = computeGoalProgress(weekInput([[[0, 5]], wkOf(22), wkOf(20), wkOf(20), wkOf(18), wkOf(12), wkOf(20), wkOf(30)], {
    race: { date: addDays(TODAY, -50), distanceKm: 21.1 }, racePeakWeekKm: 30,
  }));
  assert.notEqual(later.distance!.plan?.kind, 'rebuild');
});

// ── Race lifecycle: the verdict is phase-aware (a planned drop is never "behind") ──

/**
 * A runner whose last finished week was far short (6 km after weeks of ~30) against a 50 km goal. Without a race that
 * is a restart; around a race it must never read 'behind' or 'stalled' either. `daysOut` null = no race.
 */
const FALLING = { 0: 3.5, 1: 5, 3: 6, 9: 8, 16: 30, 20: 25, 23: 30 };
function fallingInput(daysOut: number | null, over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return distanceInput(FALLING, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: daysOut == null ? null : { date: addDays(TODAY, daysOut), distanceKm: 21.1 },
    racePeakWeekKm: 40,
    ...over,
  });
}
const noRaceVerdict = (): GoalProgress['verdict'] => computeGoalProgress(fallingInput(null)).verdict;

test('phase verdict: taper with a falling volume is never "behind" — on_track, within or under (a rest day never reads "under")', () => {
  assert.equal(noRaceVerdict(), 'building'); // a restart week: never behind, even without a race
  for (const daysOut of [13, 12, 10, 8, 7]) {
    const p = computeGoalProgress(fallingInput(daysOut));
    assert.equal(p.race?.phase, 'taper');
    assert.equal(p.verdict, 'on_track', `${daysOut} days out`);
    // The headline matches the verdict (no leftover "Behind — averaging …").
    assert.equal(p.headline, 'Taper week — 8.5 of ~30 km, on plan');
    assert.equal(p.reasons.find(r => r.kind === 'race_phase')?.tone, 'neutral');
  }
  // Sunday, almost nothing run: still on_track (never "building" because of the weekday).
  const sunday = computeGoalProgress(fallingInput(12, { todayKey: '2026-10-11', race: { date: '2026-10-18', distanceKm: 21.1 } }));
  assert.equal(sunday.verdict, 'on_track');
  const monday = computeGoalProgress(phaseInput(12, { todayKey: '2026-10-05', race: { date: '2026-10-17', distanceKm: 21.1 } }));
  assert.equal(monday.verdict, 'on_track');
});

test('phase verdict: running well over the taper plan goes "holding" with a watch line that says so', () => {
  // Taper week: ~30 km target; 38 km is over 125% and 8 km over.
  const taper = computeGoalProgress(distanceInput({ 0: 18, 1: 20, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, 12), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(taper.verdict, 'holding');
  assert.equal(taper.headline, 'Taper week — 38 of ~30 km, over the plan');
  const reason = taper.reasons.find(r => r.kind === 'race_phase')!;
  assert.equal(reason.tone, 'watch');
  assert.equal(reason.text, 'Taper: 38 of ~30 km — over the plan; rest or a very easy jog from here');
  // 36 km is within 125%: no flag, and the line says what is left.
  const within = computeGoalProgress(distanceInput({ 0: 18, 1: 18, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, 12), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(within.verdict, 'on_track');
  assert.equal(within.reasons.find(r => r.kind === 'race_phase')?.tone, 'neutral');
});

test('phase verdict: the line gives the remaining budget as the week fills up ("keep Sunday\'s run ≤ 4 km")', () => {
  // Saturday 2026-10-10, race Sunday 2026-10-18 (taper week): 26 of ~30 km.
  const sat = computeGoalProgress(distanceInput({ 0: 8, 1: 8, 3: 10 }, {
    todayKey: '2026-10-10',
    workouts: [
      { day: '2026-10-05', durationMin: 50, distanceKm: 8, type: 'Running' },
      { day: '2026-10-07', durationMin: 50, distanceKm: 8, type: 'Running' },
      { day: '2026-10-10', durationMin: 50, distanceKm: 10, type: 'Running' },
    ],
    trainingDays: ['2026-10-05', '2026-10-07', '2026-10-10'],
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: '2026-10-18', distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(sat.verdict, 'on_track');
  assert.equal(reasonOf(sat, 'race_phase'), "Taper: 26 of ~30 km — keep Sunday's run ≤ 4 km");
});

test('phase verdict: race week is on_track under its ceiling and flags running over it', () => {
  const ok = computeGoalProgress(phaseInput(5));
  assert.equal(ok.verdict, 'on_track');
  assert.equal(ok.headline, 'Race week — 8.5 of ~20 km before the race');
  // 24 km against a 20 km ceiling (+10% = 22): over.
  const over = computeGoalProgress(distanceInput({ 0: 14, 1: 10, 3: 4 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, 5), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(over.verdict, 'holding');
  assert.equal(over.headline, 'Race week — 24 of ~20 km before the race, over the plan');
  assert.equal(over.reasons.find(r => r.kind === 'race_phase')?.tone, 'watch');
  assert.match(over.reasons.find(r => r.kind === 'race_phase')!.text, /^Race week: 24 of ~20 km — over the plan; rest or a very easy jog from here$/);
  // Race day: the race itself does not count, and nobody is told to "ease off" on race day.
  const raceDay = computeGoalProgress(distanceInput({ 0: 21.1, 1: 5, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: TODAY, distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(raceDay.verdict, 'on_track');
  assert.doesNotMatch(raceDay.reasons.map(r => r.text).join(' | '), /ease off|over the plan/);
});

test('phase verdict: a recovery week is on_track (never "behind"); overshooting flags the line', () => {
  for (const daysSince of [1, 3, 7, 9, 13]) {
    const p = computeGoalProgress(fallingInput(-daysSince));
    assert.equal(p.race?.phase, 'recovery');
    assert.equal(p.verdict, 'on_track', `${daysSince} days after`);
    assert.match(p.headline, /^Recovery week [12] — day \d+ after your half: easy only$/);
    // The next-goal nudge is for recovery week 1 only (wave 20).
    assert.deepEqual(p.reasons.map(r => r.kind), daysSince <= 7 ? ['race', 'race_phase', 'next_step'] : ['race', 'race_phase'], `${daysSince} days after`);
  }
  // 24 km in recovery week 1 against a 16 km ceiling.
  const over = computeGoalProgress(distanceInput({ 0: 14, 1: 10, 3: 4 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, -3), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(over.verdict, 'holding');
  assert.deepEqual(over.reasons.map(r => r.kind), ['race', 'race_phase', 'next_step']);
  assert.equal(over.reasons[1].tone, 'watch');
  assert.equal(over.reasons[1].text, 'Recovery: 24 of ~16 km — over the plan; rest or a very easy jog from here');
});

test('phase verdict: build phase, no-distance goals and thin data keep their verdict; no new verdict values', () => {
  // Build (15 / 84 days out): exactly the no-race verdict.
  for (const daysOut of [14, 84]) assert.equal(computeGoalProgress(fallingInput(daysOut)).verdict, noRaceVerdict(), `${daysOut}`);
  // A race well over: back to the plain verdict.
  assert.equal(computeGoalProgress(fallingInput(-22)).verdict, noRaceVerdict());
  // Too few sessions stays insufficient_data in a taper without any running before.
  const thin = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 10), distanceKm: 21.1 } }));
  assert.ok(['on_track', 'holding', 'building', 'insufficient_data'].includes(thin.verdict));
  // No weekly distance goal: nothing to measure against, the sessions-based verdict is untouched.
  const sessionsOnly = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 10), distanceKm: 21.1 } }));
  const sessionsOnlyNoRace = computeGoalProgress(enduranceInput([4, 3, 2, 2]));
  assert.equal(sessionsOnly.verdict, sessionsOnlyNoRace.verdict);
  assert.equal(sessionsOnly.headline, sessionsOnlyNoRace.headline);
});

test('race phase: the long run line is the status in taper / race week ("Peak long run 14 km — done") and nothing in recovery', () => {
  const taper = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 12), distanceKm: 21.1 } }));
  assert.equal(taper.race?.phase, 'taper');
  assert.equal(reasonOf(taper, 'long_run'), 'Peak long run 14 km — done');
  assert.equal(taper.reasons.some(r => /build to/i.test(r.text)), false);
  const raceWeek = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 4), distanceKm: 21.1 } }));
  assert.equal(reasonOf(raceWeek, 'long_run'), 'Peak long run 14 km — done');
  const recovery = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, -2), distanceKm: 21.1 } }));
  assert.equal(recovery.reasons.some(r => r.kind === 'long_run'), false);
  assert.equal(recovery.longRun?.targetPeakKm, null);
  // Build still builds.
  const build = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 40 }, race: { date: addDays(TODAY, 84), distanceKm: 21.1 } }));
  assert.match(reasonOf(build, 'long_run')!, /build to 18 km by/);
});

test('race phase: the long run lasts the whole taper — the "Long run peak 18 km" status is no longer cut by the volume reason', () => {
  const p = computeGoalProgress(longRunInput([18, 14, 12, 10], { race: { date: addDays(TODAY, 12), distanceKm: 21.1 } }));
  assert.equal(p.race?.phase, 'taper');
  assert.equal(reasonOf(p, 'long_run'), 'Peak long run 18 km — done');
});

test('race phase: without a measured peak week the weekly goal stands in, still capped at the goal', () => {
  const p = computeGoalProgress(phaseInput(12, { racePeakWeekKm: null, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 } }));
  assert.equal(p.distance!.stepTargetKm, 23); // round(30 x 0.75)
  // A peak far above the goal never asks for more than the goal.
  const over = computeGoalProgress(phaseInput(12, { racePeakWeekKm: 60, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 } }));
  assert.equal(over.distance!.stepTargetKm, 30);
});

test('race phase: imperial targets are half miles in the copy, km in the structured fields', () => {
  const p = computeGoalProgress(phaseInput(12, { unitSystem: 'imperial' }));
  assert.equal(p.race?.phase, 'taper');
  // 40 km = 24.85 mi; x0.75 = 18.64 -> 18.5 mi (imperial targets round to the nearest half mile, wave 20).
  assert.match(reasonOf(p, 'race_phase')!, /^Taper: ~18\.5 mi this week/);
  assert.ok(Math.abs(p.distance!.stepTargetKm / 1.609344 - 18.5) < 0.05, `${p.distance!.stepTargetKm}`);
  // The long run in the taper copy is rounded to the nearest half mile.
  assert.match(reasonOf(p, 'race_phase')!, /long run 5 mi easy, plus 3×0\.5 mi at race pace midweek$/);
});

test('race phase: a race with no distance goal and no running history has phase copy without a number', () => {
  const p = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 10), distanceKm: 21.1 } }));
  assert.equal(p.distance, null);
  assert.equal(p.race?.phase, 'taper');
  assert.equal(reasonOf(p, 'race_phase'), 'Taper: cut volume this week — keep the long run easy, plus 3×1 km at race pace midweek');
  const done = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, -4), distanceKm: 21.1 } }));
  assert.equal(done.headline, 'Race done — Oct 2 · recovery week 1');
  assert.equal(reasonOf(done, 'race_phase'), 'Recovery: easy only this week');
});

test('race phase: payload keys are additive and a JSON round trip drops the absent daysSince', () => {
  const build = JSON.parse(JSON.stringify(computeGoalProgressRaw(phaseInput(84)))) as GoalProgress;
  assert.deepEqual(Object.keys(build.race!).sort(), ['date', 'daysToGo', 'distanceKm', 'label', 'phase', 'weeksToGo']);
  const done = JSON.parse(JSON.stringify(computeGoalProgressRaw(phaseInput(-2)))) as GoalProgress;
  assert.deepEqual(Object.keys(done.race!).sort(), ['date', 'daysSince', 'daysToGo', 'distanceKm', 'label', 'phase', 'weeksToGo']);
});

// ── Endurance long run / race readiness ─────────────────────────────────────

/**
 * One long run per week at days-ago 3 / 10 / 17 / 24 (newest first) plus a 5 km easy run on the Monday of each week
 * (and one on the Monday before the oldest, so the weeks are 15 / 21 / 17 / 19 km — steady, no spike).
 */
function longRunInput(longKm: number[], over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  const kmByDaysAgo: Record<number, number> = {};
  longKm.forEach((km, i) => {
    kmByDaysAgo[3 + i * 7] = km;
    kmByDaysAgo[1 + i * 7] = 5;
  });
  kmByDaysAgo[1 + longKm.length * 7] = 5;
  // A 40 km weekly goal: big enough to carry the half marathon's 18 km peak (a long run is at most half of a week).
  return distanceInput(kmByDaysAgo, { target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 40 }, ...over });
}

test('longRunTargetKm: 5K 8, 10K 14, half 18, marathon 32, other 85%, null without a distance', () => {
  assert.equal(longRunTargetKm(5), 8);
  assert.equal(longRunTargetKm(10), 14);
  assert.equal(longRunTargetKm(21.1), 18);
  assert.equal(longRunTargetKm(21.0975), 18);
  assert.equal(longRunTargetKm(42.2), 32);
  assert.equal(longRunTargetKm(15), 13); // round(12.75)
  assert.equal(longRunTargetKm(30), 26); // round(25.5)
  assert.equal(longRunTargetKm(null), null);
  assert.equal(longRunTargetKm(0), null);
});

test('long run: last long run, 28-day peak and the half-marathon target (running only)', () => {
  const p = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 84), distanceKm: 21.1 } }));
  // lastKm = the longest run of the last 14 days; nextKm = this week's long run from the plan.
  assert.deepEqual(p.longRun, { lastKm: 14, peakKm: 16, targetPeakKm: 18, nextKm: 14 });
  assertWellFormed(p);
});

test('long run: an easy run after the long run does not replace lastKm; non-running workouts are ignored', () => {
  const ride = { day: TODAY, durationMin: 120, distanceKm: 60, type: 'Cycling' };
  const input = longRunInput([14, 12, 16, 10]);
  const p = computeGoalProgress({ ...input, workouts: [...input.workouts, ride, { day: TODAY, durationMin: 30, distanceKm: 3, type: 'Running' }] });
  assert.equal(p.longRun?.lastKm, 14);
  assert.equal(p.longRun?.peakKm, 16);
});

test('long run: runs older than 28 days are ignored; null without running distances or for other goals', () => {
  const old = computeGoalProgress(distanceInput({ 28: 20, 40: 21, 3: 9 }));
  assert.deepEqual(old.longRun, { lastKm: 9, peakKm: 9, targetPeakKm: null, nextKm: 9 });
  const none = computeGoalProgress(enduranceInput([3, 3, 3, 3]));
  assert.equal(none.longRun, null);
  assert.equal(computeGoalProgress(base({ goal: 'muscle' })).longRun, null);
});

test('long run: below target reads "Long run 14 km · build to 18 km by mid-Dec", right after the week plan line', () => {
  // Race Dec 30 → peak long run planned 2 weeks out for a half (Dec 16) → "mid-Dec".
  const p = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: '2026-12-30', distanceKm: 21.1 } }));
  // Race first, what the week is for, then the long run (this week's distance is the card's stat, not a reason).
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'plan', 'long_run']);
  const lr = p.reasons[2];
  assert.equal(lr.text, 'Long run 14 km · build to 18 km by mid-Dec');
  assert.equal(lr.tone, 'neutral');
  assertWellFormed(p);
});

test('long run: peak at/above the target reads "Long run peak 18 km — on target" (good)', () => {
  const p = computeGoalProgress(longRunInput([14, 18, 12, 10], { race: { date: addDays(TODAY, 56), distanceKm: 21.1 } }));
  const lr = p.reasons.find(r => r.kind === 'long_run');
  assert.equal(lr?.text, 'Long run peak 18 km — on target');
  assert.equal(lr?.tone, 'good');
  assert.equal(p.longRun?.peakKm, 18);
});

test('long run: no reason without a race, a race distance or after the race; the object is still exposed', () => {
  const noRace = computeGoalProgress(longRunInput([14, 12, 16, 10]));
  assert.equal(noRace.reasons.some(r => r.kind === 'long_run'), false);
  assert.deepEqual(noRace.longRun, { lastKm: 14, peakKm: 16, targetPeakKm: null, nextKm: 14 });
  const noDistance = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 56), distanceKm: null } }));
  assert.equal(noDistance.reasons.some(r => r.kind === 'long_run'), false);
  assert.equal(noDistance.longRun?.targetPeakKm, null);
  const passed = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, -2), distanceKm: 21.1 } }));
  assert.equal(passed.reasons.some(r => r.kind === 'long_run'), false);
  assert.equal(passed.longRun?.targetPeakKm, null);
});

test('long run: once the peak date has passed inside the build phase it reads "peak target"; marathon target is 32', () => {
  // Sunday 2026-10-11, race Thursday 2026-10-22: the week began 17 days out (still build), the peak long run was due Oct 8.
  // (This week has its runs: a Sunday with four days off and the week barely started is a light week, which has its own test. And Sunday's own run is in
  // (wave 23e): before it the long run is still ahead and the card says what that run is for instead of the long-run status line.)
  const thisWeekRuns = [{ day: '2026-10-08', durationMin: 25, distanceKm: 4, type: 'Running' }, { day: '2026-10-10', durationMin: 25, distanceKm: 4, type: 'Running' }, { day: '2026-10-11', durationMin: 50, distanceKm: 9, type: 'Running' }];
  const sundayBase = longRunInput([14, 12, 16, 10], { todayKey: '2026-10-11', race: { date: '2026-10-22', distanceKm: 21.1 } });
  const p = computeGoalProgress({ ...sundayBase, workouts: [...sundayBase.workouts, ...thisWeekRuns], trainingDays: [...sundayBase.trainingDays, ...thisWeekRuns.map(w => w.day)] });
  assert.equal(p.race?.phase, 'build');
  assert.equal(p.reasons.find(r => r.kind === 'long_run')?.text, 'Long run 14 km · peak target 18 km');
  const m = computeGoalProgress(longRunInput([14, 12, 16, 10], { target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 70 }, race: { date: addDays(TODAY, 120), distanceKm: 42.2 } }));
  assert.equal(m.longRun?.targetPeakKm, 32);
  assert.match(m.reasons.find(r => r.kind === 'long_run')!.text, /^Long run 14 km · build to 32 km by (early|mid-|late )/);
  // A 40 km week carries a 20 km long run at most: the peak is what fits, said once, with what would carry 32 km (wave 20).
  const capped = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 120), distanceKm: 42.2 } }));
  assert.equal(capped.longRun?.targetPeakKm, 20);
  assert.equal(capped.longRun?.raceTargetKm, 32);
  assert.match(capped.reasons.find(r => r.kind === 'long_run')!.text.replace(/\u00a0/g, ' '), /^Long run 14 km · build to 20 km by (early|mid-|late )[A-Za-z]{3}\. Your 40 km weeks fit a 20 km long run; for a 32 km peak, raise the goal to ~64 km$/);
});

test('long run: a run under 5 km (3 mi) is the "longest run", not a "long run"', () => {
  const p = computeGoalProgress(weekInput([[[0, 3]], [[1, 2.5], [3, 3], [5, 3]]], { target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 40 }, race: { date: addDays(TODAY, 84), distanceKm: 21.1 } }));
  assert.match(p.reasons.find(r => r.kind === 'long_run')!.text, /^Longest run 3 km · build to 18 km by /);
  // The next one would be 3 + 2 km, but a long run is at most half of the week (wave 20: 4.5 of ~9 km), so it is still the "longest run".
  assert.equal(p.distance!.plan!.purpose, '~9 km this week: longest run 4.5 km, the rest easy runs');
});

test('long run: text is unit-aware (miles) while structured km stay metric', () => {
  const p = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 84), distanceKm: 21.1 }, unitSystem: 'imperial' }));
  assert.equal(p.longRun?.lastKm, 14);
  assert.equal(p.longRun?.targetPeakKm, 18);
  // The target is rounded to the nearest half mile: 18 km is "11 mi", never "11.2 mi".
  assert.ok(p.reasons.find(r => r.kind === 'long_run')!.text.startsWith('Long run 8.7 mi · build to 11 mi by'));
});

test('long run: also shown with little data (race still leads, then the plan line, cap 3)', () => {
  const p = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 84), distanceKm: 21.1 } }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'plan', 'long_run']);
  assert.equal(p.reasons.some(r => r.kind === 'week_distance'), false);
  assert.ok(p.reasons.length <= 3);
});

// ── Endurance "Why" selection: race, then what the week is for, then watch / long run ──

/** A building distance runner (15, 17, 19, 21 km weeks, each on its step) 12 weeks from a half marathon. */
const BUILDING_WEEKS = (): Array<Array<[number, number]>> => [[], wkOf(21), wkOf(19), wkOf(17), wkOf(15)];
const HALF_IN_12_WEEKS = { race: { date: addDays(TODAY, 84), distanceKm: 21.1 } };
/** Daily series that is `recent` for the last 14 days and `prior` before that. */
const twoHalves = (recent: number, prior: number) =>
  Array.from({ length: 28 }, (_, i) => ({ day: addDays(TODAY, -i), value: i < 14 ? recent : prior }));

test('endurance Why: race, then what the week is for, then the long run — never this week\'s distance', () => {
  const p = computeGoalProgress(weekInput(BUILDING_WEEKS(), HALF_IN_12_WEEKS));
  assert.equal(p.verdict, 'building');
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'plan', 'long_run']);
  // The plan line is the week's one target and its long run; the volume growth lives in the headline, once.
  assert.equal(p.reasons[1].text, '~23 km this week: long run 10.5 km, the rest easy runs');
  // The half marathon's 18 km peak does not fit a 30 km goal (a long run is at most half of a week): the peak is 15 km (wave 20).
  assert.match(p.reasons[2].text, /^Long run 8\.4 km · build to 15 km by /);
  assert.equal(p.reasons.some(r => r.kind === 'week_distance' || r.kind === 'volume'), false);
  assert.match(p.distance!.text, /of ~23 km running this week · goal 30 km$/);
  assertWellFormed(p);
});

test('endurance Why: a watch-tone recovery reason outranks the long run and is never cut', () => {
  // Resting HR up 6 bpm over the last 2 weeks (watch); HRV flat.
  const p = computeGoalProgress(weekInput(BUILDING_WEEKS(), { ...HALF_IN_12_WEEKS, restingHr: twoHalves(58, 52), hrv: twoHalves(60, 60) }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'plan', 'resting_hr']);
  const rhr = p.reasons[2];
  assert.equal(rhr.tone, 'watch');
  assert.match(rhr.text, /^Resting heart rate trending up: 52 → 58 bpm/);
  assert.equal(p.reasons.some(r => r.kind === 'long_run'), false);
  // A falling HRV is a watch too.
  const hrv = computeGoalProgress(weekInput(BUILDING_WEEKS(), { ...HALF_IN_12_WEEKS, hrv: twoHalves(50, 70) }));
  assert.deepEqual(hrv.reasons.map(r => r.kind), ['race', 'plan', 'hrv']);
  assert.equal(hrv.reasons[2].tone, 'watch');
});

test('endurance Why: a good recovery trend does not displace the long run', () => {
  const p = computeGoalProgress(weekInput(BUILDING_WEEKS(), { ...HALF_IN_12_WEEKS, restingHr: twoHalves(50, 54) }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'plan', 'long_run']);
});

test('endurance Why without a race: the plan line first, then every watch-tone reason ahead of the rest (cap 3)', () => {
  const p = computeGoalProgress(weekInput(BUILDING_WEEKS(), { restingHr: twoHalves(58, 52), hrv: twoHalves(50, 70) }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['plan', 'resting_hr', 'hrv']);
  assert.deepEqual(p.reasons.map(r => r.tone), ['neutral', 'watch', 'watch']);
  // No watch: the remaining slots go to the usual order (sessions before resting HR / HRV).
  const calm = computeGoalProgress(weekInput(BUILDING_WEEKS(), { restingHr: twoHalves(52, 52), hrv: twoHalves(60, 60) }));
  assert.deepEqual(calm.reasons.map(r => r.kind), ['plan', 'sessions', 'resting_hr']);
});

test('endurance Why: a lighter last week is still described by its plan line first, the watch reasons right behind', () => {
  const p = computeGoalProgress(weekInput([[], wkOf(14), wkOf(24), wkOf(22), wkOf(20)], { ...HALF_IN_12_WEEKS, restingHr: twoHalves(58, 52) }));
  assert.equal(p.reasons[0].kind, 'race');
  assert.equal(p.reasons[1].kind, 'plan');
  assert.equal(p.reasons[2].kind, 'resting_hr');
  assert.equal(p.reasons.length, 3);
});

// ── Wave 19: the card reads the SAME week plan as the weekly review ─────────

test('baseline: the first week of running has no step — "Baseline week", nothing to be behind on', () => {
  // Fifteen km in four runs in the first week (TODAY is Tuesday, so the week is Mon 5 - Tue 6 here: put it on the Sunday).
  const sunday = '2026-10-11';
  const week = (runs: Array<[number, number]>) => weekInput([runs.map(([d, km]) => [d, km] as [number, number])], { todayKey: sunday });
  const p = computeGoalProgress(week([[1, 3], [3, 3], [5, 3], [6, 6]]));
  assert.equal(p.distance!.plan?.kind, 'baseline');
  assert.equal(p.verdict, 'building');
  assert.equal(p.headline, "Baseline week — 15 km so far; next week's step is built from this week");
  assert.equal(p.distance!.text, '15 km so far · baseline week');
  assert.equal(p.distance!.stepTargetKm, 30); // no step to quote: the goal, as before
  assert.equal(p.distance!.avg4wKm, null); // no finished week yet
  assert.equal(p.reasons.some(r => r.kind === 'volume'), false);
  assertWellFormed(p);
  // The very first run already reads as a baseline, not "Log a few more sessions".
  assert.equal(computeGoalProgress(week([[1, 3]])).headline, "Baseline week — 3 km so far; next week's step is built from this week");
});

test('spike on the card: "Over the safe step — 40 of ~25 km. Hold ~28 km next week", verdict holding, no "distance up X%"', () => {
  const sunday = '2026-10-11'; // this week = the 40 km spike over a ~25 km step
  const p = computeGoalProgress(weekInput([wkOf(40), wkOf(23), wkOf(21), wkOf(19), wkOf(17), wkOf(15)], { todayKey: sunday }));
  assert.equal(p.verdict, 'holding');
  assert.equal(p.headline, 'Over the safe step — 40 of ~25 km. Hold ~28 km next week');
  const watch = p.reasons.find(r => r.tone === 'watch')!;
  assert.equal(watch.kind, 'volume');
  assert.match(watch.text, /^40 km is 15 km over this week's safe step; big jumps raise injury risk/);
  assert.equal(p.reasons.some(r => r.tone === 'good' && r.kind === 'volume'), false);
  assert.doesNotMatch(p.headline, /up \d+%|Building/);
  assertWellFormed(p);
  // The week after, the card holds one step up from the STEP (28 km), never from the jump.
  const monday = '2026-10-12';
  const hold = computeGoalProgress(weekInput([[], wkOf(40), wkOf(23), wkOf(21), wkOf(19), wkOf(17), wkOf(15)], { todayKey: monday }));
  assert.equal(hold.distance!.plan?.kind, 'hold');
  assert.equal(hold.verdict, 'holding');
  assert.equal(hold.headline, 'Over the safe step last week — hold ~28 km this week');
  assert.equal(hold.distance!.stepTargetKm, 28);
});

test('a break: "On a break — 7 days since your last run. Restart at ~N km." (building, never behind), then "Building back"', () => {
  // Weeks of 30 km, the last run Tuesday of last week: seven days without a run on this Tuesday.
  const weeks: Array<Array<[number, number]>> = [[], [[1, 6]], wkOf(30), wkOf(30), wkOf(30), wkOf(30)];
  const p = computeGoalProgress(weekInput(weeks));
  assert.equal(p.verdict, 'building');
  assert.equal(p.headline, 'On a break — 7 days since your last run. Restart at ~18 km.');
  assert.equal(p.distance!.plan?.kind, 'restart');
  assert.equal(p.distance!.stepTargetKm, 18); // 60% of the median 30 km week
  assert.equal(p.distance!.text, '0 km this week · on a break'); // not the stale week target ("0 of ~18 km"): the headline quotes the restart
  // Back on the road: a restart week, not the goal.
  const back = computeGoalProgress(weekInput([[[0, 5]], [[1, 6]], wkOf(30), wkOf(30), wkOf(30), wkOf(30)]));
  assert.equal(back.verdict, 'building');
  assert.equal(back.headline, 'Building back — restart at ~18 km this week');
  assert.equal(back.distance!.stepTargetKm, 18);
  assertWellFormed(back);
});

test('maintain: at the weekly goal in the build phase the card is on_track with the long run status', () => {
  const race = { race: { date: addDays(TODAY, 56), distanceKm: 21.1 } };
  const weeks = [[[0, 3]] as Array<[number, number]>, wkOf(30), wkOf(30), wkOf(30), wkOf(30)];
  const p = computeGoalProgress(weekInput(weeks, race));
  assert.equal(p.verdict, 'on_track');
  // A 30 km week carries a 15 km long run at most (half of the week), not the half marathon's 18 km peak (wave 20).
  assert.equal(p.headline, 'On track for the half — long run 12 of 15 km');
  assert.equal(p.distance!.plan?.kind, 'maintain');
  assert.equal(p.distance!.plan?.longRunKm, 14);
  assert.equal(p.longRun?.nextKm, 14);
  assert.equal(p.distance!.text, '3 of 30 km running this week');
  // Once the peak is reached the headline says so; with no race it is "On track — 30 km a week".
  // (A peak that kept to the plan: 13.5 km, then 15 km - the step of 2 km capped at the 15 km a 30 km week can carry.)
  const peak = computeGoalProgress(weekInput([[[0, 3]], [[1, 5], [3, 5], [5, 5], [6, 15]], [[1, 5.5], [3, 5.5], [5, 5.5], [6, 13.5]], wkOf(30), wkOf(30)], race));
  assert.equal(peak.headline, 'On track for the half — long run peak 15 km reached');
  // ... and one that broke it (18 km after 12) is not praised (wave 22e).
  const broke = computeGoalProgress(weekInput([[[0, 3]], [[1, 6], [3, 6], [5, 6], [6, 18]], wkOf(30), wkOf(30), wkOf(30)], race));
  assert.equal(broke.headline, 'On track for the half — 30 km a week');
  assert.equal(computeGoalProgress(weekInput(weeks)).headline, 'On track — 30 km a week');
});

test('the verdict rests on the last finished week: no flip between rest days and run days, no partial week in "averaging"', () => {
  const weeks = [wkOf(21), wkOf(19), wkOf(17), wkOf(15)];
  const headlines = new Set<string>();
  for (const todayKey of ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-10', '2026-10-11']) {
    const p = computeGoalProgress(weekInput([wkOf(23), ...weeks], { todayKey }));
    // Monday to Saturday it is last week's read; the last day (Sunday) judges the week that is done (wave 22e).
    if (todayKey !== '2026-10-11') headlines.add(`${p.verdict}|${p.headline}`);
    else assert.equal(p.headline, 'Week done — 23 of ~23 km, on plan');
    assert.equal(p.distance!.avg4wKm, 18); // the 4 finished weeks (21, 19, 17, 15) only
  }
  assert.deepEqual([...headlines], ['building|Building — 21 km last week (+11%), on plan']);
});

test('copy polish: "1 session" not "1 sessions", a flat volume is "steady" not "up 0%", an imperial long run is rounded', () => {
  // One session a week over the last 4 weeks (sessions goal, no distance).
  const noGoal = { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 };
  const one = computeGoalProgress(enduranceInput([1, 1, 1, 1], { target: noGoal }));
  // Wave 21e: whole calendar weeks ("1 session a week over the last 3 weeks"), never an average over a moving part-week window.
  assert.match(one.reasons.find(r => r.kind === 'sessions')!.text, /^1 session a week over the last 3 weeks$/);
  assert.doesNotMatch(JSON.stringify(one), /1 sessions/);
  const twoFive = computeGoalProgress(enduranceInput([2, 3, 2, 3], { target: noGoal }));
  assert.match(twoFive.reasons.find(r => r.kind === 'sessions')!.text, /^2 or 3 sessions a week over the last 3 weeks$/);
  // Flat time volume: "steady", no "up 0%".
  const flat = computeGoalProgress(enduranceInput([3, 3, 3, 3], { target: noGoal }));
  assert.match(flat.reasons.find(r => r.kind === 'volume')!.text, /^Weekly training time steady \(/);
  assert.doesNotMatch(JSON.stringify(flat), /up 0%|down 0%/);
});

// ── non-breaking spaces: a value never wraps mid-token (asserts the RAW copy) ──

test('wave 21 copy glues numbers to units with U+00A0 in kg and lb: the lift-by-lift comeback headline, its reasons, the lapse weight line', () => {
  for (const [unitSystem, unit, pre, since] of [['metric', 'kg', '158', '155'], ['imperial', 'lb', '348', '342']] as const) {
    const raw = computeGoalProgressRaw(longBreakInput({ squat: LONG_BREAK_SQUAT, deadlift: longBreakDeadlift(150, 155) }, { unitSystem }));
    assert.equal(raw.headline, `Squat back above pre-break; deadlift at 98% (${since} of ${pre}${NBSP}${unit} est. 1RM)`);
    assert.equal(raw.reasons[0].text, `Deadlift est. 1RM ${since}${NBSP}${unit}, 98% of your ${pre}${NBSP}${unit} pre-break best`);
    assert.ok(!new RegExp(`\\d (kg|lb)\\b`).test(`${raw.headline} ${raw.reasons.map(r => r.text).join(' ')}`), 'no number is followed by a breaking space + unit');
    const lapse = computeGoalProgressRaw(lapseInput(14, { weightReadings: ramp(30, 80, 0.03), unitSystem }));
    const rate = lapse.reasons.find(r => r.kind === 'rate')!;
    assert.match(rate.text, new RegExp(`^Trend weight up about \\d\\.\\d${NBSP}${unit}/wk with no training$`));
  }
});

test('display copy joins numbers to units and "a → b" pairs with U+00A0', () => {
  // Lift reason: "+5 kg" and "(100 → 105 kg)" stay whole; words around them keep plain spaces.
  const muscle = computeGoalProgressRaw(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i * 2)),
    intakeDays: Array.from({ length: 7 }, (_, i) => ({ day: addDays(TODAY, -i), kcal: 2800, proteinG: 170, source: 'logged' as const })),
    budget: { targetKcal: 2800, proteinG: 170, floorKcal: 1500, formulaTdee: null, learnedTdee: null, tdeeConfidence: null },
  }));
  const lift = muscle.reasons.find(r => r.kind === 'lift')!;
  assert.ok(lift.text.includes(`+5${NBSP}kg vs 4 weeks ago (100${NBSP}→${NBSP}105${NBSP}kg)`), lift.text);
  assert.ok(muscle.reasons.some(r => r.kind === 'protein' && r.text.includes(`170${NBSP}g protein target`)));

  // Weight headline: kg / lb.
  const loss = computeGoalProgressRaw(base({
    target: { weightKg: 70, date: null, weeklySessions: null },
    weightReadings: ramp(40, 90, -0.07),
  }));
  assert.match(loss.headline, new RegExp(`\\d${NBSP}kg to go`));
  const imperial = computeGoalProgressRaw(base({
    unitSystem: 'imperial',
    target: { weightKg: 70, date: null, weeklySessions: null },
    weightReadings: ramp(40, 90, -0.07),
  }));
  assert.match(imperial.headline, new RegExp(`\\d${NBSP}lb to go`));

  // Distance copy: km.
  const run = computeGoalProgressRaw(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 56), distanceKm: 21.1 } }));
  assert.ok(run.reasons.find(r => r.kind === 'long_run')!.text.startsWith(`Long run 14${NBSP}km`));
  assert.ok(run.distance?.text.includes(`${NBSP}km running this week`), run.distance?.text);
  assert.ok(!/\d (km|kg|lb)\b/.test(run.reasons.map(r => r.text).join(' ')), 'no number is followed by a breaking space + unit');
});

// ── Honest verdicts: goal reached ───────────────────────────────────────────

/** The same readings, moved `days` earlier (the user stopped weighing in). */
function shiftReadings(readings: WeightReading[], days: number): WeightReading[] {
  return readings.map(r => {
    const localDay = addDays(r.localDay, -days);
    return { ...r, localDay, measuredAt: `${localDay}T08:00:00.000Z` };
  });
}

function reachedLossInput(over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return base({
    target: { weightKg: 86, date: null, weeklySessions: null },
    start: { weightKg: 92, startedAt: '2026-08-01T00:00:00.000Z' },
    weightReadings: ramp(40, 88, -0.07),
    ...over,
  });
}

/** Reached 6 days ago (the weekly average got within 0.3 kg of 85.6 kg then): inside the first week, when the next step is still asked. */
function justReachedInput(over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return reachedLossInput({ target: { weightKg: 85.6, date: null, weeklySessions: null }, ...over });
}

test('reached (weight loss): headline names the target and the day the trend crossed it; reachedAt is that day', () => {
  const readings = ramp(40, 88, -0.07);
  const p = computeGoalProgress(reachedLossInput());
  // Reached the first day the 7-day raw mean is within 0.3 kg of the target (or the trend within 0.1 kg): the mean leads the lagging trend.
  const trendDays = computeWeightTrend(readings).days;
  const crossing = trendDays.find((d, i) => {
    const week = trendDays.slice(Math.max(0, i - 6), i + 1);
    const mean = week.reduce((a, w) => a + w.rawKg, 0) / week.length;
    return (week.length >= 3 && mean <= 86.3) || d.trendKg <= 86.1;
  });
  assert.ok(crossing, 'fixture crosses the target');
  assert.equal(p.verdict, 'reached');
  assert.equal(p.reachedAt, crossing!.day);
  assert.ok(p.reachedAt! < trendDays.find(d => d.trendKg <= 86.1)!.day, 'the weekly mean calls it before the lagging trend does');
  assert.match(p.headline, /^Goal reached — 86 kg \(\w{3} \d{1,2}\)$/);
  assert.equal(p.current.progressPct, 100);
  assert.equal(p.eta, null);
  assertWellFormed(p);
});

test('reached (weight loss): reasons lead with the reach, drop the green safe-band rate, end with the next step', () => {
  // Wave 21w: the next step ("Set a new target or switch to maintenance") is asked in the first 7 days after the reach only.
  const p = computeGoalProgress(justReachedInput());
  assert.deepEqual(p.reasons.map(r => r.kind), ['reached', 'position', 'next_step']);
  assert.equal(p.reasons[0].tone, 'good');
  // Wave 22w: an average that is not exactly the target is not printed as the reach - it says how close it is.
  assert.match(p.reasons[0].text, /^You hit 85\.6 kg — weekly average within 0\.\d kg of your target, first reached \w{3} \d{1,2}$/);
  assert.doesNotMatch(p.reasons[0].text, /at or past/);
  // Wave 22w: switching to maintenance is a number - the step from the budget; wave 23w: for someone who logs no food (as here) it is a food,
  // and it says why it is asked now.
  // (The reach was in the week before this Monday: the step was given then, so the question carries it as the standing level.)
  assert.equal(p.reasons[2].kind, 'next_step');
  assert.equal(p.reasons[2].tone, 'neutral');
  assert.match(p.reasons[2].text, /^Set a new target or switch to maintenance — keep the daily snack \(the step you started \w{3} \d{1,2}\); we'll read it on \w{3}, \w{3} \d{1,2}$/);
  // Continued loss is not "inside the safe band" any more.
  assert.ok(!p.reasons.some(r => r.kind === 'rate' || /safe band/.test(r.text)));
  // Weekly average ~85.5 kg vs 86 kg: within 1 kg.
  assert.equal(p.reasons[1].kind, 'position');
  assert.match(p.reasons[1].text, /^Holding at 85\.\d kg, within 1 kg of 85\.6 kg$/);
  assert.equal(p.reasons[1].tone, 'neutral');
  assertWellFormed(p);
  // Past that first week the question is not asked again every day (it was shown daily for 25 days) - wave 22w: for the first 3 weeks of
  // maintenance the step toward it is the next step instead (about 16 days after the reach here)...
  const later = computeGoalProgress(reachedLossInput());
  assert.deepEqual(later.reasons.map(r => r.kind), ['reached', 'position', 'next_step']);
  assert.doesNotMatch(later.reasons[2].text, /Set a new target/);
  // ...and after that the step has been read and the card carries the kept level (wave 23w: a snack here, no food is logged) - never the question.
  const muchLater = computeGoalProgress(reachedLossInput({ weightReadings: ramp(60, 88, -0.07) }));
  assert.equal(muchLater.verdict, 'reached');
  assert.ok(!muchLater.reasons.some(r => /Set a new target/.test(r.text)), JSON.stringify(muchLater.reasons));
  assert.match(muchLater.reasons.find(r => r.kind === 'next_step')?.text ?? '', /^Keep the daily snack — it's your maintenance/);
});

test('reached (weight loss): well past the target reads "Below target by X kg"; imperial reads lb', () => {
  const p = computeGoalProgress(reachedLossInput({ target: { weightKg: 90, date: null, weeklySessions: null } }));
  assert.equal(p.verdict, 'reached');
  const pos = p.reasons.find(r => r.kind === 'position')!;
  assert.match(pos.text, /^Below target by \d+(\.\d)? kg$/);
  assert.equal(pos.tone, 'neutral');
  const lb = computeGoalProgress(reachedLossInput({ target: { weightKg: 90, date: null, weeklySessions: null }, unitSystem: 'imperial' }));
  assert.match(lb.headline, /^Goal reached — 198\.4 lb/);
  assert.match(lb.reasons.find(r => r.kind === 'position')!.text, /^Below target by \d+(\.\d)? lb$/);
});

test('reached (weight loss): a target date still reads on pace; under-eating keeps its watch slot ahead of the position', () => {
  const dated = computeGoalProgress(reachedLossInput({ target: { weightKg: 86, date: addDays(TODAY, 30), weeklySessions: null } }));
  assert.equal(dated.verdict, 'reached');
  assert.equal(dated.onPaceForTargetDate, true);
  const intakeDays = Array.from({ length: 7 }, (_, i) => ({ day: addDays(TODAY, -i), kcal: 900, proteinG: 60, source: 'logged' as const }));
  const eating = computeGoalProgress(justReachedInput({
    intakeDays,
    budget: { targetKcal: 1900, proteinG: 150, floorKcal: 1500, formulaTdee: null, learnedTdee: null, tdeeConfidence: null },
  }));
  assert.deepEqual(eating.reasons.map(r => r.kind), ['reached', 'under_eating', 'next_step']);
});

test('reachedAt is null when the crossing is unknown: goal started past the target, or no earlier weigh-in', () => {
  // The goal began after the trend was already under the target.
  const startedAfter = computeGoalProgress(reachedLossInput({
    start: { weightKg: null, startedAt: `${addDays(TODAY, -1)}T09:00:00.000Z`, startedDay: addDays(TODAY, -1) },
  }));
  assert.equal(startedAfter.verdict, 'reached');
  assert.equal(startedAfter.reachedAt, null);
  assert.match(startedAfter.headline, /^Goal reached — 86 kg$/);
  assert.equal(startedAfter.current.progressPct, 100);
  // Weigh-ins only ever at/under the target.
  const alwaysUnder = computeGoalProgress(reachedLossInput({ weightReadings: ramp(30, 85, -0.02) }));
  assert.equal(alwaysUnder.verdict, 'reached');
  assert.equal(alwaysUnder.reachedAt, null);
  // Not reached → null.
  assert.equal(computeGoalProgress(base({ target: { weightKg: 80, date: null, weeklySessions: null }, weightReadings: ramp(40, 90, -0.07) })).reachedAt, null);
  // Non-weight goals never carry it.
  assert.equal(computeGoalProgress(base({ goal: 'general' })).reachedAt, null);
});

function reachedMuscleInput(over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return base({
    goal: 'muscle',
    target: { weightKg: 78, date: null, weeklySessions: 4 },
    start: { weightKg: 75, startedAt: '2026-08-01T00:00:00.000Z' },
    weightReadings: ramp(60, 76, 0.05), // trend ends ~78.5 kg: past the 78 kg target
    trainingDays: Array.from({ length: 15 }, (_, i) => addDays(TODAY, -i)), // 15 of 16 planned
    ...over,
  });
}

test('reached (muscle): weight target met, sessions on plan, no stalled lift → reached with the next step', () => {
  const none = computeGoalProgress(reachedMuscleInput());
  assert.equal(none.verdict, 'reached');
  assert.match(none.headline, /^Goal reached — 78 kg/);
  assert.equal(none.reasons[0].kind, 'reached');
  assert.equal(none.reasons[none.reasons.length - 1].kind, 'next_step');
  assert.equal(none.current.progressPct, 100);
  assert.ok(none.reachedAt);
  assertWellFormed(none);
  // Lifts still going up: reached, with the lift reason kept beside it.
  const up = computeGoalProgress(reachedMuscleInput({ progression: lifts(100, 105) }));
  assert.equal(up.verdict, 'reached');
  assert.deepEqual(up.reasons.map(r => r.kind), ['reached', 'lift', 'next_step']);
});

test('reached (muscle): reaching the weight target never hides training feedback — behind, then stalled, then reached', () => {
  const behind = computeGoalProgress(reachedMuscleInput({
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 9 }, (_, i) => addDays(TODAY, -i)), // 56%
  }));
  assert.equal(behind.verdict, 'behind');
  assert.match(behind.headline, /^Lifts up, sessions behind/);
  assert.ok(behind.reasons.some(r => r.kind === 'adherence'));
  const behindNoLifts = computeGoalProgress(reachedMuscleInput({
    trainingDays: Array.from({ length: 5 }, (_, i) => addDays(TODAY, -i)),
  }));
  assert.equal(behindNoLifts.verdict, 'behind');
  assert.match(behindNoLifts.headline, /^Sessions behind — 5 of 16 planned$/);
  const stalled = computeGoalProgress(reachedMuscleInput({ progression: lifts(100, 100) }));
  assert.equal(stalled.verdict, 'stalled');
  assert.match(stalled.headline, /no lift is up 1%/);
  // Sessions behind outranks a stalled lift.
  const both = computeGoalProgress(reachedMuscleInput({
    progression: lifts(100, 100),
    trainingDays: Array.from({ length: 5 }, (_, i) => addDays(TODAY, -i)),
  }));
  assert.equal(both.verdict, 'behind');
  // The reach is still reported for the card.
  assert.equal(stalled.current.progressPct, 100);
  assert.ok(stalled.reachedAt);
});

// ── Honest verdicts: staleness guard ────────────────────────────────────────

test('stale weigh-in (> 14 days): insufficient_data with a weigh-in headline, no ETA, no on-pace flag', () => {
  const p = computeGoalProgress(lossInput({
    target: { weightKg: 80, date: addDays(TODAY, 60), weeklySessions: null },
    weightReadings: shiftReadings(ramp(40, 95, -0.07), 20),
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.headline, 'Last weigh-in 20 days ago — weigh in to update your progress');
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assert.equal(p.lastWeighInDaysAgo, 20);
  assertWellFormed(p);
  // 14 days is still inside the aging band, 15 is stale.
  assert.notEqual(computeGoalProgress(lossInput({ weightReadings: shiftReadings(ramp(40, 95, -0.07), 14) })).verdict, 'insufficient_data');
  assert.equal(computeGoalProgress(lossInput({ weightReadings: shiftReadings(ramp(40, 95, -0.07), 15) })).verdict, 'insufficient_data');
});

test('a goal already reached does not read "reached" off a weigh-in more than 14 days old', () => {
  const p = computeGoalProgress(reachedLossInput({ weightReadings: shiftReadings(ramp(40, 88, -0.07), 20) }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.reachedAt, null);
});

test('aging weigh-in (7-14 days): verdict kept, no ETA/pace, headline drops the date, reason says how old', () => {
  const readings = ramp(40, 95, -0.07);
  const fresh = computeGoalProgress(lossInput({ weightReadings: readings }));
  const aging = computeGoalProgress(lossInput({ weightReadings: shiftReadings(readings, 9) }));
  assert.equal(aging.verdict, fresh.verdict);
  assert.ok(fresh.eta, 'a fresh weigh-in still projects a date');
  assert.match(fresh.headline, /, around \w{3} \d{1,2}(, \d{4})?$/);
  assert.equal(aging.eta, null);
  assert.equal(aging.onPaceForTargetDate, null);
  assert.doesNotMatch(aging.headline, /around/);
  // (The week began with the weigh-in already a week old: what the card says about the scale is dated - wave 23w.)
  assert.match(aging.headline, /^As of \w{3} \d{1,2}: [A-Za-z ]+ — about [\d.]+ kg to go$/);
  assert.deepEqual(aging.reasons.map(r => r.kind).slice(0, 2), ['rate', 'weigh_in_age']);
  assert.equal(aging.reasons[1].text, 'Based on a weigh-in 9 days ago');
  // 6 days old is still fresh.
  const recent = computeGoalProgress(lossInput({ weightReadings: shiftReadings(readings, 6) }));
  assert.ok(recent.eta);
  assert.ok(!recent.reasons.some(r => r.kind === 'weigh_in_age'));
  assertWellFormed(aging);
});

test('an ETA already in the past is never pushed forward to today to beat the target date', () => {
  const readings = shiftReadings(ramp(40, 95, -0.07), 6);
  const days = computeWeightTrend(readings).days;
  const lastDay = days[days.length - 1].day;
  const weekMean = days.slice(-7).reduce((a, d) => a + d.rawKg, 0) / 7;
  // 0.33 kg above the target by the weekly mean, at ~0.5 kg/wk: about 5 days after the weigh-in, i.e. yesterday.
  const p = computeGoalProgress(lossInput({
    target: { weightKg: Math.round((weekMean - 0.33) * 100) / 100, date: addDays(TODAY, 90), weeklySessions: null },
    weightReadings: readings,
  }));
  assert.equal(p.lastWeighInDaysAgo, 6);
  assert.ok(p.eta, 'expected a projected date');
  assert.ok(p.eta! > lastDay && p.eta! < TODAY, `eta ${p.eta} stays between the weigh-in (${lastDay}) and today (${TODAY})`);
  assert.match(p.headline, /, any day now$/);
});

test('muscle: a stale weigh-in drives no "reached", rate or weight-based verdict', () => {
  const stale = shiftReadings(ramp(60, 76, 0.05), 20);
  const p = computeGoalProgress(reachedMuscleInput({ weightReadings: stale, trainingDays: [] }));
  assert.notEqual(p.verdict, 'reached');
  assert.equal(p.reachedAt, null);
  assert.ok(!p.reasons.some(r => r.kind === 'rate' || r.kind === 'reached'));
  // Lift data keeps its own verdict regardless of the weigh-in.
  const lifting = computeGoalProgress(reachedMuscleInput({ weightReadings: stale, progression: lifts(100, 105) }));
  assert.equal(lifting.verdict, 'progressing');
  assert.equal(lifting.reachedAt, null);
  // Nothing else to go on: the stale weigh-in is named.
  const bare = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: 78, date: null, weeklySessions: null }, weightReadings: stale,
  }));
  assert.equal(bare.verdict, 'insufficient_data');
  assert.match(bare.headline, /^Last weigh-in 20 days ago/);
});

test('muscle weight-rate verdict (no lift baseline) is "behind" — never "Progressing" — when sessions are behind', () => {
  const mk = (sessions: number) => computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 85, date: null, weeklySessions: 4 },
    weightReadings: ramp(60, 75, 0.04), // inside the gain band
    trainingDays: Array.from({ length: sessions }, (_, i) => addDays(TODAY, -i)),
  }));
  const stopped = mk(2);
  assert.equal(stopped.verdict, 'behind');
  assert.match(stopped.headline, /^Sessions behind — 2 of 16 planned$/);
  assert.equal(mk(15).verdict, 'progressing');
});

// ── Honest verdicts: start-date-aware windows ───────────────────────────────

const startedDaysAgo = (n: number) => ({ weightKg: null, startedAt: `${addDays(TODAY, -n)}T09:00:00.000Z`, startedDay: addDays(TODAY, -n) });

test('planned sessions scale with the weeks since the goal began (min 1 week, max 4)', () => {
  const mk = (daysAgo: number | null, done: number) => computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    start: daysAgo == null ? { weightKg: null, startedAt: null } : startedDaysAgo(daysAgo),
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: done }, (_, i) => addDays(TODAY, -i)),
  }));
  // Began 9 days ago (10 calendar days incl. today) → 10-day window, ~1.4 weeks → 6 planned.
  const young = mk(9, 6);
  assert.deepEqual(young.adherence, { done: 6, planned: 6, weeklyTarget: 4, pct: 100, windowDays: 10 });
  // The first 28 days count calendar weeks, never a plan prorated to a part-week (wave 20b). TODAY is a Tuesday: 2 sessions this week.
  assert.equal(young.reasons.find(r => r.kind === 'adherence')!.text, 'This week 2 of 4 (6 since Sep 27)');
  assert.equal(young.verdict, 'progressing');
  // Began yesterday: never under one week.
  assert.deepEqual(mk(1, 3).adherence, { done: 3, planned: 4, weeklyTarget: 4, pct: 75, windowDays: 7 });
  // Established (or unknown start): the full 4 weeks.
  assert.deepEqual(mk(60, 9).adherence, { done: 9, planned: 16, weeklyTarget: 4, pct: 56, windowDays: 28 });
  assert.deepEqual(mk(null, 9).adherence, { done: 9, planned: 16, weeklyTarget: 4, pct: 56, windowDays: 28 });
  // Sessions from before the window do not inflate a young goal's adherence.
  const preGoal = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    start: startedDaysAgo(9),
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i * 2)), // 5 within 10 days, 12 within 28
  }));
  assert.equal(preGoal.adherence?.done, 5);
  assert.equal(preGoal.adherence?.planned, 6);
});

test('sessions reason without a target names the real window', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 85, date: null, weeklySessions: null },
    start: startedDaysAgo(9),
    progression: lifts(100, 105),
    trainingDays: [TODAY, addDays(TODAY, -3), addDays(TODAY, -6)],
  }));
  assert.equal(p.reasons.find(r => r.kind === 'sessions')!.text, 'Averaging 2.1 sessions a week over the last 10 days');
});

test('general: "Active on N of the last D days" uses the goal age (max 28) and does not claim a 2-week comparison', () => {
  const days = [TODAY, addDays(TODAY, -1), addDays(TODAY, -3), addDays(TODAY, -4)];
  const input = (daysAgo: number) => base({
    goal: 'general',
    start: startedDaysAgo(daysAgo),
    trainingDays: days,
    intakeDays: days.map(day => ({ day, kcal: 2000, proteinG: 100, source: 'logged' as const })),
    sleepMinutes: days.map(day => ({ day, value: 470 })),
  });
  const young = computeGoalProgress(input(5));
  assert.equal(young.reasons[0].text, 'Active on 4 of the last 6 days');
  assert.equal(young.reasons.find(r => r.kind === 'logging')!.text, 'Logged food on 4 of the last 6 days');
  assert.equal(young.verdict, 'holding');
  assert.match(young.headline, /^Early days — habit consistency \d+% so far$/);
  assert.equal(computeGoalProgress(input(100)).reasons[0].text, 'Active on 4 of the last 28 days');
});

test('weight pace is a line through the last 3 weeks of weigh-ins; a younger goal has an early read instead of a rate', () => {
  const short = computeGoalProgress(base({
    target: { weightKg: 80, date: null, weeklySessions: null },
    start: { weightKg: 90, startedAt: `${addDays(TODAY, -9)}T08:00:00.000Z` },
    weightReadings: ramp(10, 90, -0.1),
  }));
  assert.equal(short.reasons.find(r => r.kind === 'rate'), undefined, 'no pace in the first 3 weeks');
  assert.equal(short.ratePerWeek.kg, null);
  const long = computeGoalProgress(base({ target: { weightKg: 80, date: null, weeklySessions: null }, weightReadings: ramp(60, 95, -0.07) }));
  assert.match(long.reasons.find(r => r.kind === 'rate')!.text, /\) over the last 3 weeks/);
  assert.ok(Math.abs(long.ratePerWeek.kg! + 0.49) < 0.01, `pace ${long.ratePerWeek.kg}`);
});

test('lifter with no baseline yet: "4-week lift trend from <first set + 28 days>" instead of "Log a few more lifts"', () => {
  // First sets in the week of Mon Oct 5, on Oct 5 and today (Oct 6): comparison lands Nov 2.
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 3 },
    progression: { squat: [wk('2026-10-05', 100)] },
    trainingDays: [addDays(TODAY, -1), TODAY],
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.headline, '4-week lift trend from Nov 2'); // no session count here: the sessions line carries it
  // No lifts at all keeps the generic ask.
  const none = computeGoalProgress(base({ goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 } }));
  assert.equal(none.headline, 'Log a few more lifts or weigh-ins to see your progress');
});

test('endurance runner with no history before the window reads "Building your base", not "restarted"', () => {
  const p = computeGoalProgress(enduranceInput([3, 2, 0, 0], { start: startedDaysAgo(9) }));
  assert.equal(p.verdict, 'building');
  assert.equal(p.headline, 'Building your base');
  const volume = p.reasons.find(r => r.kind === 'volume')!;
  assert.match(volume.text, /^Building your base: /);
  assert.doesNotMatch(JSON.stringify(p), /restarted|back to regular/);
  assert.equal(volume.tone, 'good');
});

test('race label: custom distances read in miles for imperial users', () => {
  assert.equal(plainSpaces(raceLabel(16.09344, 'imperial')), '10 mi race');
  assert.equal(plainSpaces(raceLabel(16.09344, 'metric')), '16.1 km race');
  assert.equal(plainSpaces(raceLabel(15)), '15 km race');
  assert.equal(plainSpaces(raceLabel(15, 'imperial')), '9.3 mi race');
  // Named distances keep their names.
  assert.equal(raceLabel(21.1, 'imperial'), 'Half marathon');
  assert.equal(raceLabel(10, 'imperial'), '10K');
  const p = computeGoalProgress(enduranceInput([4, 3, 2, 2], { unitSystem: 'imperial', race: { date: addDays(TODAY, 30), distanceKm: 16.09344 } }));
  assert.equal(p.race?.label, '10 mi race');
  assert.match(p.reasons[0].text, /^10 mi race in 5 weeks/);
});

// ── Wave 19b: the lived timeline (break → return, first weeks, one stall rule) ──

/** A lift-week: `sessions` sessions of 3 sets each, best e1RM `e`. */
const lw = (weekStart: string, e: number | null, sessions = 2, extra: Record<string, unknown> = {}) => ({
  weekStart, bestEstimatedOneRepMaxKg: e, volumeKg: sessions * 1000, totalSets: sessions * 3, totalReps: sessions * 15, sessions, ...extra,
});
const daysAt = (monday: string, offsets: number[]): string[] => offsets.map(o => addDays(monday, o));

// TODAY = Tue 2026-10-06. Four trained weeks (Mon/Wed/Sat), last session Sat 09-12, 15 days off (09-13 .. 09-27),
// back Mon 09-28 about 4% lighter.
const BREAK_PRE_WEEKS = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'];
const BREAK_HISTORY_DAYS = [
  ...BREAK_PRE_WEEKS.flatMap(w => daysAt(w, [0, 2, 5])),
  ...daysAt('2026-09-28', [0, 2, 5]), ...daysAt('2026-10-05', [0, 1]),
];
const breakInput = (progression: ProgressionSummary, over: Partial<GoalProgressInput> = {}): GoalProgressInput => base({
  goal: 'muscle',
  target: { weightKg: null, date: null, weeklySessions: 4 },
  progression,
  strengthDays: BREAK_HISTORY_DAYS.filter(d => d >= addDays(TODAY, -27)),
  strengthHistoryDays: BREAK_HISTORY_DAYS,
  start: { weightKg: 80, startedAt: '2026-07-01T09:00:00.000Z', startedDay: '2026-07-01' },
  ...over,
});
const squatBack = (...recent: number[]) => [
  lw('2026-08-17', 130), lw('2026-08-24', 133), lw('2026-08-31', 136), lw('2026-09-07', 142),
  ...recent.map((e, i) => lw(addDays('2026-09-28', 7 * i), e)),
];

// ── Wave 24s P2-A: the card carries the deload cue the Monday review gave, all week ────────────────────────────────────────────────────────

/** One lift-week per top load, a week apart from 08-24 (six loads end in the week of 09-28); the e1RM follows the load. */
const climbingCard = (...tops: number[]) => tops.map((t, i) => lw(addDays('2026-08-24', 7 * i), t * 1.2, 2, { topLoadKg: t }));
const deloadCardInput = (today: string, progression: ProgressionSummary, over: Partial<GoalProgressInput> = {}): GoalProgressInput => {
  const days = [0, 7, 14, 21, 28, 35, 42].flatMap(o => daysAt(addDays('2026-08-24', o), [0, 1, 3, 5])).filter(d => d <= today);
  return base({
    goal: 'muscle', todayKey: today, target: { weightKg: null, date: null, weeklySessions: 4 }, progression, strengthDays: days.filter(d => d >= addDays(today, -27)), strengthHistoryDays: days,
    start: { weightKg: 80, startedAt: '2026-07-01T09:00:00.000Z', startedDay: '2026-07-01' }, ...over,
  });
};

test('after 5 straight weeks of heavier loads the goal card (and so the coach lines) carries the deload cue for the whole week, then drops it (wave 24s)', () => {
  // Reviewed week 09-28 is the 5th step-up (100 -> 112.5 kg): from Monday 10-05 to Sunday 10-11 the card says so, neutral, third line at most.
  const squat = climbingCard(100, 102.5, 105, 107.5, 110, 112.5);
  for (const today of ['2026-10-05', '2026-10-08', '2026-10-11']) {
    const p = computeGoalProgress(deloadCardInput(today, { squat }));
    const line = p.reasons.find(r => r.kind === 'deload');
    assert.ok(line, `${today}: ${JSON.stringify(p.reasons)}`);
    assert.equal(line.text, "Deload week: ~85–90% of last week's loads, 2 working sets");
    assert.equal(line.tone, 'neutral');
    assert.ok(p.reasons.length <= 3);
  }
  // Four step-ups: no cue. The week after the deload (reviewed week 10-05 is the lighter one): no cue either.
  assert.equal(computeGoalProgress(deloadCardInput('2026-10-05', { squat: squat.slice(1) })).reasons.some(r => r.kind === 'deload'), false);
  const after = [...squat, lw('2026-10-05', 117, 2, { topLoadKg: 97.5, volumeKg: 1920 })];
  assert.equal(computeGoalProgress(deloadCardInput('2026-10-12', { squat: after })).reasons.some(r => r.kind === 'deload'), false);
});

test('return from a break: "Building back", not "Stalled" — verdict building, no amber reason', () => {
  const p = computeGoalProgress(breakInput({
    squat: squatBack(136, 136),
    // Bench also fell (a 4-week comparison would read -6): no amber drop reason either.
    'bench press': [lw('2026-08-17', 100), lw('2026-08-24', 102), lw('2026-08-31', 104), lw('2026-09-07', 106), lw('2026-09-28', 100), lw('2026-10-05', 100)],
  }));
  assert.equal(p.verdict, 'building');
  // Every lift is rebuilding and the bench is furthest behind the headline squat: the headline says so (wave 23s).
  assert.equal(p.headline, 'Building back — Squat est. 1RM 136 of 142 kg (bench furthest at 94%)');
  assert.ok(p.reasons.every(r => r.tone !== 'watch'), JSON.stringify(p.reasons));
  assert.equal(p.reasons[0].kind, 'lift');
  assert.equal(p.reasons[0].text, 'Squat est. 1RM 136 kg, 96% of your 142 kg pre-break best'); // 136 / 142 rounds to 96 (wave 21: not floored)
  // Bench is rebuilding too (wave 22s): its standing is its own line, always (no 3-point hide rule), and takes the break line's room.
  assert.equal(p.reasons[1].text, 'Bench Press 94% of its pre-break est. 1RM');
  assert.doesNotMatch(JSON.stringify(p), /Stalled|stalled|vs 4 weeks ago/);
  assert.deepEqual(p.liftReturn, {
    exercise: 'squat', name: 'Squat', breakDays: 15, endedOn: '2026-09-27', preBreakKg: 142, recentKg: 136, pct: 95, regained: false,
  });
  // With only the headline lift rebuilding there is room for the break line.
  const alone = computeGoalProgress(breakInput({ squat: squatBack(136, 136) }));
  assert.ok(alone.reasons.some(r => r.text === 'Back after a 15-day break (ended Sep 27)'), JSON.stringify(alone.reasons));
  // The 28-day session window still holds the break: never "Sessions behind" and never an amber adherence lead.
  assert.notEqual(p.verdict, 'behind');
  assertWellFormed(p);
});

test('return from a break: the card agrees with the stalled-lift nudge (neither calls it a stall)', () => {
  const squat = squatBack(136, 138);
  const progression: ProgressionSummary = { squat };
  const p = computeGoalProgress(breakInput(progression));
  assert.notEqual(p.verdict, 'stalled');
  const nudge = detectStalledLift({
    goal: 'muscle', unitSystem: 'metric', todayKey: TODAY, weightSignals: [], targetWeightKg: null, targetDate: null, proteinTargetG: null,
    loggedDays: [], trainingDays: [], progression, liftSessionDays: { squat: BREAK_HISTORY_DAYS.filter(d => d >= '2026-09-14') },
    exerciseDisplay: {}, weeklyVerdicts: [],
  });
  assert.equal(nudge, null);
  // Control: the same e1RMs without a break ARE a stall — on the card AND in the nudge.
  const steady = [...squat.slice(0, 4), lw('2026-09-14', 138), lw('2026-09-21', 138), ...squat.slice(4)];
  const days = [...BREAK_PRE_WEEKS.flatMap(w => daysAt(w, [0, 2, 5])), ...['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'].flatMap(w => daysAt(w, [0, 2, 5]))].filter(d => d <= TODAY);
  const card = computeGoalProgress(breakInput({ squat: steady }, { strengthDays: days.filter(d => d >= addDays(TODAY, -27)), strengthHistoryDays: days }));
  assert.equal(card.verdict, 'stalled');
  assert.equal(card.liftReturn, null);
  assert.ok(detectStalledLift({
    goal: 'muscle', unitSystem: 'metric', todayKey: TODAY, weightSignals: [], targetWeightKg: null, targetDate: null, proteinTargetG: null,
    loggedDays: [], trainingDays: [], progression: { squat: steady }, liftSessionDays: { squat: days.filter(d => d >= '2026-09-14') },
    exerciseDisplay: {}, weeklyVerdicts: [],
  }));
});

// Longer break: last session Sat 08-29, back Mon 09-21. The weeks 4 and 5 weeks before the recent window (09-07, 08-31) are
// empty, so squat has NO 4-week comparison. Deadlift, not yet trained this week, still has one (-3).
const LONG_BREAK_DAYS = [
  ...['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'].flatMap(w => daysAt(w, [0, 2, 5])),
  ...['2026-09-21', '2026-09-28'].flatMap(w => daysAt(w, [0, 2, 5])), ...daysAt('2026-10-05', [0, 1]),
];
const longBreakInput = (progression: ProgressionSummary, over: Partial<GoalProgressInput> = {}): GoalProgressInput =>
  breakInput(progression, { strengthDays: LONG_BREAK_DAYS.filter(d => d >= addDays(TODAY, -27)), strengthHistoryDays: LONG_BREAK_DAYS, ...over });
const LONG_BREAK_SQUAT = [lw('2026-08-03', 128), lw('2026-08-10', 132), lw('2026-08-17', 136), lw('2026-08-24', 142), lw('2026-09-21', 138), lw('2026-09-28', 141), lw('2026-10-05', 145)];
const longBreakDeadlift = (...since: number[]) => [lw('2026-08-03', 150), lw('2026-08-10', 152), lw('2026-08-17', 155), lw('2026-08-24', 158), ...since.map((e, i) => lw(addDays('2026-09-21', 7 * i), e))];

test('return from a break: regained → "Back above your pre-break best", even while the 4-weeks-ago weeks are empty', () => {
  const progression: ProgressionSummary = { squat: LONG_BREAK_SQUAT };
  const p = computeGoalProgress(longBreakInput(progression));
  assert.equal(p.verdict, 'progressing');
  assert.equal(p.headline, 'Back above your pre-break best — Squat est. 1RM 145 kg (was 142 kg)');
  assert.equal(p.liftReturn!.regained, true);
  assert.ok(p.reasons.every(r => r.tone !== 'watch'));
  // The next day it does not flip to a weight-led verdict or lose the lift line.
  const next = computeGoalProgress(longBreakInput(progression, { todayKey: addDays(TODAY, 1), strengthDays: LONG_BREAK_DAYS }));
  assert.equal(next.headline, p.headline);
  assert.ok(next.reasons.some(r => r.kind === 'lift'));
});

test('return from a break, lift by lift: "Back above your pre-break best" is said only when EVERY lift is (wave 21)', () => {
  // Squat 145 vs 142 pre-break; deadlift 155 of 158 (98%) — the card used to say "Back above your pre-break best — Squat" over it.
  const progression: ProgressionSummary = { squat: LONG_BREAK_SQUAT, deadlift: longBreakDeadlift(150, 155) };
  const p = computeGoalProgress(longBreakInput(progression));
  assert.equal(p.verdict, 'building');
  assert.equal(p.headline, 'Squat back above pre-break; deadlift at 98% (155 of 158 kg est. 1RM)');
  assert.ok(p.headline.length <= HEADLINE_MAX_CHARS);
  // A reason for the lift furthest behind, then the one that is back.
  assert.equal(p.reasons[0].text, 'Deadlift est. 1RM 155 kg, 98% of your 158 kg pre-break best');
  assert.equal(p.reasons[0].tone, 'neutral');
  assert.equal(p.reasons[1].text, 'Squat est. 1RM 145 kg, back above your pre-break 142 kg');
  assert.doesNotMatch(JSON.stringify(p), /Back above your pre-break best/);
  assertWellFormed(p);
  // The additive payload: `liftReturn` is still the headline lift, `liftReturns` has every lift (headline first).
  assert.equal(p.liftReturn!.exercise, 'squat');
  assert.equal(p.liftReturn!.regained, true);
  assert.deepEqual(p.liftReturns!.map(r => [r.exercise, r.regained, r.pct]), [['squat', true, 102], ['deadlift', false, 98]]);
  assert.deepEqual(p.liftReturns![0], p.liftReturn);
  // Pounds: 145 kg = 320 lb, 155 kg = 342 lb, 158 kg = 348 lb.
  const lb = computeGoalProgress(longBreakInput(progression, { unitSystem: 'imperial' }));
  assert.equal(lb.headline, 'Squat back above pre-break; deadlift at 98% (342 of 348 lb est. 1RM)');
  // Deadlift catches up: now it IS every lift.
  const back = computeGoalProgress(longBreakInput({ squat: LONG_BREAK_SQUAT, deadlift: longBreakDeadlift(150, 160) }));
  assert.equal(back.verdict, 'progressing');
  assert.equal(back.headline, 'Back above your pre-break best — Squat est. 1RM 145 kg (was 142 kg)');
  assert.deepEqual(back.reasons.filter(r => r.kind === 'lift').map(r => r.text), [
    'Squat est. 1RM 145 kg, back above your pre-break 142 kg',
    'Deadlift est. 1RM 160 kg, back above your pre-break 158 kg',
  ]);
  assert.deepEqual(back.liftReturns!.map(r => r.regained), [true, true]);
  // Exactly at its pre-break best for one of them: "at", never "above".
  const at = computeGoalProgress(longBreakInput({ squat: LONG_BREAK_SQUAT, deadlift: longBreakDeadlift(150, 158) }));
  assert.equal(at.headline, 'Back at your pre-break best — Squat est. 1RM 145 kg');
});

test('return from a break, lift by lift: several lifts back and one behind, and every lift still building', () => {
  const bench = (...since: number[]) => [lw('2026-08-03', 100), lw('2026-08-10', 102), lw('2026-08-17', 104), lw('2026-08-24', 106), ...since.map((e, i) => lw(addDays('2026-09-21', 7 * i), e))];
  // Squat and bench back, deadlift at 98%: the headline names the first lift back with the numbers of the one behind.
  const two = computeGoalProgress(longBreakInput({ squat: LONG_BREAK_SQUAT, 'bench press': bench(104, 107), deadlift: longBreakDeadlift(150, 155) }));
  assert.equal(two.verdict, 'building');
  assert.equal(two.headline, 'Squat back above pre-break; deadlift at 98% (155 of 158 kg est. 1RM)');
  assert.deepEqual(two.liftReturns!.map(r => r.exercise).sort(), ['bench press', 'deadlift', 'squat']);
  // Nothing back yet: the headline lift's own "Building back" line, then where every other rebuilding lift stands (wave 22s: whatever the gap).
  const none = computeGoalProgress(longBreakInput({ squat: [...LONG_BREAK_SQUAT.slice(0, 4), lw('2026-09-21', 134), lw('2026-09-28', 136)], deadlift: longBreakDeadlift(140, 142) }));
  assert.equal(none.verdict, 'building');
  assert.equal(none.headline, 'Building back — Squat est. 1RM 136 of 142 kg (deadlift furthest, 90%)');
  assert.equal(none.reasons[0].text, 'Squat est. 1RM 136 kg, 96% of your 142 kg pre-break best');
  assert.equal(none.reasons[1].text, 'Deadlift 90% of its pre-break est. 1RM');
  // Only 2 points apart (96% / 94%) it is still there: the line no longer comes and goes with a session (days 71-78).
  const close = computeGoalProgress(longBreakInput({ squat: [...LONG_BREAK_SQUAT.slice(0, 4), lw('2026-09-21', 134), lw('2026-09-28', 136)], deadlift: longBreakDeadlift(147, 149) }));
  assert.equal(close.reasons[1].text, 'Deadlift 94% of its pre-break est. 1RM');
  // Two other lifts: one lowercase list line, "of pre-break est. 1RM"; the headline names the furthest (wave 23s).
  const three = computeGoalProgress(longBreakInput({
    squat: [...LONG_BREAK_SQUAT.slice(0, 4), lw('2026-09-21', 134), lw('2026-09-28', 136)], deadlift: longBreakDeadlift(147, 149),
    'bench press': [lw('2026-08-03', 100), lw('2026-08-10', 102), lw('2026-08-17', 104), lw('2026-08-24', 106), lw('2026-09-21', 99), lw('2026-09-28', 100)],
  }));
  assert.equal(three.reasons[1].text, 'bench 94%, deadlift 94% of pre-break est. 1RM');
  assert.match(three.headline, /^Building back — Squat est\. 1RM 136 of 142 kg \((?:bench|deadlift) furthest(?: at|,) 94%\)$/);
  // An accessory never holds the claim back: lat pulldown at 90% does not stop "Back above".
  const accessory = computeGoalProgress(longBreakInput({ squat: LONG_BREAK_SQUAT, 'lat pulldown': [lw('2026-08-17', 80), lw('2026-08-24', 85), lw('2026-09-21', 70)] }));
  assert.equal(accessory.headline, 'Back above your pre-break best — Squat est. 1RM 145 kg (was 142 kg)');
});

test('the comeback sentence: "above" only when every named lift is above its printed number, "at or above" for a mix, sentence case (wave 22s)', () => {
  const ret = (exercise: string, name: string, pre: number, recent: number, regained: boolean) =>
    ({ exercise, name, breakDays: 15, endedOn: '2026-05-10', preBreakKg: pre, recentKg: recent, pct: Math.floor((recent / pre) * 100), regained });
  const squatAbove = ret('squat', 'Squat', 142, 145.2, true);
  const benchAt = ret('bench press', 'Bench Press', 111, 111.2, true);
  const benchAbove = ret('bench press', 'Bench Press', 111, 114, true);
  const deadlift = ret('deadlift', 'Deadlift', 160, 157, false);
  assert.equal(mixedReturnLead([squatAbove, deadlift], undefined, false)?.text, 'Squat back above pre-break; deadlift at 98%');
  assert.equal(mixedReturnLead([squatAbove, benchAbove, deadlift], undefined, false)?.text, 'Squat and bench back above pre-break; deadlift at 98%');
  assert.equal(mixedReturnLead([benchAt, deadlift], undefined, false)?.text, 'Bench back at pre-break; deadlift at 98%');
  // A mix of one above and one exactly at: neither "above" (bench is not) nor "at" (squat is above).
  assert.equal(mixedReturnLead([benchAt, squatAbove, deadlift], undefined, false)?.text, 'Bench and squat back at or above pre-break; deadlift at 98%');
  // The numbers are as printed: 111.2 kg shows as 111, so it is "at", not above 111.
  assert.equal(mixedReturnLead([benchAt, deadlift], undefined, false)?.text.includes(' at pre-break'), true);
});

test('return from a break: the state ends 35 days after the break and normal rules apply again', () => {
  const dayOf = (offset: number) => addDays('2026-09-27', offset); // break ended Sep 27
  const progression: ProgressionSummary = { squat: squatBack(136, 138, 139, 140, 141, 141) };
  const days = [...BREAK_PRE_WEEKS.flatMap(w => daysAt(w, [0, 2, 5])), ...['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'].flatMap(w => daysAt(w, [0, 2, 5]))];
  const at = (todayKey: string) => computeGoalProgress(breakInput(progression, { todayKey, strengthDays: days.filter(d => d >= addDays(todayKey, -27) && d <= todayKey), strengthHistoryDays: days.filter(d => d <= todayKey) }));
  assert.equal(at(dayOf(35)).liftReturn?.regained, false); // 35 days after: still building back
  assert.equal(at(dayOf(36)).liftReturn, null); // 36: over
  assert.notEqual(at(dayOf(36)).verdict, 'building');
});

test('a gap under 10 days is a rest week, not a break', () => {
  const days = [...daysAt('2026-09-07', [0, 2, 5]), ...daysAt('2026-09-21', [0, 2, 5]), ...daysAt('2026-09-28', [0, 2, 5]), ...daysAt('2026-10-05', [0, 1])]; // 8 days off
  const p = computeGoalProgress(breakInput({ squat: squatBack(136, 138) }, { strengthDays: days.filter(d => d >= addDays(TODAY, -27)), strengthHistoryDays: days }));
  assert.equal(p.liftReturn, null);
  assert.notEqual(p.verdict, 'building');
});

test('week 2 with weigh-ins: the 4-week lift trend start is announced — never "Stalled" or "opposite way"', () => {
  // Goal started 8 days ago; flat weigh-ins every day since; 4 sessions logged.
  const started = addDays(TODAY, -8);
  const sessionDays = [addDays(TODAY, -8), addDays(TODAY, -6), addDays(TODAY, -4), addDays(TODAY, -1)];
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    start: { weightKg: 80, startedAt: `${started}T09:00:00.000Z`, startedDay: started },
    weightReadings: series(9, () => 80),
    progression: { squat: [lw('2026-09-28', 100), lw('2026-10-05', 105)] },
    strengthDays: sessionDays,
    trainingDays: sessionDays,
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.headline, '4-week lift trend from Oct 26'); // the headline holds no count (wave 21): it only changes when the date does
  assert.doesNotMatch(JSON.stringify(p), /Stalled|opposite way/);
  const rate = p.reasons.find(r => r.kind === 'rate');
  assert.ok(rate);
  assert.match(rate!.text, /^Trend weight flat /);
  assert.equal(rate!.tone, 'neutral');
});

test('weight rate: under 0.05% a week reads "flat" and every threshold uses the number as printed', () => {
  const mk = (kgPerDay: number) => computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 90, date: null, weeklySessions: 4 },
    weightReadings: ramp(40, 80, kgPerDay),
  })).reasons.find(r => r.kind === 'rate');
  assert.match(mk(0.002)!.text, /^Trend weight flat /);
  assert.doesNotMatch(mk(0.002)!.text, /opposite way/);
  assert.match(mk(-0.002)!.text, /^Trend weight flat /); // flat, not "down ... opposite way"
  assert.match(mk(-0.03)!.text, /opposite way/); // a real drop still is
  // Sweep through the 0.1% floor: when the printed percentage is at/above the floor, the text never says "under the floor".
  for (let i = 0; i <= 40; i += 1) {
    const r = mk(0.009 + i * 0.0001);
    if (!r) continue;
    const printed = Number(/\(([\d.]+)% of bodyweight\)/.exec(r.text)![1]);
    if (printed >= 0.1) assert.doesNotMatch(r.text, /under the|slower than lean gain/, r.text);
    else assert.match(r.text, /slower than lean gain \(0\.1–0\.5% of bodyweight a week\)|flat/, r.text);
  }
});

test('"no lift is up" is only said when every lift has a comparison; otherwise the lift that does is named', () => {
  const flat = (e: number) => ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'].map(w => lw(w, e));
  const mkInput = (progression: ProgressionSummary) => base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, progression,
    trainingDays: Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i)),
  });
  // Both lifts compared and flat → the general claim is true.
  assert.equal(computeGoalProgress(mkInput({ squat: flat(140), 'bench press': flat(100) })).headline, 'Stalled — no lift is up 1% on 4 weeks ago');
  // Deadlift down 3 with steady training; squat is new (no 4-week baseline): the claim is about deadlift only.
  const deadlift = [lw('2026-09-07', 150), lw('2026-09-14', 148), lw('2026-09-21', 147), lw('2026-09-28', 147), lw('2026-10-05', 147)];
  const squatNew = [lw('2026-09-21', 120, 5), lw('2026-09-28', 122, 5), lw('2026-10-05', 124, 5)]; // most-trained, but no comparison yet
  const p = computeGoalProgress(mkInput({ deadlift, squat: squatNew }));
  assert.equal(p.verdict, 'stalled');
  assert.equal(p.headline, 'Stalled — Deadlift est. 1RM −3 kg vs 4 weeks ago');
  assert.equal(p.reasons.find(r => r.kind === 'lift')!.text, 'Deadlift est. 1RM −3 kg vs 4 weeks ago (150 → 147 kg)');
});

test('no comparison for any lift after a gap: "Next lift comparison on <date>", not a weight verdict', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 3 },
    start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' },
    weightReadings: ramp(40, 80, 0.04), // ~0.35%/wk: the old code would have answered "Progressing — weight up ..."
    progression: { squat: [lw('2026-07-06', 120), lw('2026-07-13', 124), lw('2026-09-21', 118), lw('2026-09-28', 121), lw('2026-10-05', 123)] },
    trainingDays: Array.from({ length: 5 }, (_, i) => addDays(TODAY, -i)),
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.headline, 'Next lift comparison on Oct 19');
  assert.notEqual(p.verdict, 'progressing');
});

test('sessions agree with the weekly review: two weeks at target → this-week copy leads, the 28-day line is demoted', () => {
  // Sunday: this week (Mon 09-28 .. Sun 10-04) and last week both hit 4 of 4, but the 28-day window still holds a two-week gap.
  const sunday = '2026-10-04';
  const days = [...daysAt('2026-09-21', [0, 1, 3, 5]), ...daysAt('2026-09-28', [0, 1, 3, 5]), ...daysAt('2026-09-07', [0, 4])];
  const progression: ProgressionSummary = { squat: ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map((w, i) => lw(w, [120, 122, 125, 128, 132][i])) };
  const p = computeGoalProgress(base({
    goal: 'muscle', todayKey: sunday, target: { weightKg: null, date: null, weeklySessions: 4 }, progression,
    start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' },
    strengthDays: days, trainingDays: days,
  }));
  assert.equal(p.adherence!.pct, 63); // 10 of 16: the structured 28-day numbers are unchanged
  assert.equal(p.verdict, 'progressing');
  assert.equal(p.reasons[0].kind, 'lift');
  assert.deepEqual(p.reasons[1], { kind: 'week_sessions', text: '4 of 4 sessions this week', tone: 'good' }); // the 28-day line does not lead
  assert.ok(p.reasons.every(r => r.tone !== 'watch'), JSON.stringify(p.reasons));
  // One week short: the 28-day line is the honest one again.
  const short = computeGoalProgress(base({
    goal: 'muscle', todayKey: sunday, target: { weightKg: null, date: null, weeklySessions: 4 }, progression,
    start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' },
    // Thursday's session stays: 3 days since the last one is under the 4 a week lapse threshold.
    strengthDays: days.filter(d => d !== '2026-10-03'), trainingDays: days.filter(d => d !== '2026-10-03'),
  }));
  assert.equal(short.reasons[0].kind, 'adherence');
  assert.equal(short.reasons[0].tone, 'watch');
  assert.equal(short.verdict, 'behind');
});

test('the headline lift on the card is the most-trained lift, stable from day to day', () => {
  const squat = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map(w => lw(w, 130, 2));
  const bench = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map(w => lw(w, 100, 2));
  const headlines = new Set<string>();
  for (const [dropSquat, dropBench] of [[3, 3], [3, 6], [6, 3], [2, 5]]) {
    const progression: ProgressionSummary = {
      squat: [...squat.slice(0, 3), lw('2026-09-21', 130 - dropSquat), lw('2026-09-28', 130 - dropSquat)],
      'bench press': [...bench.slice(0, 3), lw('2026-09-21', 100 - dropBench), lw('2026-09-28', 100 - dropBench)],
    };
    const p = computeGoalProgress(base({
      goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, progression,
      trainingDays: Array.from({ length: 12 }, (_, i) => addDays(TODAY, -i)),
    }));
    const lift = p.reasons.find(r => r.kind === 'lift')!;
    headlines.add(lift.text.split(' est.')[0]);
  }
  assert.deepEqual([...headlines], ['Squat']);
});

// ── Wave 19c: the weight-loss pace (lib/weightPace.ts) ───────────────────────

/** Weigh-ins on the given day offsets from TODAY (negative = in the past), kg from `kgAt(offset)`. */
function onDays(offsets: number[], kgAt: (offset: number) => number): WeightReading[] {
  return offsets.map(o => {
    const day = addDays(TODAY, o);
    return { measuredAt: `${day}T08:00:00.000Z`, valueKg: Math.round(kgAt(o) * 100) / 100, source: 'manual' as const, localDay: day };
  });
}

/** Every day from `from` to `to` (offsets from TODAY). */
function span(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const BUDGET_2000 = { targetKcal: 2000, proteinG: 140, floorKcal: 1500, formulaTdee: null, learnedTdee: null, tdeeConfidence: null };

/** A goal of `ageDays` days, 92 kg to 84 kg by TODAY+100. */
function youngGoal(ageDays: number, over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return base({
    target: { weightKg: 84, date: addDays(TODAY, 100), weeklySessions: 3 },
    start: { weightKg: 92, startedAt: `${addDays(TODAY, -(ageDays - 1))}T08:00:00.000Z` },
    budget: BUDGET_2000,
    ...over,
  });
}

test('A. early read: a goal under 3 weeks old gets the scale against the start — no pace, no ETA, no ahead/behind', () => {
  const p = computeGoalProgress(youngGoal(10, { weightReadings: onDays(span(-9, 0), o => 92 + (o + 9) * -0.08) }));
  assert.equal(p.verdict, 'progressing');
  // The amount down is the ONE progress weight (the 7-day average: 91.52 kg here), not the last reading (91.3 kg) — so the
  // headline says "weekly average", never "on the scale" (wave 21w, finding 4); "on the scale" is a single reading only.
  assert.equal(p.headline, 'Early read — weekly average down 0.5 kg in 9 days');
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assert.equal(p.ratePerWeek.kg, null);
  assert.equal(p.ratePerWeek.pctBodyweight, null);
  assert.equal(p.weightRead?.state, 'early');
  assert.equal(p.weightRead?.weeksVsTarget, null);
  assert.equal(p.weightRead?.scaleKg, 91.3);
  assert.match(p.reasons[0].text, /^Your pace estimate settles after 3 weeks of weigh-ins — daily swings of ±1 kg are normal$/);
  assert.ok(!/behind|ahead/i.test(p.headline + p.reasons.map(r => r.text).join(' ')), 'no ahead/behind call');
  assertWellFormed(p);
});

test('A. early read: a scale that is not down says "daily swings of ±1 kg are normal" and holds', () => {
  const p = computeGoalProgress(youngGoal(10, { weightReadings: onDays(span(-9, 0), o => 92 + (o + 9) * 0.02) }));
  assert.equal(p.verdict, 'holding');
  assert.equal(p.headline, 'Early days — daily swings of ±1 kg are normal');
  assert.equal(p.reasons[0].text, 'Your pace settles after 3 weeks of weigh-ins');
  assert.equal(p.eta, null);
});

test('A. early read copy is unit-aware (imperial): lb in the headline and the swing; structured fields stay kg', () => {
  const down = computeGoalProgressRaw(youngGoal(10, { unitSystem: 'imperial', weightReadings: onDays(span(-9, 0), o => 92 + (o + 9) * -0.08) }));
  assert.equal(down.headline, `Early read — weekly average down 1.1${NBSP}lb in 9 days`);
  assert.ok(down.reasons[0].text.includes(`±2${NBSP}lb`), down.reasons[0].text);
  assert.equal(down.weightRead?.scaleKg, 91.3);
  const flat = computeGoalProgressRaw(youngGoal(10, { unitSystem: 'imperial', weightReadings: onDays(span(-9, 0), () => 92.1) }));
  assert.equal(flat.headline, `Early days — daily swings of ±2${NBSP}lb are normal`);
});

test('A. insufficient_data is unchanged below the weigh-in minimum (iOS shows its weigh-in count there)', () => {
  const p = computeGoalProgress(youngGoal(3, { weightReadings: onDays([-2, -1, 0], () => 91.8) }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.dataSufficiency.weighIns, 3);
});

test('A. a pace needs 6 weigh-ins over 14 days: an older goal with sparse weigh-ins is an early read, not a pace', () => {
  const p = computeGoalProgress(youngGoal(60, { weightReadings: onDays([-40, -30, -20, -10, -5, 0], o => 92 + (o + 40) * -0.1) }));
  assert.equal(p.weightRead?.state, 'early');
  assert.equal(p.verdict, 'progressing');
  assert.match(p.headline, /^Down [\d.]+ kg since the start — pace needs 6 weigh-ins over 2 weeks$/);
  assert.equal(p.eta, null);
  assert.equal(p.ratePerWeek.kg, null);
});

test('A. one pace for every surface: ratePerWeek is the least-squares slope of the raw weigh-ins, not the lagging trend', () => {
  // 37 days flat at 92, then 28 days falling 0.1 kg/day: the smoothed trend still lags well above the scale. (Wave 21w: the
  // flat spell ended well over 14 days before the week's Sunday, so this is an ordinary pace, not "moving again".)
  const readings = onDays(span(-64, 0), o => (o < -27 ? 92 : 92 + (o + 27) * -0.1));
  const p = computeGoalProgress(youngGoal(65, { weightReadings: readings }));
  assert.equal(p.weightRead?.state, 'pace');
  assert.ok(Math.abs(p.ratePerWeek.kg! + 0.7) < 0.01, `pace ${p.ratePerWeek.kg}`);
  // Wave 21w: `current.weightKg` is the one displayed weight (the weekly average); the chart's lagging trend is `trendKg`, untouched.
  assert.ok(p.current.trendKg! - p.weightRead!.scaleKg! >= 0.5, 'the displayed trend line is untouched (still lagging the scale)');
  assert.equal(p.current.weightKg, p.weightRead!.weekMeanKg);
  assert.match(p.reasons[0].text, /^Down 0\.7 kg\/wk \(0\.7\d% of bodyweight\) over the last 3 weeks, inside the 0\.25–1% safe band$/);
});

/** A target of 80 kg with a 70-day-old goal; `date` is the target date. */
function paceCase(readings: WeightReading[], date: string | null, over: Partial<GoalProgressInput> = {}): GoalProgress {
  return computeGoalProgress(base({
    target: { weightKg: 80, date, weeklySessions: null },
    start: { weightKg: 95, startedAt: `${addDays(TODAY, -70)}T08:00:00.000Z` },
    weightReadings: readings,
    ...over,
  }));
}

test('A. ahead/behind is stated only when the pace today AND a week ago agree; otherwise the card says on pace', () => {
  // Fast for a month, slowing over the last 3 weeks: today's ETA is later than last week's.
  const bend = onDays(span(-60, 0), o => (o < -20 ? 95 + (o + 60) * -0.12 : 95 - 40 * 0.12 + (o + 20) * -0.05));
  const nowEta = paceCase(bend, null).eta!;
  const thenEta = paceCase(bend.filter(r => r.localDay <= addDays(TODAY, -7)), null, { todayKey: addDays(TODAY, -7) }).eta!;
  assert.ok(nowEta && thenEta && nowEta > thenEta, `the pace slowed: ${thenEta} -> ${nowEta}`);
  const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

  // The target date between the two projections: they land on opposite sides of it, so no weeks are quoted.
  const between = addDays(thenEta, Math.round(dayDiff(nowEta, thenEta) / 2));
  const split = paceCase(bend, between);
  assert.equal(split.verdict, 'on_track');
  assert.equal(split.eta, between, 'the two paces disagree: on track for the target date itself, the date does not drop out');
  assert.equal(split.onPaceForTargetDate, true);
  assert.equal(split.weightRead?.weeksVsTarget, 0);
  assert.match(split.headline, /^On track for \w{3} \d{1,2}(, \d{4})? — about /);

  // Both projections after the target date: behind, in whole weeks, the nearer of the two.
  const early = addDays(thenEta, -40);
  const behind = paceCase(bend, early);
  assert.equal(behind.verdict, 'behind');
  assert.equal(behind.eta, thenEta, 'the projection nearer the target date is the one stated');
  assert.equal(behind.weightRead?.weeksVsTarget, -Math.max(1, Math.round(dayDiff(thenEta, early) / 7)));
  assert.equal(behind.onPaceForTargetDate, false);
  // Wave 21w: more than 8 weeks past the date, no date is quoted at all.
  assert.equal(paceCase(bend, addDays(thenEta, -70)).eta, null);

  // Both before it: ahead.
  const ahead = paceCase(bend, addDays(nowEta, 60));
  assert.equal(ahead.verdict, 'ahead');
  assert.equal(ahead.eta, nowEta);
  assert.ok(ahead.weightRead!.weeksVsTarget! >= 8);
});

test('A. a pace nothing has confirmed yet makes no call: with only today\'s pace the card says Progressing, with no date', () => {
  // A 25-day-old goal whose weigh-ins only started 20 days ago: a pace exists today but not a week ago (that needs 14 days of span then).
  const p = paceCase(onDays(span(-19, 0), o => 91.5 + (o + 19) * -0.07), addDays(TODAY, 120), { start: { weightKg: 91.5, startedAt: `${addDays(TODAY, -24)}T08:00:00.000Z` } });
  assert.equal(p.verdict, 'progressing');
  assert.equal(p.eta, null);
  assert.equal(p.weightRead?.weeksVsTarget, null);
  assert.match(p.headline, /^Progressing — losing about 0\.5 kg a week$/);
});

test('A. one margin: ±7 days is on pace in the card, the same figure the opener and iOS use; weeks are whole and at least 1', () => {
  const readings = ramp(60, 95, -0.07);
  const eta = paceCase(readings, null).eta!;
  const at = (days: number) => paceCase(readings, addDays(eta, days));
  assert.equal(at(7).verdict, 'on_track'); // the date is 7 days after the ETA
  assert.equal(at(-7).verdict, 'on_track'); // the date is 7 days before it
  assert.equal(at(8).verdict, 'ahead');
  assert.equal(at(-8).verdict, 'behind');
  assert.equal(at(8).weightRead?.weeksVsTarget, 1);
  assert.equal(at(-8).weightRead?.weeksVsTarget, -1);
  assert.equal(at(17).weightRead?.weeksVsTarget, 2);
  assert.equal(at(0).weightRead?.weeksVsTarget, 0);
});

test('A. a noisy but steady loss never swings the stated weeks by more than 4 between consecutive days', () => {
  const noise = (o: number): number => 0.4 * Math.sin(o * 2.3) + 0.25 * Math.cos(o * 0.9);
  const all = onDays(span(-90, 0), o => 95 + (o + 90) * -0.07 + noise(o));
  const weeks: number[] = [];
  for (let back = 30; back >= 0; back--) {
    const todayKey = addDays(TODAY, -back);
    const p = computeGoalProgress(base({
      todayKey,
      // A date about two weeks out of reach (wave 21w: further than 8 weeks past it no weeks are stated at all).
      target: { weightKg: 80, date: addDays(TODAY, 110), weeklySessions: null },
      start: { weightKg: 95, startedAt: `${addDays(TODAY, -90)}T08:00:00.000Z` },
      weightReadings: all.filter(r => r.localDay <= todayKey),
    }));
    const w = p.weightRead?.weeksVsTarget;
    if (w != null) weeks.push(w);
  }
  assert.ok(weeks.length >= 10, `weeks stated on ${weeks.length} days`);
  for (let i = 1; i < weeks.length; i++) {
    assert.ok(Math.abs(weeks[i] - weeks[i - 1]) <= 4, `swing ${weeks[i - 1]} -> ${weeks[i]} (${weeks.join(', ')})`);
  }
});

test('B. too fast: the headline quotes the very rate that triggered it, with an action using the real calorie target', () => {
  const p = computeGoalProgress(youngGoal(60, { weightReadings: ramp(60, 100, -0.17) }));
  assert.equal(p.verdict, 'too_fast');
  const pct = Math.abs(p.ratePerWeek.pctBodyweight!);
  assert.equal(p.headline, `Losing too fast — ${pct}% of bodyweight a week`);
  const rate = p.reasons.find(r => r.kind === 'rate')!;
  assert.ok(rate.text.includes(`(${pct}% of bodyweight)`), rate.text);
  assert.equal(rate.tone, 'watch');
  assert.match(rate.text, /above the 1% a week ceiling/);
  assert.equal(p.reasons.find(r => r.kind === 'action')?.text, 'Eat up to your full 2,000 kcal target — a slower loss is easier to keep');
  // Never both too fast and inside the safe band.
  assert.ok(!p.reasons.some(r => /inside the .*safe band/.test(r.text)));
  // Without a known budget the action still reads, without a number.
  const noBudget = computeGoalProgress(youngGoal(60, { budget: null, weightReadings: ramp(60, 100, -0.17) }));
  assert.equal(noBudget.reasons.find(r => r.kind === 'action')?.text, 'Eat up to your full calorie target — a slower loss is easier to keep');
});

test('B. a gap-spanning drop is not "too fast": the first weigh-ins back never call it, the third may', () => {
  const pre = onDays(span(-45, -14), o => 95 + (o + 45) * -0.07);
  const lastKg = pre[pre.length - 1].valueKg;
  const back = (days: number[]) => onDays(days, () => lastKg - 2.6);
  const run = (days: number[]) => computeGoalProgress(youngGoal(60, { weightReadings: [...pre, ...back(days)] }));
  for (const days of [[0], [-1, 0]]) {
    const p = run(days);
    assert.equal(p.weightRead?.state, 'returning');
    assert.ok(p.verdict === 'progressing' || p.verdict === 'holding', `${days.length} back: ${p.verdict}`);
  }
  assert.notEqual(run([-2, -1, 0]).weightRead?.state, 'returning', 'three weigh-ins back: the pace may be called again');
});

test('C. coming back after a gap: "Welcome back" with the change since the last weigh-in, and the payload says so', () => {
  const pre = onDays(span(-45, -14), o => 95 + (o + 45) * -0.07);
  const lastKg = pre[pre.length - 1].valueKg;
  const p = computeGoalProgress(youngGoal(60, { weightReadings: [...pre, ...onDays([0], () => lastKg - 1.1)] }));
  assert.equal(p.verdict, 'progressing');
  assert.match(p.headline, /^Welcome back — the scale is down 1\.1 kg since \w{3} \d{1,2}$/);
  assert.deepEqual(p.weightRead?.returned, { gapDays: 13, sinceDay: addDays(TODAY, -14), sinceKg: Math.round(lastKg * 10) / 10, weighInsSince: 1 });
  assert.equal(p.eta, null);
  assert.equal(p.ratePerWeek.kg, null);
  assert.match(p.reasons[0].text, /^Keep weighing in so your trend catches up — 2 more weigh-ins before your pace is read again$/);
  // Wave 23w: the progress weight moves from the old weekly average to this reading, and the card says so.
  assert.equal(p.reasons[1].text, 'Progress now counts from your latest reading until your weekly average is back');
  // Up since the gap reads "up".
  const up = computeGoalProgress(youngGoal(60, { weightReadings: [...pre, ...onDays([0], () => lastKg + 0.8)] }));
  assert.match(up.headline, /^Welcome back — the scale is up 0\.8 kg since/);
});

/**
 * Eight logged days around the 2,000 kcal target, 8-15 days before TODAY (so before any week's Sunday the plan reads): a user who logs food,
 * for whom a calorie trim can be checked. Without logs the plan's first step is activity or logging (wave 22w).
 */
const LOGGING_USER: GoalProgressInput['intakeDays'] = Array.from({ length: 8 }, (_, i) => ({
  day: addDays(TODAY, -8 - i), kcal: 1950 + (i % 3) * 40, proteinG: 140, source: 'logged' as const,
}));

test('D. plateau: three flat weeks of raw weekly means are named, hold the verdict and hide the ETA', () => {
  const flat = onDays(span(-49, 0), o => (o < -21 ? 92 - (o + 49) * 0.09 : 89.5 + (o % 2 === 0 ? 0.1 : -0.1)));
  const input = youngGoal(50, { weightReadings: flat, intakeDays: LOGGING_USER });
  const p = computeGoalProgress(input);
  assert.equal(p.verdict, 'holding');
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assert.equal(p.weightRead?.state, 'plateau');
  assert.match(p.headline, /^Plateau — weekly average ~89\.[45] kg for 3 weeks$/);
  assert.equal(
    p.reasons[0].text,
    'Common and often water: keep 2,000 kcal and 3 sessions; if still flat in 2 weeks, trim ~150 kcal a day or add two 30-minute walks',
  );
  // Unknown parts are omitted, never invented.
  const unknown = computeGoalProgress({ ...input, budget: null, target: { ...input.target, weeklySessions: null } });
  assert.equal(unknown.reasons[0].text, 'Common and often water: keep your routine; if still flat in 2 weeks, trim ~150 kcal a day or add two 30-minute walks');
  const kcalOnly = computeGoalProgress({ ...input, target: { ...input.target, weeklySessions: null } });
  assert.match(kcalOnly.reasons[0].text, /^Common and often water: keep 2,000 kcal; if still flat/);
  // Someone who logs no food gets activity and logging first, not a kcal trim there is nothing to check against (wave 22w).
  const noLogs = computeGoalProgress({ ...input, intakeDays: [], intakeHistoryDays: undefined });
  assert.equal(
    noLogs.reasons[0].text,
    'Common and often water: keep 2,000 kcal and 3 sessions; if still flat in 2 weeks, add two 30-minute walks and log a few days so we can see where the calories go',
  );
  assert.doesNotMatch(noLogs.reasons[0].text, /trim/);
  // The call is made on the raw weekly means, not the smoothed trend.
  assert.equal(p.weightRead?.weekMeanKg !== null, true);
});

test('D. no plateau call in a goal under 28 days old, or when the weekly means are still falling', () => {
  const flat = onDays(span(-27, 0), o => 89.5 + (o % 2 === 0 ? 0.1 : -0.1));
  const young = computeGoalProgress(youngGoal(27, { weightReadings: flat }));
  assert.notEqual(young.weightRead?.state, 'plateau');
  const falling = computeGoalProgress(youngGoal(60, { weightReadings: onDays(span(-27, 0), o => 89.5 + o * 0.05) }));
  assert.notEqual(falling.weightRead?.state, 'plateau');
});

test('D. a shorter flat spell is "Stalled", not a plateau', () => {
  const p = computeGoalProgress(youngGoal(60, { weightReadings: onDays(span(-14, 0), () => 89.5) }));
  assert.equal(p.verdict, 'stalled');
});

test('F. reached: the weekly average reaches the target before the lagging trend, and the copy is not "84.1 is at or past 84"', () => {
  const readings = onDays(span(-40, 0), o => (o < -12 ? 90 + (o + 40) * -0.2 : 84 + (o % 2 === 0 ? 0.05 : -0.05)));
  const p = computeGoalProgress(youngGoal(80, { weightReadings: readings }));
  assert.equal(p.verdict, 'reached');
  assert.equal(p.current.progressPct, 100);
  assert.match(p.headline, /^Goal reached — 84 kg \(\w{3} \d{1,2}\)$/);
  assert.match(p.reasons[0].text, /^You hit 84 kg — weekly average 84\.0 kg, first reached \w{3} \d{1,2}$/);
  assert.doesNotMatch(p.reasons.map(r => r.text).join(' '), /at or past/);
  assert.equal(p.weightRead?.state, 'reached');
  assert.ok(p.weightRead!.reachedDaysAgo! >= 0);
  assert.equal(p.reasons[1].text, 'Holding at your 84 kg target');
  // Wave 21w: reached 12 days ago — past the first week, "Set a new target or switch to maintenance" is not asked again; wave 22w: the
  // first 3 weeks of maintenance carry the step toward it as a number instead.
  assert.deepEqual(p.reasons.map(r => r.kind), ['reached', 'position', 'next_step']);
  assert.doesNotMatch(p.reasons[2].text, /Set a new target/);
  // Wave 23w: the step was given once, in the week of the reach; twelve days on it is a standing level to read on a Monday (a snack: no food is logged).
  assert.match(p.reasons[2].text, /^Keep the daily snack \(the step you started \w{3} \d{1,2}\); we'll read it on \w{3}, \w{3} \d{1,2}$/);
});

test('F. reached copy is unit-aware: lb for imperial users', () => {
  const readings = onDays(span(-40, 0), o => (o < -12 ? 90 + (o + 40) * -0.2 : 84 + (o % 2 === 0 ? 0.05 : -0.05)));
  const p = computeGoalProgressRaw(youngGoal(80, { unitSystem: 'imperial', weightReadings: readings }));
  assert.ok(p.reasons[0].text.startsWith(`You hit 185.2${NBSP}lb — weekly average 185.2${NBSP}lb`), p.reasons[0].text);
  assert.equal(p.reasons[1].text, `Holding at your 185.2${NBSP}lb target`);
});

test('F. reached is sticky: one 84.5 reading does not flip it back, and the trend must leave the range to end it', () => {
  const settled = onDays(span(-40, -1), o => (o < -12 ? 90 + (o + 40) * -0.2 : 83.9));
  const calm = computeGoalProgress(youngGoal(80, { weightReadings: [...settled, ...onDays([0], () => 83.9)] }));
  const spike = computeGoalProgress(youngGoal(80, { weightReadings: [...settled, ...onDays([0], () => 84.5)] }));
  assert.equal(calm.verdict, 'reached');
  assert.equal(spike.verdict, 'reached');
  assert.equal(spike.reachedAt, calm.reachedAt);
  // A real regain past target + 1 kg ends it.
  const regain = onDays(span(-70, 0), o => (o < -42 ? 90 + (o + 70) * -0.25 : o < -30 ? 83.5 : 83.5 + (o + 30) * 0.12));
  assert.notEqual(computeGoalProgress(youngGoal(110, { weightReadings: regain })).verdict, 'reached');
});

test('F. reached (gain, mirrored): the weekly average within 0.3 kg of a muscle target reaches it', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 78, date: null, weeklySessions: 4 },
    start: { weightKg: 70, startedAt: `${addDays(TODAY, -60)}T08:00:00.000Z` },
    weightReadings: onDays(span(-55, 0), o => (o < -14 ? 70 + (o + 55) * 0.19 : 77.9)),
    trainingDays: span(-27, 0).map(o => addDays(TODAY, o)),
  }));
  assert.equal(p.verdict, 'reached');
  assert.match(p.reasons[0].text, /^You hit 78 kg — weekly average 77\.9 kg/);
});

test('G. no reason prints a "Trend X kg" number; the chart trend is explained once, in the first week a pace is read', () => {
  // Wave 21w (finding 5): the card has ONE weight, the weekly average. The first pace week — a pace exists now, none a week
  // ago — carries one short explainer for the smoothed trend line on the chart, with no trend number in it.
  const first = paceCase(onDays(span(-19, 0), o => 91.5 + (o + 19) * -0.07), addDays(TODAY, 120), {
    start: { weightKg: 91.5, startedAt: `${addDays(TODAY, -24)}T08:00:00.000Z` },
  });
  const explainers = first.reasons.filter(r => r.kind === 'trend');
  assert.equal(explainers.length, 1);
  assert.match(explainers[0].text, /^The chart's trend line smooths daily water swings, so it trails your weekly average a little$/);
  assert.equal(first.reasons[0].kind, 'rate', 'the pace leads');
  assert.ok(!first.reasons.some(r => /Trend \d|trend \d/.test(r.text)), 'no trend number anywhere');
  // Every later week: nothing to explain, and still no trend number.
  const falling = onDays(span(-50, 0), o => (o < -21 ? 92 : 92 + (o + 21) * -0.1));
  const later = computeGoalProgress(youngGoal(60, { weightReadings: onDays(span(-59, 0), o => 92 - 0.07 * (o + 59)) }));
  assert.ok(!later.reasons.some(r => r.kind === 'trend' || /Trend \d/.test(r.text)), JSON.stringify(later.reasons));
  assert.ok(!computeGoalProgress(youngGoal(51, { weightReadings: falling })).reasons.some(r => /Trend \d/.test(r.text)));
  // Trend and scale together: nothing to explain.
  const steady = computeGoalProgress(youngGoal(60, { weightReadings: onDays(span(-59, 0), () => 90) }));
  assert.ok(!steady.reasons.some(r => r.kind === 'trend'));
});

// ── Wave 20b: a lapse, the first month's counter, week over week, the return as shown, the second lift ──

// TODAY = Tue 2026-10-06. Squat trained steadily to the week of 09-21 (best 142 kg), nothing after the last session.
const LAPSE_SQUAT = [lw('2026-08-24', 130), lw('2026-08-31', 133), lw('2026-09-07', 136), lw('2026-09-14', 139), lw('2026-09-21', 142)];
const lapseInput = (daysSince: number, over: Partial<GoalProgressInput> = {}): GoalProgressInput => {
  const last = addDays(TODAY, -daysSince);
  // A session a day from 08-31 to `last`: the 4-week adherence is full, so only the lapse can change the card.
  const days = Array.from({ length: 80 }, (_, i) => addDays('2026-08-31', i)).filter(d => d <= last);
  return base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' },
    progression: { squat: LAPSE_SQUAT },
    strengthDays: days,
    trainingDays: days,
    ...over,
  });
};

test('a lapse: the card stops praising the lifts — "No sessions for 8 days", the lift dated, never "+12 kg vs 4 weeks ago"', () => {
  // Control: 3 days since the last session is still the normal read for a 4 a week lifter.
  const recent = computeGoalProgress(lapseInput(3));
  assert.equal(recent.verdict, 'progressing');
  assert.match(recent.headline, /^Progressing — Squat est\. 1RM \+12 kg vs 4 weeks ago$/);
  // Past the threshold: holding, with the dated lift (the weekly data only knows the week the best was set).
  const p = computeGoalProgress(lapseInput(8));
  assert.equal(p.verdict, 'holding');
  assert.equal(p.headline, 'No sessions for 8 days — Squat was est. 1RM 142 kg, week of Sep 21');
  const lift = p.reasons.find(r => r.kind === 'lift')!;
  assert.equal(lift.text, 'Squat was est. 1RM 142 kg in the week of Sep 21');
  assert.equal(lift.tone, 'neutral');
  assert.doesNotMatch(JSON.stringify(p), /vs 4 weeks ago|Progressing|Lifts up/);
  assert.equal(p.lastSessionDaysAgo, 8);
  assert.equal(p.lastSessionOn, addDays(TODAY, -8));
  assertWellFormed(p);
  // The threshold scales to the weekly target, clamp(ceil(14 / target), 4, 7): the 4th day for 4 a week (a 6-day gap
  // used to read "Progressing"), the 5th for 3 a week, the 7th for 2 a week.
  assert.equal(computeGoalProgress(lapseInput(4)).headline, 'No sessions for 4 days — Squat was est. 1RM 142 kg, week of Sep 21');
  const weekly = (n: number) => ({ target: { weightKg: null, date: null, weeklySessions: n } });
  assert.match(computeGoalProgress(lapseInput(4, weekly(3))).headline, /^Progressing — /);
  assert.equal(computeGoalProgress(lapseInput(5, weekly(3))).headline, 'No sessions for 5 days — Squat was est. 1RM 142 kg, week of Sep 21');
  assert.match(computeGoalProgress(lapseInput(6, weekly(2))).headline, /^Progressing — /);
  assert.equal(computeGoalProgress(lapseInput(7, weekly(2))).headline, 'No sessions for 7 days — Squat was est. 1RM 142 kg, week of Sep 21');
  assert.match(computeGoalProgress(lapseInput(4, weekly(6))).headline, /^No sessions for 4 days/); // never under 4
  // Pounds: 142 kg = 313 lb.
  assert.equal(computeGoalProgress(lapseInput(8, { unitSystem: 'imperial' })).headline, 'No sessions for 8 days — Squat was est. 1RM 313 lb, week of Sep 21');
});

test('a lapse with a second lift up: neither lift is praised, and "sessions behind" does not bring "Lifts up" back', () => {
  const bench = [lw('2026-08-24', 100), lw('2026-08-31', 100), lw('2026-09-07', 104), lw('2026-09-14', 106), lw('2026-09-21', 108)];
  const p = computeGoalProgress(lapseInput(9, {
    progression: { squat: LAPSE_SQUAT, 'bench press': bench },
    // 9 of 16 planned sessions in 28 days would be "Lifts up, sessions behind" without the lapse.
    strengthDays: Array.from({ length: 9 }, (_, i) => addDays(TODAY, -9 - i * 2)),
  }));
  assert.equal(p.verdict, 'holding');
  assert.doesNotMatch(JSON.stringify(p), /Lifts up|vs 4 weeks ago/);
  assert.equal(p.reasons.filter(r => r.kind === 'lift').length, 1);
});

test('a lifter who stops again after coming back from a break: the lapse leads, not "Building back"', () => {
  const days = BREAK_HISTORY_DAYS.filter(d => d < '2026-09-30'); // back 09-28, then nothing for 8 days
  const p = computeGoalProgress(breakInput({ squat: squatBack(136, 136) }, { strengthDays: days.filter(d => d >= addDays(TODAY, -27)), strengthHistoryDays: days }));
  assert.equal(p.verdict, 'holding');
  assert.match(p.headline, /^No sessions for 8 days — Squat was est\. 1RM 136 kg/);
  assert.notEqual(p.liftReturn, null, 'the payload still says it is a return');
});

test('a week that cannot reach its target: "0 of 4 sessions this week (last: Oct 3)" is amber, and the card is never "Progressing" over it (wave 21)', () => {
  // Friday 10-09: nothing since Sat 10-03 (6 days), 0 + 3 days left < 4. Once a lapse (4 days for 4 a week) it also says so.
  const friday = '2026-10-09';
  const fri = computeGoalProgress(lapseInput(0, { todayKey: friday, strengthDays: [...lapseInput(0).strengthDays!.filter(d => d <= '2026-10-03')] }));
  assert.deepEqual(fri.reasons[0], { kind: 'week_sessions', text: '0 of 4 sessions this week (last: Oct 3)', tone: 'watch' });
  assert.equal(fri.verdict, 'holding');
  assert.match(fri.headline, /^No sessions for 6 days/);
  assert.doesNotMatch(JSON.stringify(fri), /Progressing/);
  assert.equal(fri.lastSessionDaysAgo, 6);
  // Two sessions Mon + Fri, Sunday: not a lapse (2 days off) but the week can no longer reach 4 (2 + 1 day left).
  const sunday = '2026-10-04';
  const skipped = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-03', '2026-10-04'];
  const sunDays = lapseInput(0).strengthDays!.filter(d => d <= sunday && !skipped.includes(d));
  const sun = computeGoalProgress(lapseInput(0, { todayKey: sunday, strengthDays: sunDays, trainingDays: sunDays }));
  assert.deepEqual(sun.reasons[0], { kind: 'week_sessions', text: '2 of 4 sessions this week (last: Oct 2)', tone: 'watch' });
  assert.equal(sun.verdict, 'holding');
  // 2 of 4 is a slack week: the card leads with the week, and the squat (not trained this week) is dated and neutral (wave 23s).
  assert.equal(sun.headline, 'Week short — 2 of 4 so far');
  assert.equal(sun.reasons.find(r => r.kind === 'lift')!.tone, 'neutral');
  assert.doesNotMatch(JSON.stringify(sun), /Progressing/);
  assertWellFormed(sun);
  // The day before it can still be hit (2 + Sat + Sun = 4): the normal read, no amber.
  const sat = computeGoalProgress(lapseInput(0, { todayKey: '2026-10-03', strengthDays: sunDays.filter(d => d <= '2026-10-03'), trainingDays: sunDays.filter(d => d <= '2026-10-03') }));
  assert.equal(sat.verdict, 'progressing');
  assert.ok(sat.reasons.every(r => r.tone !== 'watch'), JSON.stringify(sat.reasons));
  // No sessions to quote: no "(last: …)".
  const none = computeGoalProgress(base({
    goal: 'muscle', todayKey: friday, target: { weightKg: null, date: null, weeklySessions: 4 },
    start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' }, progression: { squat: LAPSE_SQUAT },
  }));
  assert.equal(none.reasons.find(r => r.kind === 'week_sessions')?.text, '0 of 4 sessions this week');
  // Weight-led (no lift data): a short week is not "Progressing — weight up ..." either.
  const weightDays = Array.from({ length: 80 }, (_, i) => addDays('2026-08-31', i)).filter(d => d <= sunday && !skipped.includes(d));
  const weightLed = computeGoalProgress(base({
    goal: 'muscle', todayKey: sunday, target: { weightKg: 90, date: null, weeklySessions: 4 },
    start: { weightKg: 80, startedAt: '2026-06-01T09:00:00.000Z', startedDay: '2026-06-01' },
    weightReadings: Array.from({ length: 40 }, (_, i) => {
      const day = addDays(sunday, -(39 - i));
      return { measuredAt: `${day}T08:00:00.000Z`, valueKg: 80 + 0.04 * i, source: 'manual' as const, localDay: day };
    }),
    strengthDays: weightDays, trainingDays: weightDays,
  }));
  assert.doesNotMatch(weightLed.headline, /Progressing/);
});

test('weekFitsSessionTarget: missing sessions must fit the days left (today only while untrained) and not need three in a row (wave 22s)', () => {
  // 4 a week. Monday / Tuesday / Wednesday with nothing yet: 4 sessions in 7 / 6 / 5 days left (today included) fit with rest days between.
  assert.equal(weekFitsSessionTarget(0, 4, 7, false), true);
  assert.equal(weekFitsSessionTarget(0, 4, 6, false), true);
  assert.equal(weekFitsSessionTarget(0, 4, 5, false), true);
  // Thursday with nothing yet: 4 in Thu-Sun is four in a row. A session today leaves Fri-Sun for 3 more: three in a row.
  assert.equal(weekFitsSessionTarget(0, 4, 4, false), false);
  assert.equal(weekFitsSessionTarget(1, 4, 4, true), false);
  // ... but one session on Wednesday (not today) and Thursday still open: 3 in Thu-Sun fits (Thu, Fri, Sun / Thu, Sat, Sun).
  assert.equal(weekFitsSessionTarget(1, 4, 4, false), true);
  // Friday 2 of 4, Saturday 2 of 4 (Sat + Sun back to back is fine), Sunday 2 of 4 (one day for two sessions).
  assert.equal(weekFitsSessionTarget(2, 4, 3, false), true);
  assert.equal(weekFitsSessionTarget(2, 4, 2, false), true);
  assert.equal(weekFitsSessionTarget(2, 4, 1, false), false);
  // The target met, or passed, always fits.
  assert.equal(weekFitsSessionTarget(4, 4, 1, true), true);
  assert.equal(weekFitsSessionTarget(5, 4, 3, false), true);
  // 5 a week: Monday morning with nothing yet fits; 6 a week tolerates its own runs of 3; 7 a week is every day.
  assert.equal(weekFitsSessionTarget(0, 5, 7, false), true);
  assert.equal(weekFitsSessionTarget(1, 6, 6, false), true);
  assert.equal(weekFitsSessionTarget(0, 7, 7, false), true);
  assert.equal(weekFitsSessionTarget(0, 7, 6, false), false);
});

test('Thursday of a one-session week is already "week short": the card does not say Progressing on Thu-Fri and short on Sat-Sun (wave 22s)', () => {
  // Daily sessions to Sunday 09-27, then nothing until Thursday 10-01 (1 of 4 this week). Wednesday: 3 days off, 4 sessions still fit in Wed-Sun.
  const upTo = (day: string, sessions: string[]) => [...Array.from({ length: 80 }, (_, i) => addDays('2026-08-31', i)).filter(d => d <= '2026-09-27'), ...sessions].filter(d => d <= day);
  const at = (day: string, sessions: string[]) => computeGoalProgress(lapseInput(0, { todayKey: day, strengthDays: upTo(day, sessions), trainingDays: upTo(day, sessions) }));
  const wed = at('2026-09-30', ['2026-10-01']);
  assert.equal(wed.verdict, 'progressing');
  const thu = at('2026-10-01', ['2026-10-01']);
  assert.equal(thu.verdict, 'holding');
  assert.equal(thu.headline, 'Week short — 1 of 4 so far');
  assert.deepEqual(thu.reasons[0], { kind: 'week_sessions', text: '1 of 4 sessions this week (last: today)', tone: 'watch' });
  // Friday and the weekend say the same thing.
  for (const day of ['2026-10-02', '2026-10-03', '2026-10-04']) {
    const p = at(day, ['2026-10-01']);
    assert.equal(p.verdict, 'holding', day);
    assert.equal(p.headline, 'Week short — 1 of 4 so far', day);
    // ... and the day after the session it is "yesterday", then the date.
    assert.equal(p.reasons[0].text, `1 of 4 sessions this week (last: ${day === '2026-10-02' ? 'yesterday' : 'Oct 1'})`, day);
  }
  // Monday of the next week starts clean: no amber week line (it is the lapse, 4 days off, that holds the card then).
  assert.ok(at('2026-10-05', ['2026-10-01']).reasons.every(r => r.kind !== 'week_sessions' || r.tone !== 'watch'));
});

test('a slack week (half the sessions or fewer, the week out of reach) leads with the week and colours no lift or weight line green it did not produce (wave 23s)', () => {
  // Thursday 10-01, one session today (1 of 4): the squat (best 142 kg, wk of 09-21) was NOT trained this week.
  const upTo = (day: string, sessions: string[]) => [...Array.from({ length: 80 }, (_, i) => addDays('2026-08-31', i)).filter(d => d <= '2026-09-27'), ...sessions].filter(d => d <= day);
  const at = (day: string, sessions: string[], over: Partial<GoalProgressInput> = {}) =>
    computeGoalProgress(lapseInput(0, { todayKey: day, strengthDays: upTo(day, sessions), trainingDays: upTo(day, sessions), ...over }));
  const thu = at('2026-10-01', ['2026-10-01']);
  assert.equal(thu.headline, 'Week short — 1 of 4 so far');
  assert.equal(thu.verdict, 'holding');
  const lift = thu.reasons.find(r => r.kind === 'lift')!;
  assert.deepEqual(lift, { kind: 'lift', text: 'Squat est. 1RM 142 kg (wk of Sep 21)', tone: 'neutral' });
  assert.ok(thu.reasons.every(r => r.tone !== 'good' || r.kind === 'adherence'), JSON.stringify(thu.reasons));
  assertWellFormed(thu);
  // Pounds: the dated line is in the display unit (142 kg = 313 lb).
  assert.equal(at('2026-10-01', ['2026-10-01'], { unitSystem: 'imperial' }).reasons.find(r => r.kind === 'lift')!.text, 'Squat est. 1RM 313 lb (wk of Sep 21)');
  // A squat trained at working weight THIS week (week of 09-28: top set 105 kg, its best in the 4 weeks before was 105 kg) keeps its green line,
  // but the headline still leads with the week.
  const trained = at('2026-10-01', ['2026-10-01'], { progression: { squat: [...LAPSE_SQUAT, lw('2026-09-28', 142, 1, { topLoadKg: 105 })].map((w, i, all) => i < all.length - 1 ? { ...w, topLoadKg: 105 } : w) } });
  assert.equal(trained.headline, 'Week short — 1 of 4 so far');
  assert.equal(trained.reasons.find(r => r.kind === 'lift')!.tone, 'good');
  // A light day (top set under 90% of its best) is not working weight: neutral and dated again.
  const light = at('2026-10-01', ['2026-10-01'], { progression: { squat: [...LAPSE_SQUAT.map(w => ({ ...w, topLoadKg: 105 })), lw('2026-09-28', 142, 1, { topLoadKg: 90 })] } });
  assert.equal(light.reasons.find(r => r.kind === 'lift')!.tone, 'neutral');
  // More than half the plan (3 of 5 here is not slack, the Sunday still out of reach): the old read stands.
  const three = computeGoalProgress(lapseInput(0, { todayKey: '2026-10-04', target: { weightKg: null, date: null, weeklySessions: 5 }, strengthDays: upTo('2026-10-04', ['2026-09-29', '2026-10-01', '2026-10-03']), trainingDays: upTo('2026-10-04', ['2026-09-29', '2026-10-01', '2026-10-03']) }));
  assert.doesNotMatch(three.headline, /^Week short/);
  // A green weight line is neutral in a slack week (the scale moved; the sessions did not).
  const gain = (n: number) => Array.from({ length: n }, (_, i) => { const day = addDays('2026-10-01', -(n - 1 - i)); return { measuredAt: `${day}T08:00:00.000Z`, valueKg: 80 + 0.03 * i, source: 'manual' as const, localDay: day }; });
  const heavier = at('2026-10-01', ['2026-10-01'], { weightReadings: gain(28).map(r => ({ ...r, valueKg: r.valueKg + 0.01 * Number(r.localDay.slice(8)) })), progression: {} });
  const rate = heavier.reasons.find(r => r.kind === 'rate');
  assert.ok(rate, JSON.stringify(heavier.reasons));
  assert.match(rate.text, /on pace for lean gain/);
  assert.equal(rate.tone, 'neutral', rate.text);
});

test('headlineLift: the muscle card sends the key of the lift it leads with (sticky), and no other goal carries it (wave 22s)', () => {
  const squat = computeGoalProgress(lapseInput(3));
  assert.equal(squat.headlineLift, 'squat');
  assert.match(squat.headline, /^Progressing — Squat est\. 1RM/);
  // The most-trained lift that has a 4-week comparison, like the headline: bench has none here, so the squat leads.
  const bench = [lw('2026-09-21', 100)];
  assert.equal(computeGoalProgress(lapseInput(3, { progression: { squat: LAPSE_SQUAT, 'bench press': bench } })).headlineLift, 'squat');
  // No lift in rotation: null, never undefined, for a muscle goal.
  assert.equal(computeGoalProgress(lapseInput(3, { progression: {} })).headlineLift, null);
  // Other goals: the key is absent (their payloads are byte-identical to before).
  assert.equal('headlineLift' in computeGoalProgress(base({ goal: 'weight_loss', target: { weightKg: 80, date: null, weeklySessions: null } })), false);
});

test('a lapse is not a time to praise the scale: the weight line is neutral and about the lapse (wave 21)', () => {
  const weightReadings = ramp(30, 80, 0.03); // ~0.21 kg a week, 0.26% of bodyweight: inside the gain band
  const normal = computeGoalProgress(lapseInput(3, { weightReadings }));
  const praised = normal.reasons.find(r => r.kind === 'rate')!;
  assert.equal(praised.tone, 'good');
  assert.match(praised.text, /on pace for lean gain \(0\.1–0\.5% of bodyweight a week\)/);
  // The first two weeks of a lapse: most of the 28-day rate is from before the break, so the line says so (wave 22s) - no blame.
  const early = computeGoalProgress(lapseInput(8, { weightReadings }));
  assert.match(early.reasons.find(r => r.kind === 'rate')!.text, /^Trend weight up about 0\.\d\skg\/wk, mostly from before the break$/);
  assert.doesNotMatch(JSON.stringify(early), /with no training/);
  const lapsed = computeGoalProgress(lapseInput(14, { weightReadings }));
  assert.equal(lapsed.verdict, 'holding');
  const rate = lapsed.reasons.find(r => r.kind === 'rate')!;
  assert.match(rate.text, /^Trend weight up about 0\.\d kg\/wk with no training$/);
  assert.equal(rate.tone, 'neutral');
  assert.doesNotMatch(JSON.stringify(lapsed), /safe band|lean gain/);
  // Pounds.
  assert.match(computeGoalProgress(lapseInput(14, { weightReadings, unitSystem: 'imperial' })).reasons.find(r => r.kind === 'rate')!.text, /^Trend weight up about 0\.\d lb\/wk with no training$/);
  // A rate that is already a warning keeps its amber line.
  const fast = computeGoalProgress(lapseInput(14, { weightReadings: ramp(30, 80, 0.12) }));
  assert.equal(fast.reasons.find(r => r.kind === 'rate')?.tone, 'watch');
});

test('week over week names its window: a Sunday quotes "Last week" (the week before the one just trained), Monday the same pair as the review (wave 21)', () => {
  // Squat e1RM 100 -> 104 -> 107 in weeks of 09-14, 09-21, 09-28.
  const progression = { squat: [lw('2026-09-14', 100), lw('2026-09-21', 104), lw('2026-09-28', 107)] };
  const at = (todayKey: string, over: Partial<GoalProgressInput> = {}) => computeGoalProgress(base({
    goal: 'muscle', todayKey, target: { weightKg: null, date: null, weeklySessions: 4 },
    start: { weightKg: 80, startedAt: '2026-09-14T09:00:00.000Z', startedDay: '2026-09-14' }, progression, ...over,
  })).reasons.find(r => r.kind === 'lift')!;
  // Sunday 10-04: the week that just ended is 09-28 but the card's pair is the last COMPLETED week before it (09-21 vs 09-14).
  assert.equal(at('2026-10-04').text, 'Last week: Squat est. 1RM +4 kg vs the week before');
  // Monday 10-05: 09-28 is now last week — the pair Monday's review reads (+3).
  assert.equal(at('2026-10-05').text, 'Last week: Squat est. 1RM +3 kg vs the week before');
  // The week in progress (no earlier pair yet) says "This week"; a skipped week says "last trained week".
  assert.equal(at('2026-09-29', { progression: { squat: [lw('2026-09-21', 100), lw('2026-09-28', 105)] } }).text, 'This week: Squat est. 1RM +5 kg vs last week');
  assert.equal(at('2026-10-06', { progression: { squat: [lw('2026-09-14', 100), lw('2026-10-05', 105)] } }).text, 'This week: Squat est. 1RM +5 kg vs last trained week');
  assert.equal(at('2026-10-06', { progression: { squat: [lw('2026-09-07', 100), lw('2026-09-28', 105)] } }).text, 'Last week: Squat est. 1RM +5 kg vs last trained week');
});

test('first 28 days: calendar weeks ("This week 2 of 4 (6 since Sep 27)"), never planned < done, no watch before the first full week', () => {
  const mk = (ageDays: number, done: number, over: Partial<GoalProgressInput> = {}) => computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    start: startedDaysAgo(ageDays),
    progression: { squat: [lw('2026-10-05', 100)] },
    trainingDays: Array.from({ length: done }, (_, i) => addDays(TODAY, -i)),
    ...over,
  }));
  // Day 0: one session. The old copy was "[watch] 1 of 4 planned sessions in 7 days (25%)".
  const day0 = mk(0, 1);
  const r0 = day0.reasons.find(r => r.kind === 'adherence')!;
  assert.equal(r0.text, 'This week 1 of 4'); // nothing before this week: no "(N since …)"
  assert.equal(r0.tone, 'neutral');
  assert.notEqual(day0.verdict, 'behind');
  assert.match(day0.headline, /^4-week lift trend from Nov \d+$/);
  // Sweep the first month (goal age 1..27 days): never an "X of Y" with X > Y, never amber before the first full week.
  for (let age = 0; age <= 26; age += 1) {
    for (let done = 0; done <= 9; done += 1) {
      const p = mk(age, done);
      const r = p.reasons.find(x => x.kind === 'adherence');
      if (!r) continue;
      for (const m of r.text.matchAll(/(\d+) of (\d+)/g)) assert.ok(Number(m[1]) <= Number(m[2]), `age ${age}, done ${done}: ${r.text}`);
      if (age < 6) assert.notEqual(r.tone, 'watch', `age ${age}, done ${done}: ${r.text}`);
      assert.match(r.text, /^This week \d of 4( \(\d+ since [A-Z][a-z]{2} \d+\))?$/);
    }
  }
  // The 28th day on, the established copy applies.
  assert.equal(mk(27, 9).reasons.find(r => r.kind === 'adherence')!.text, '9 of 16 planned sessions in 4 weeks (56%)');
  // After the first full week the plan is judged: 10 days in with 2 sessions of ~6 planned is a watch.
  assert.equal(mk(9, 2).reasons.find(r => r.kind === 'adherence')!.tone, 'watch');
  // The headline only changes when a session is logged: the same count reads the same on every day of the month.
  const heads = new Set(Array.from({ length: 20 }, (_, i) => mk(5 + i, 4, { progression: { squat: [lw('2026-10-05', 100)] } }).headline));
  assert.equal(heads.size, 1, [...heads].join(' | '));
  // This week's count is never past the target: 5 sessions in a 4-session week is still "4 of 4".
  const week = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 1 }, start: startedDaysAgo(3),
    progression: { squat: [lw('2026-10-05', 100)] }, trainingDays: [TODAY, addDays(TODAY, -1)],
  }));
  assert.equal(week.reasons.find(r => r.kind === 'adherence')!.text, 'This week 1 of 1'); // both sessions are this week: no count beside it
});

test('past the first month, sessions past the plan read as a count, not "17 of 16 planned"', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    trainingDays: Array.from({ length: 17 }, (_, i) => addDays(TODAY, -i)),
  }));
  const r = p.reasons.find(x => x.kind === 'adherence')!;
  assert.equal(r.text, '17 sessions in 4 weeks, past your 16 planned (106%)');
  assert.equal(r.tone, 'good');
});

test('before the first 4-week comparison the card shows the review\'s week-over-week line, labelled the same', () => {
  // Weeks 2-4: squat 100 -> 103 last week; TODAY is Tuesday 10-06 and this week has no sets yet.
  const progression = { squat: [lw('2026-09-21', 100), lw('2026-09-28', 103)] };
  const days = [...daysAt('2026-09-21', [0, 2, 4]), ...daysAt('2026-09-28', [0, 2, 4]), '2026-10-05'];
  const p = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 },
    start: { weightKg: 80, startedAt: '2026-09-20T09:00:00.000Z', startedDay: '2026-09-20' },
    progression, strengthDays: days, trainingDays: days,
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.match(p.headline, /^4-week lift trend from /);
  const lift = p.reasons.find(r => r.kind === 'lift')!;
  assert.equal(lift.text, 'Last week: Squat est. 1RM +3 kg vs the week before');
  assert.equal(lift.tone, 'good');
  // A drop is amber only for a finished week (the review's rule), and not in a deload.
  const down = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 },
    start: { weightKg: 80, startedAt: '2026-09-20T09:00:00.000Z', startedDay: '2026-09-20' },
    progression: { squat: [lw('2026-09-21', 103), lw('2026-09-28', 99)] }, strengthDays: days, trainingDays: days,
  }));
  assert.equal(down.reasons.find(r => r.kind === 'lift')!.text, 'Last week: Squat est. 1RM −4 kg vs the week before');
  assert.equal(down.reasons.find(r => r.kind === 'lift')!.tone, 'watch');
  // Once a 4-week comparison exists it takes over.
  const four = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 },
    progression: { squat: [lw('2026-08-31', 95), lw('2026-09-21', 100), lw('2026-09-28', 103)] }, strengthDays: days, trainingDays: days,
  }));
  assert.match(four.reasons.find(r => r.kind === 'lift')!.text, /vs 4 weeks ago/);
});

test('the return as shown: the headline says est. 1RM with the shown numbers; the percentage comes from them; regained drops the break reason', () => {
  // 136.5 kg rounds to 137 (not 136), pre-break 142.4 rounds to 142: 137 of 142 is 96%, where the unrounded 136.5 / 142.4 is 95%.
  const squat = [lw('2026-08-17', 130), lw('2026-08-24', 133), lw('2026-08-31', 136), lw('2026-09-07', 142.4), lw('2026-09-28', 136.5), lw('2026-10-05', 136.5)];
  const p = computeGoalProgress(breakInput({ squat }));
  assert.equal(p.headline, 'Building back — Squat est. 1RM 137 of 142 kg pre-break');
  assert.equal(p.reasons[0].text, 'Squat est. 1RM 137 kg, 96% of your 142 kg pre-break best');
  assert.equal(p.liftReturn!.pct, 95, 'the payload keeps its unrounded, rounded-down percentage (iOS reads it)');
  // Still under by a hair: never "142 of 142" before it is regained.
  const hair = computeGoalProgress(breakInput({ squat: [...squat.slice(0, 4), lw('2026-09-28', 141.6), lw('2026-10-05', 141.6)] }));
  assert.equal(hair.liftReturn!.regained, false);
  assert.equal(hair.headline, 'Building back — Squat est. 1RM 141 of 142 kg pre-break');
  // Pounds: 136.5 kg = 301 lb, 142.4 kg = 314 lb.
  assert.equal(computeGoalProgress(breakInput({ squat }, { unitSystem: 'imperial' })).headline, 'Building back — Squat est. 1RM 301 of 314 lb pre-break');
  // Regained: the "Back after a 15-day break" reason is dropped.
  const back = computeGoalProgress(breakInput({ squat: squatBack(145, 145) }));
  assert.equal(back.liftReturn!.regained, true);
  assert.ok(!back.reasons.some(r => r.kind === 'return'), JSON.stringify(back.reasons));
  assert.ok(!back.reasons.some(r => /Back after a/.test(r.text)));
  // While rebuilding it is still there.
  assert.ok(computeGoalProgress(breakInput({ squat: squatBack(136, 136) })).reasons.some(r => r.kind === 'return'));
});

test('the second lift\'s reason outranks the in-band weight-rate line', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: 85, date: null, weeklySessions: 4 },
    progression: lifts(100, 105),
    weightReadings: ramp(60, 75, 0.04), // ~0.35%/wk: inside the gain band
    trainingDays: Array.from({ length: 14 }, (_, i) => addDays(TODAY, -i * 2)),
  }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['lift', 'adherence', 'lift']);
  assert.notEqual(p.reasons[0].text.split(' est.')[0], p.reasons[2].text.split(' est.')[0], 'two different lifts');
});

// ── wave 20c: one progress weight, a pace across a gap, steady too-fast, behind dates, plateau on the logs ──

test('B6. weight loss measures progress from ONE weight — the 7-day average — in changeKg, progressPct, "to go" and the early read', () => {
  // Falling 0.12 kg a day with a bump on the last reading, so the scale, the weekly average and the smoothed trend differ.
  const readings = onDays(span(-40, 0), o => 92 - 0.12 * (o + 40) + (o === 0 ? 0.8 : 0));
  const p = computeGoalProgress(youngGoal(80, { weightReadings: readings }));
  const read = p.weightRead!;
  assert.equal(read.state, 'pace');
  const mean = read.weekMeanKg!;
  assert.notEqual(read.scaleKg, mean);
  // Wave 21w (finding 5): the displayed weight IS the progress weight; the smoothed trend is the third number, in `trendKg`.
  assert.equal(p.current.weightKg, mean);
  assert.notEqual(p.current.trendKg, mean, 'the smoothed trend is a third number');
  assert.equal(p.current.changeKg, Math.round((mean - 92) * 10) / 10);
  assert.equal(p.current.progressPct, Math.round(((92 - mean) / 8) * 100));
  const toGo = /about ([\d.]+) kg to go/.exec(p.headline);
  assert.ok(toGo, p.headline);
  assert.equal(Number(toGo![1]), Math.round((mean - 84) * 10) / 10);
  // Without a weekly average (fewer than 3 weigh-ins that week) the latest scale reading is the progress weight.
  const sparse = computeGoalProgress(youngGoal(80, { weightReadings: onDays([-40, -33, -26, -20, -14, -8, -2], o => 92 - 0.12 * (o + 40)) }));
  assert.equal(sparse.weightRead!.weekMeanKg, null);
  assert.equal(sparse.current.changeKg, Math.round((sparse.weightRead!.scaleKg! - 92) * 10) / 10);
  // The early read says the same number: the amount down is the progress weight too.
  const early = computeGoalProgress(youngGoal(10, { weightReadings: onDays(span(-9, 0), o => 92 + (o + 9) * -0.08 + (o === 0 ? 0.6 : 0)) }));
  const down = /weekly average down ([\d.]+) kg/.exec(early.headline);
  assert.ok(down, early.headline);
  assert.equal(-Number(down![1]), early.current.changeKg);
});

test('B2. a gap in weigh-ins does not drop a pace to an early read: for 7 days the line is fitted over 28 days', () => {
  // 10 daily readings, a 15-day gap, then daily again. A goal of 80 days. (Wave 21w: the week's plan reads the weigh-ins through
  // the Sunday before it, so the gap is sized to leave that Sunday's 3-week window without a pace of its own.)
  const readings = onDays([...span(-35, -26), ...span(-10, 0)], o => 92 - 0.07 * (o + 35));
  const p = computeGoalProgress(youngGoal(80, { weightReadings: readings }));
  assert.equal(p.weightRead?.state, 'pace', p.headline);
  assert.equal(p.weightRead?.paceWindowDays, 28);
  assert.match(p.reasons[0].text, /over the last 4 weeks/);
  assert.ok(p.ratePerWeek.kg != null && p.ratePerWeek.kg < 0);
  assertWellFormed(p);
  // Once the new readings carry a pace on their own it is the plain 3-week pace again.
  const later = computeGoalProgress(youngGoal(90, { todayKey: addDays(TODAY, 8), weightReadings: [...readings, ...onDays(span(1, 8), o => 92 - 0.07 * (o + 35))] }));
  assert.equal(later.weightRead?.paceWindowDays, 21);
});

test('B2. the early read of an older goal says WHY: too few weigh-ins, or enough of them in too few days', () => {
  const count = computeGoalProgress(youngGoal(80, { weightReadings: onDays([-12, -7, -3, 0], o => 92 - 0.07 * (o + 35)) }));
  assert.equal(count.weightRead?.state, 'early');
  assert.match(count.headline, /^Down [\d.]+ kg since the start — pace needs 6 weigh-ins over 2 weeks$/);
  assert.equal(count.reasons[0].text, '4 weigh-ins in the last 3 weeks; a pace needs 6 spanning at least 2 weeks');
  // Plenty of weigh-ins, but only 9 days of them (and no valid pace in the last 7 days to bridge from).
  const span9 = computeGoalProgress(youngGoal(80, { weightReadings: onDays(span(-9, 0), o => 92 - 0.07 * (o + 35)) }));
  assert.equal(span9.weightRead?.state, 'early');
  assert.match(span9.headline, /^Down [\d.]+ kg since the start — pace needs 2 weeks of weigh-ins$/);
  assert.equal(span9.reasons[0].text, '10 weigh-ins in the last 3 weeks, but they span only 9 days; a pace needs 6 spanning at least 2 weeks');
});

/** `n` daily readings from 92 kg ending today: `fast` kg/wk for the first `fastDays`, then `slow` kg/wk. */
function twoSpeedReadings(n: number, fastDays: number, fast: number, slow: number): WeightReading[] {
  let kg = 92;
  return onDays(span(-(n - 1), 0), o => {
    const i = o + (n - 1);
    const v = kg;
    kg -= (i < fastDays ? fast : slow) / 7;
    return v;
  });
}

test('B2. too fast needs the pace now and a week ago above 1%/wk, and is kept down to 0.9%', () => {
  const far = { weightKg: 70, date: addDays(TODAY, 200), weeklySessions: 3 };
  // Fast for a week only: today's pace is over 1%, last week's was not — the card does not call it yet.
  const justNow = computeGoalProgress(youngGoal(60, { target: far, weightReadings: twoSpeedReadings(35, 28, 0.6, 1.5) }));
  assert.notEqual(justNow.verdict, 'too_fast');
  // Fast for a month: called.
  const month = computeGoalProgress(youngGoal(60, { target: far, weightReadings: twoSpeedReadings(35, 35, 1.3, 1.3) }));
  assert.equal(month.verdict, 'too_fast');
  assert.match(month.headline, /^Losing too fast — 1\.\d+% of bodyweight a week$/);
  assert.equal(month.reasons[0].tone, 'watch');
  // Easing to about 0.98%/wk: the call is kept, and the band is not called safe. (Wave 21w: the week's plan reads the weigh-ins
  // through Sunday, 2 days before TODAY, so the readings run 2 days longer for the pace to have eased by then.)
  const eased = computeGoalProgress(youngGoal(60, { target: far, weightReadings: twoSpeedReadings(42, 28, 1.2, 0.57) }));
  assert.equal(eased.verdict, 'too_fast');
  assert.match(eased.headline, /^Still losing fast — 0\.9\d% of bodyweight a week$/);
  assert.match(eased.reasons[0].text, /close to the 1% a week ceiling$/);
  assert.equal(eased.reasons[0].tone, 'watch');
  assert.doesNotMatch(eased.reasons[0].text, /safe band/);
  // Below 0.9% it ends.
  const calm = computeGoalProgress(youngGoal(60, { target: far, weightReadings: twoSpeedReadings(44, 28, 1.2, 0.57) }));
  assert.notEqual(calm.verdict, 'too_fast');
  assertWellFormed(eased);
});

test('B2. within a kilo of the target a too-fast loss is "Nearly there — start easing calories toward maintenance", not too_fast', () => {
  // Falling 1.3 kg/wk for 35 days from 92: about 86 kg. Target 85.4 (about 0.6 kg to go) vs 82 (4 kg to go).
  const readings = twoSpeedReadings(35, 35, 1.3, 1.3);
  const near = computeGoalProgress(youngGoal(60, { target: { weightKg: 85.4, date: addDays(TODAY, 30), weeklySessions: 3 }, weightReadings: readings }));
  assert.equal(near.headline, 'Nearly there — start easing calories toward maintenance');
  assert.notEqual(near.verdict, 'too_fast');
  assert.ok(['ahead', 'on_track', 'progressing'].includes(near.verdict), near.verdict);
  assert.equal(near.reasons[0].tone, 'watch', 'the pace is still flagged');
  assert.ok(near.reasons.some(r => r.kind === 'action' && /easing calories toward maintenance/.test(r.text)), JSON.stringify(near.reasons));
  const far = computeGoalProgress(youngGoal(60, { target: { weightKg: 82, date: addDays(TODAY, 30), weeklySessions: 3 }, weightReadings: readings }));
  assert.equal(far.verdict, 'too_fast');
  assertWellFormed(near);
});

// ── wave 24w, P2-1: the easing step reads the food log ────────────────────────────────────────────────────────────────────────────

/**
 * A fat loss that gets within a kilo of the 84 kg target on Fri Oct 2 (the step is given that day) and is in the standing week of Mon Oct 5 on
 * TODAY (Tue Oct 6): a logger (older logs are at the 2,000 kcal budget) whose last 5 days are `lastDays` (Oct 2 .. Oct 6).
 */
function easingStepInput(lastDays: number[]): GoalProgressInput {
  const older = [-25, -24, -20, -19, -15, -12, -6, -5].map(o => ({ day: addDays(TODAY, o), kcal: 2000, proteinG: 100, source: 'logged' as const }));
  const since = lastDays.map((kcal, i) => ({ day: addDays(TODAY, -4 + i), kcal, proteinG: 100, source: 'logged' as const }));
  return base({
    target: { weightKg: 84, date: addDays(TODAY, 30), weeklySessions: 3 },
    start: { weightKg: 92, startedAt: `${addDays(TODAY, -79)}T08:00:00.000Z` },
    weightReadings: onDays(span(-59, 0), o => 91.31 - 0.12 * (o + 60)),
    intakeDays: [...older, ...since],
    budget: BUDGET_2000,
  });
}

test('P2-1 (24w): an eat-more step is graded "Reached ~2,150 kcal on N of M logged days since <start>" - never "stayed within", never on days before it began', () => {
  // Eating at the step since it began (Oct 2: 2,150, 2,300, 2,100, 2,000, 2,050): the step is claimed; 4 of the 5 days reached ~2,150 (2,000 did not).
  const taken = computeGoalProgress(easingStepInput([2150, 2300, 2100, 2000, 2050]));
  assert.equal(taken.weightRead?.plan?.step?.phase, 'standing');
  assert.equal(taken.weightRead?.plan?.step?.since, addDays(TODAY, -4));
  assert.equal(taken.reasons.find(r => r.kind === 'action')?.text, "Stay at ~2,150–2,200 kcal (the step you started Oct 2); we'll read it on Mon, Oct 19");
  assert.equal(taken.reasons.find(r => r.kind === 'calorie_adherence')?.text, 'Reached ~2,150 kcal on 4 of 5 logged days since Oct 2');
  assert.equal(taken.headline, 'Nearly there — stay at ~2,150–2,200 kcal');
  // Still eating the budget: the logs are named, the step is not claimed, and nothing says "keep to your easing step".
  const notTaken = computeGoalProgress(easingStepInput([2000, 2040, 1990, 2000, 2030]));
  assert.equal(notTaken.reasons.find(r => r.kind === 'action')?.text, "Your logs are still ~2,000 kcal, so the step is about one extra snack a day (to ~2,150–2,200 kcal); we'll read it on Mon, Oct 19");
  assert.equal(notTaken.reasons.find(r => r.kind === 'calorie_adherence')?.text, 'Reached ~2,150 kcal on 0 of 5 logged days since Oct 2');
  assert.doesNotMatch(notTaken.headline, /easing step/);
  assert.equal(notTaken.headline, 'Nearly there — stay at ~2,150–2,200 kcal');
  // The days before the step (Sep 30 - Oct 1, at the budget) are never in the count: with 2 logged days since it began there is no line at all.
  const input = easingStepInput([2150, 2150, 2150, 2150, 2150]);
  const fewDays = computeGoalProgress({ ...input, intakeDays: input.intakeDays.filter(d => d.day >= addDays(TODAY, -1) || d.day < addDays(TODAY, -6)) });
  assert.equal(fewDays.reasons.find(r => r.kind === 'calorie_adherence'), undefined);
});

test('B3. behind pace projects the date whenever the scale is falling, and says what the target date would take', () => {
  // 0.28 kg/wk (0.31%): the date is 90 days out with 5.3 kg to go (the 7-day average is 89.3 kg) — about 6 weeks out of reach.
  // (Wave 21w: more than 8 weeks past the date no projection is quoted — see the next test — so this date is 90 days out, not 60.)
  const readings = onDays(span(-70, 0), o => 92 - 0.04 * (o + 70));
  const input = youngGoal(80, { target: { weightKg: 84, date: addDays(TODAY, 90), weeklySessions: 3 }, weightReadings: readings, intakeDays: LOGGING_USER });
  const p = computeGoalProgress(input);
  assert.equal(p.verdict, 'behind');
  assert.match(p.headline, /^Behind pace — about 5\.3 kg to go, around \w{3} \d{1,2}, \d{4}$/);
  assert.doesNotMatch(p.headline, /too slow to project/);
  assert.ok(p.eta, 'the projected date is stated');
  assert.equal(p.onPaceForTargetDate, false);
  const action = p.reasons.find(r => r.kind === 'action')!;
  // The trim is the ONE step (TRIM_STEP_KCAL, 150 kcal) a plateau uses too.
  assert.match(action.text, /^To make Jan 4, 2027 you'd need ~0\.4\d kg\/wk — move the date or trim ~150 kcal a day \(to ~1,850 kcal\)$/);
  // No food log: activity and logging first, not a trim there is nothing to check against.
  const noLogs = computeGoalProgress({ ...input, intakeDays: [], intakeHistoryDays: undefined }).reasons.find(r => r.kind === 'action')!;
  assert.match(noLogs.text, /^To make Jan 4, 2027 you'd need ~0\.4\d kg\/wk — move the date, or add two 30-minute walks and log a few days so we can see where the calories go$/);
  assert.doesNotMatch(noLogs.text, /trim/);
  // Unknown parts are omitted: no budget, no "(to ~... kcal)".
  const noBudget = computeGoalProgress({ ...input, budget: null }).reasons.find(r => r.kind === 'action')!;
  assert.match(noBudget.text, /move the date or trim ~150 kcal a day$/);
  // The step never takes the budget under the low-energy floor: a smaller step, or none when the budget already sits on it.
  const nearFloor = computeGoalProgress({ ...input, budget: { ...BUDGET_2000, floorKcal: 1900 } }).reasons.find(r => r.kind === 'action')!;
  assert.match(nearFloor.text, /move the date or trim ~100 kcal a day \(to ~1,900 kcal\)$/);
  const atFloor = computeGoalProgress({ ...input, budget: { ...BUDGET_2000, floorKcal: 2000 } }).reasons.find(r => r.kind === 'action')!;
  assert.match(atFloor.text, /more than your calories can safely give; move the date$/);
  assert.doesNotMatch(atFloor.text, /trim/);
  // A date the safe band cannot reach says so rather than asking for it: a faster loss (0.7 kg/wk), 3 kg to go, 10 days left.
  const fast = onDays(span(-70, 0), o => 100 - 0.1 * (o + 70));
  const tight = computeGoalProgress(youngGoal(80, { target: { weightKg: 90, date: addDays(TODAY, 10), weeklySessions: 3 }, weightReadings: fast }));
  assert.equal(tight.verdict, 'behind');
  assert.match(tight.reasons.find(r => r.kind === 'action')!.text, /faster than is comfortable to keep; move the date$/);
  // Imperial: lb and the same copy.
  const lb = computeGoalProgressRaw({ ...input, unitSystem: 'imperial' }).reasons.find(r => r.kind === 'action')!;
  assert.match(lb.text, new RegExp(`~0\\.9\\d${NBSP}lb/wk`));
  assertWellFormed(p);
});

test('B3. far behind (a projection more than 8 weeks past the date) quotes no date or month: the date won\'t hold, move it or trim one step', () => {
  // The same 0.28 kg/wk with the date only 60 days out: the projection lands about 16 weeks past it.
  const readings = onDays(span(-70, 0), o => 92 - 0.04 * (o + 70));
  const input = youngGoal(80, { target: { weightKg: 84, date: addDays(TODAY, 60), weeklySessions: 3 }, weightReadings: readings, intakeDays: LOGGING_USER });
  const p = computeGoalProgress(input);
  assert.equal(p.verdict, 'behind');
  assert.equal(p.headline, "Behind pace — at this rate the Dec 5 date won't hold");
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, false);
  assert.equal(p.weightRead?.weeksVsTarget, null);
  assert.equal(p.weightRead?.plan?.farBehind, true);
  // The action never names the month the pace projects to (it is a guess off a noisy line), only that the date moves.
  assert.equal(p.reasons.find(r => r.kind === 'action')?.text, 'Move the date or trim ~150 kcal a day (to ~1,850 kcal)');
  assert.equal(p.weightRead?.plan?.action.kcalTarget, 1850);
  // A budget already on the floor cannot be trimmed: only the date moves.
  const onFloor = computeGoalProgress({ ...input, budget: { ...BUDGET_2000, floorKcal: 2000 } }).reasons.find(r => r.kind === 'action')!;
  assert.match(onFloor.text, /^Move the date — your calories are already near the 2,000 kcal floor$/);
  // No food log: activity and logging first.
  const noLogs = computeGoalProgress({ ...input, intakeDays: [], intakeHistoryDays: undefined }).reasons.find(r => r.kind === 'action')!;
  assert.equal(noLogs.text, 'Move the date, or add two 30-minute walks and log a few days so we can see where the calories go');
  // No calorie floor on the budget: 1,400 kcal (unknown sex) stands in.
  const noFloor = computeGoalProgress({ ...input, budget: { ...BUDGET_2000, targetKcal: 1500, floorKcal: 0 } }).reasons.find(r => r.kind === 'action')!;
  assert.match(noFloor.text, /trim ~100 kcal a day \(to ~1,400 kcal\)$/);
  assertWellFormed(p);
});

test('B3. "too slow to project a date" is only for a pace that is not falling', () => {
  const up = computeGoalProgress(youngGoal(80, {
    target: { weightKg: 84, date: addDays(TODAY, 60), weeklySessions: 3 },
    weightReadings: onDays(span(-30, 0), o => 90 + 0.03 * (o + 30)),
  }));
  assert.equal(up.verdict, 'behind');
  assert.doesNotMatch(up.headline, /too slow to project/);
  assert.match(up.headline, /away from your target/);
});

test('B5. a plateau with the logged days running over the target leads with the logs, not "often water"', () => {
  const flat = onDays(span(-49, 0), o => (o < -21 ? 92 - (o + 49) * 0.09 : 89.5 + (o % 2 === 0 ? 0.1 : -0.1)));
  // Wave 21w: the cause is judged over the plateau's own 21 days (here the week's Sunday and the 20 days before it), from 8+ logged days.
  const logged = (kcals: number[]) => kcals.map((kcal, i) => ({ day: addDays(TODAY, -2 - i), kcal, proteinG: 140, source: 'logged' as const }));
  const overKcal = [2210, 1762, 2436, 2219, 2150, 2300, 2050, 2180, 2260, 2100, 2240, 2090];
  const mean = Math.round(overKcal.reduce((a, b) => a + b, 0) / overKcal.length);
  const over = computeGoalProgress(youngGoal(50, { weightReadings: flat, intakeDays: logged(overKcal) }));
  assert.equal(over.weightRead?.state, 'plateau');
  assert.equal(
    over.reasons[0].text,
    `Logged days averaged ~${(Math.round(mean / 10) * 10).toLocaleString('en-US')} kcal vs your 2,000 kcal target — getting back to target is the first lever; if still flat 2 weeks after that, trim ~150 kcal a day`,
  );
  assert.doesNotMatch(over.reasons[0].text, /water/);
  assert.deepEqual(over.weightRead?.intake, { avgKcal: mean, targetKcal: 2000, loggedDays: 12, daysWithinTarget: 4, low: true });
  assert.equal(over.weightRead?.plan?.plateauCause?.kind, 'intake');
  // On target (within 150 kcal of it): the existing advice, word for word — the logs are not blamed.
  const fine = computeGoalProgress(youngGoal(50, { weightReadings: flat, intakeDays: logged([1950, 2010, 1880, 2050, 2000, 1990, 2060, 1940, 2020, 1970]) }));
  assert.equal(fine.reasons[0].text, 'Common and often water: keep 2,000 kcal and 3 sessions; if still flat in 2 weeks, trim ~150 kcal a day or add two 30-minute walks');
  assert.equal(fine.weightRead?.intake?.low, false);
  // Under 8 logged days there is nothing to lead with: a rolling week of logs no longer decides it.
  const thin = computeGoalProgress(youngGoal(50, { weightReadings: flat, intakeDays: logged([2400, 2500, 2450, 2350]) }));
  assert.match(thin.reasons[0].text, /^Common and often water/);
  assert.equal(thin.weightRead?.plan?.plateauCause?.kind, 'water');
});

test('B7. the date does not come and go: while the paces disagree it is the target date, and a call needs two weigh-ins to change', () => {
  // Fast at first, then slowing: the pace now and a week ago land on either side of the target date for a stretch.
  // (Wave 21w: the date is 70 days out. Closer, the slowing pace would put the projection more than 8 weeks past it and the
  // card would stop quoting a date at all — see the far-behind test.)
  const target = { weightKg: 80, date: addDays(TODAY, 70), weeklySessions: null };
  const run = (upTo: number) => {
    const today = addDays(TODAY, upTo);
    return computeGoalProgress(base({
      todayKey: today,
      target,
      start: { weightKg: 95, startedAt: `${addDays(TODAY, -70)}T08:00:00.000Z` },
      weightReadings: onDays(span(-60, upTo), o => (o < -20 ? 95 + (o + 60) * -0.12 : 95 - 40 * 0.12 + (o + 20) * -0.05)),
    }));
  };
  const days = span(-6, 0).map(run);
  for (const p of days) assert.ok(p.eta != null || p.verdict === 'insufficient_data', `a date every day: ${p.headline}`);
  // The verdict only changes when the call does; it never alternates day to day.
  let flips = 0;
  for (let i = 1; i < days.length; i++) if (days[i].verdict !== days[i - 1].verdict) flips++;
  assert.ok(flips <= 1, days.map(p => p.verdict).join(' '));
});

test('B8. reached: "within 1 kg of 84 kg", and a loss still past the ceiling says what to do', () => {
  // On the target with the scale still falling at about 1.2%/wk.
  const readings = onDays(span(-40, 0), o => 90 - 1.1 * ((o + 40) / 7));
  const p = computeGoalProgress(youngGoal(80, { target: { weightKg: 84, date: addDays(TODAY, 10), weeklySessions: 3 }, weightReadings: readings }));
  assert.equal(p.verdict, 'reached');
  const warn = p.reasons.find(r => r.kind === 'rate');
  assert.ok(warn, JSON.stringify(p.reasons));
  // Wave 24w (P3-1): the reach step ("switch to maintenance - keep the daily snack...") IS the instruction, so the rate warning does not add a second
  // one: it says the step covers it.
  assert.ok(p.weightRead?.plan?.step != null, 'the reach carries the maintenance step');
  assert.match(warn!.text, /above the 1% a week ceiling — your easing step covers this$/);
  assert.doesNotMatch(warn!.text, /ease calories/);
  assert.equal(warn!.tone, 'watch');
  // A budget that already is maintenance has no step, so the warning is the one instruction.
  const noStep = computeGoalProgress(youngGoal(80, {
    target: { weightKg: 84, date: addDays(TODAY, 10), weeklySessions: 3 },
    weightReadings: readings,
    budget: { ...BUDGET_2000, formulaTdee: 2000 },
  }));
  assert.equal(noStep.weightRead?.plan?.step, null);
  assert.match(noStep.reasons.find(r => r.kind === 'rate')!.text, /above the 1% a week ceiling — ease calories toward maintenance$/);
});
