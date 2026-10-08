import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeGoalProgress as computeGoalProgressRaw,
  HEADLINE_MAX_CHARS,
  isRunningWorkoutType,
  isStrengthWorkoutType,
  longRunTargetKm,
  type GoalProgress,
  type GoalProgressInput,
} from './goalProgress';
import { NBSP, plainSpaces } from './displayText';
import type { WeightReading } from './weightTrend';
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

  const behind = computeGoalProgress(base({ weightReadings: readings, target: { ...target, date: addDays(eta, -60) } }));
  assert.equal(behind.verdict, 'behind');
  assert.equal(behind.onPaceForTargetDate, false);
  assert.equal(behind.eta, eta);
  assertWellFormed(behind);
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

test('weight_loss flat trend for 2+ weeks → stalled, no ETA', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 78, date: addDays(TODAY, 90), weeklySessions: null },
    weightReadings: series(30, () => 85),
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

test('weight_loss already at/below target → ahead ("Target reached"), progress 100%', () => {
  const p = computeGoalProgress(base({
    target: { weightKg: 86, date: null, weeklySessions: null },
    start: { weightKg: 92, startedAt: '2026-08-01T00:00:00.000Z' },
    weightReadings: ramp(40, 88, -0.07),
  }));
  assert.equal(p.verdict, 'ahead');
  assert.match(p.headline, /^Target reached/);
  assert.equal(p.current.progressPct, 100);
  assert.equal(p.eta, null);
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
  const wk = (weekStart: string, e: number) => ({
    weekStart, bestEstimatedOneRepMaxKg: e, volumeKg: 1000, totalSets: 6, totalReps: 36,
  });
  return {
    'Bench Press': [wk('2026-09-07', prior), wk('2026-10-05', recent)],
    Squat: [wk('2026-09-07', 140), wk('2026-10-05', recent > prior ? 145 : 140)],
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
  assert.deepEqual(behind.adherence, { done: 9, planned: 16, weeklyTarget: 4, pct: 56 });
  assert.equal(behind.reasons.find(r => r.kind === 'adherence')!.text, '9 of 16 planned sessions in 4 weeks (56%)');
  // Not behind: the numbers are still reported (the client only uses them for a behind verdict).
  const fine = mk(15);
  assert.equal(fine.verdict, 'progressing');
  assert.deepEqual(fine.adherence, { done: 15, planned: 16, weeklyTarget: 4, pct: 94 });
  // JSON survives the wire.
  assert.deepEqual(JSON.parse(JSON.stringify(behind)).adherence, { done: 9, planned: 16, weeklyTarget: 4, pct: 56 });
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
  assert.match(rate!.text, /ceiling/);
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
  assert.deepEqual(kinds, ['week_sessions', 'volume', 'resting_hr']);
  const rhr = p.reasons.find(r => r.kind === 'resting_hr')!;
  assert.match(rhr.text, /trending down: 54 → 50 bpm/);
  assert.equal(rhr.tone, 'good');
  assert.equal(p.eta, null);
  assert.equal(p.safeBand, null);
  assertWellFormed(p);
});

test('endurance: leads with "N of T sessions this week" (Mon–today) and keeps the 4-week volume trend with its window', () => {
  // TODAY 2026-10-06 is a Tuesday: Monday 10-05 + Tuesday 10-06 = 2 sessions this week.
  const p = computeGoalProgress(enduranceInput([2, 3, 3, 3]));
  assert.equal(p.reasons[0].kind, 'week_sessions');
  assert.equal(p.reasons[0].text, '2 of 4 sessions this week');
  const volume = p.reasons.find(r => r.kind === 'volume');
  assert.ok(volume);
  assert.match(volume!.text, /last 2 weeks vs the 2 before/);
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
    'adherence', 'current', 'dataSufficiency', 'distance', 'eta', 'goal', 'headline', 'lastWeighInDaysAgo', 'longRun', 'onPaceForTargetDate',
    'race', 'ratePerWeek', 'reasons', 'safeBand', 'target', 'verdict',
  ]);
  assert.deepEqual(Object.keys(p.current).sort(), ['changeKg', 'progressPct', 'startWeightKg', 'weightKg']);
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

test('muscle: the headline lift is the biggest e1RM change, not the most-trained lift', () => {
  const p = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: null, date: null, weeklySessions: 3 }, trainingDays: fourteen,
    progression: {
      'bench press': [hl('2026-09-07', 99.2, 30), hl('2026-10-05', 107.9, 30)],
      squat: [hl('2026-09-07', 120, 6), hl('2026-10-05', 140.4, 6)],
    },
  }));
  assert.equal(p.verdict, 'progressing');
  assert.match(p.headline, /^Progressing — Squat est\. 1RM \+20 kg vs 4 weeks ago$/);
  assert.match(p.reasons.find(r => r.kind === 'lift')!.text, /^Squat est\. 1RM \+20 kg vs 4 weeks ago \(120 → 140 kg\)$/);
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
  assert.equal(low.headline, 'Lifts up, sessions behind — Squat +10 kg');
  assert.equal(mk(12).verdict, 'progressing'); // 75%
  // No weekly target: nothing to be behind on.
  const noTarget = computeGoalProgress(base({
    goal: 'muscle', target: { weightKg: 85, date: null, weeklySessions: null },
    progression: { squat: [hl('2026-09-07', 120, 6), hl('2026-10-05', 130, 6)] },
  }));
  assert.equal(noTarget.verdict, 'progressing');
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
  assert.equal(p.distance!.text, '8.5 of 30 km running this week');
  assert.equal(p.reasons[0].kind, 'week_distance');
  assert.equal(p.eta, null);
  assert.equal(p.onPaceForTargetDate, null);
  assertWellFormed(p);
});

test('endurance distance: 4-week average well under target and flat → behind', () => {
  const p = computeGoalProgress(distanceInput({ 1: 6, 4: 6, 8: 6, 11: 6, 15: 6, 18: 6, 22: 6, 25: 6 }));
  assert.equal(p.verdict, 'behind');
  assert.match(p.headline, /Behind — averaging 12 of 30 km a week \(4-week avg\)/);
  assertWellFormed(p);
});

test('endurance distance: average at/above target and steady → holding', () => {
  const p = computeGoalProgress(distanceInput({ 1: 15, 4: 15, 8: 15, 11: 15, 15: 15, 18: 15, 22: 15, 25: 15 }));
  assert.equal(p.verdict, 'holding');
  assert.match(p.headline, /Holding steady — averaging 30 of 30 km a week/);
});

test('endurance distance: last 2 weeks up on the 2 before → building, labelled with the window', () => {
  const p = computeGoalProgress(distanceInput({ 1: 12, 4: 10, 8: 10, 11: 10, 15: 5, 18: 5, 22: 4, 25: 4 }));
  assert.equal(p.verdict, 'building');
  assert.match(p.headline, /^Building — distance up \d+% \(last 2 weeks vs the 2 before\)$/);
  const volume = p.reasons.find(r => r.kind === 'volume');
  assert.match(volume!.text, /last 2 weeks vs the 2 before/);
  assert.match(volume!.text, /km a week/);
});

test('endurance distance text is unit-aware (miles) while structured km stay metric', () => {
  const p = computeGoalProgress(distanceInput({ 1: 8, 4: 8, 8: 8, 11: 8 }, { unitSystem: 'imperial' }));
  assert.equal(p.distance!.thisWeekKm, 8);
  assert.equal(p.distance!.targetKm, 30);
  assert.equal(p.distance!.text, '5 of 18.6 mi running this week');
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
    progression: { 'bench press': [wk('2026-09-07', 100), wk('2026-10-05', 100.5)] },
  }));
  assert.equal(small.verdict, 'stalled');
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
  assert.equal(p.distance!.text, '5 of 30 km running this week');
});

// ETA / pace
function lossInput(over: Partial<GoalProgressInput>): GoalProgressInput {
  return base({ target: { weightKg: 80, date: null, weeklySessions: null }, ...over });
}

test('on pace: ETA up to 7 days after the target date is on_track and onPace; later is behind', () => {
  const readings = ramp(40, 90, -0.1);
  const free = computeGoalProgress(lossInput({ weightReadings: readings }));
  assert.ok(free.eta);
  const eta = free.eta!;
  const at = (offset: number) => computeGoalProgress(lossInput({
    weightReadings: readings, target: { weightKg: 80, date: addDays(eta, -offset), weeklySessions: null },
  }));
  assert.equal(at(1).verdict, 'on_track');
  assert.equal(at(1).onPaceForTargetDate, true);
  assert.equal(at(7).verdict, 'on_track');
  assert.equal(at(8).verdict, 'behind');
  assert.equal(at(8).onPaceForTargetDate, false);
});

test('ETA is anchored to the last weigh-in, not today; lastWeighInDaysAgo is reported', () => {
  const full = ramp(40, 90, -0.1);
  const fresh = computeGoalProgress(lossInput({ weightReadings: full }));
  const stale = computeGoalProgress(lossInput({ weightReadings: full.slice(0, -5) }));
  assert.equal(fresh.lastWeighInDaysAgo, 0);
  assert.equal(stale.lastWeighInDaysAgo, 5);
  assert.ok(stale.eta && fresh.eta);
  // Skipped weigh-ins add no days: the same readings viewed 5 days earlier give the same date.
  const then = computeGoalProgress(lossInput({ todayKey: addDays(TODAY, -5), weightReadings: full.slice(0, -5) }));
  assert.equal(stale.eta, then.eta);
  assert.equal(computeGoalProgress(base()).lastWeighInDaysAgo, null);
});

test('stalled verdict never carries an ETA or on-pace flag', () => {
  const p = computeGoalProgress(lossInput({
    target: { weightKg: 78, date: addDays(TODAY, 90), weeklySessions: null },
    weightReadings: series(30, () => 85),
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

test('endurance race: a passed race is null; labels cover 5K / custom / no distance; verdict is unchanged', () => {
  const without = computeGoalProgress(enduranceInput([4, 3, 2, 2]));
  const passed = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, -1), distanceKm: 21.1 } }));
  assert.equal(passed.race, null);
  assert.deepEqual(passed.reasons, without.reasons);
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

// ── Endurance long run / race readiness ─────────────────────────────────────

/** One long run per week at days-ago 3 / 10 / 17 / 24 (newest first) plus a 5 km easy run 2 days before each. */
function longRunInput(longKm: number[], over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  const kmByDaysAgo: Record<number, number> = {};
  longKm.forEach((km, i) => {
    kmByDaysAgo[3 + i * 7] = km;
    kmByDaysAgo[1 + i * 7] = 5;
  });
  return distanceInput(kmByDaysAgo, over);
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
  assert.deepEqual(p.longRun, { lastKm: 14, peakKm: 16, targetPeakKm: 18 });
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
  assert.deepEqual(old.longRun, { lastKm: 9, peakKm: 9, targetPeakKm: null });
  const none = computeGoalProgress(enduranceInput([3, 3, 3, 3]));
  assert.equal(none.longRun, null);
  assert.equal(computeGoalProgress(base({ goal: 'muscle' })).longRun, null);
});

test('long run: below target reads "Long run 14 km · build to 18 km by mid-Dec", right after the weekly distance', () => {
  // Race Dec 30 → peak planned 3 weeks out (Dec 9) → "mid-Dec".
  const p = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: '2026-12-30', distanceKm: 21.1 } }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'week_distance', 'long_run']);
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
  assert.deepEqual(noRace.longRun, { lastKm: 14, peakKm: 16, targetPeakKm: null });
  const noDistance = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 56), distanceKm: null } }));
  assert.equal(noDistance.reasons.some(r => r.kind === 'long_run'), false);
  assert.equal(noDistance.longRun?.targetPeakKm, null);
  const passed = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, -2), distanceKm: 21.1 } }));
  assert.equal(passed.reasons.some(r => r.kind === 'long_run'), false);
  assert.equal(passed.longRun?.targetPeakKm, null);
});

test('long run: inside the last 3 weeks the build deadline is gone ("peak target"); marathon target is 32', () => {
  const p = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 14), distanceKm: 21.1 } }));
  assert.equal(p.reasons.find(r => r.kind === 'long_run')?.text, 'Long run 14 km · peak target 18 km');
  const m = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 120), distanceKm: 42.2 } }));
  assert.equal(m.longRun?.targetPeakKm, 32);
  assert.match(m.reasons.find(r => r.kind === 'long_run')!.text, /^Long run 14 km · build to 32 km by (early|mid-|late )/);
});

test('long run: text is unit-aware (miles) while structured km stay metric', () => {
  const p = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: addDays(TODAY, 84), distanceKm: 21.1 }, unitSystem: 'imperial' }));
  assert.equal(p.longRun?.lastKm, 14);
  assert.equal(p.longRun?.targetPeakKm, 18);
  assert.ok(p.reasons.find(r => r.kind === 'long_run')!.text.startsWith('Long run 8.7 mi · build to 11.2 mi by'));
});

test('long run: also shown while the verdict is insufficient_data (race still leads, cap 3)', () => {
  const p = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 84), distanceKm: 21.1 } }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.deepEqual(p.reasons.map(r => r.kind).slice(0, 2), ['race', 'week_distance']);
  assert.ok(p.reasons.some(r => r.kind === 'long_run'));
  assert.ok(p.reasons.length <= 3);
});

// ── non-breaking spaces: a value never wraps mid-token (asserts the RAW copy) ──

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
