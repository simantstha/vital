import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeGoalProgress as computeGoalProgressRaw,
  HEADLINE_MAX_CHARS,
  isRunningWorkoutType,
  isStrengthWorkoutType,
  longRunTargetKm,
  raceLabel,
  type GoalProgress,
  type GoalProgressInput,
} from './goalProgress';
import { NBSP, plainSpaces } from './displayText';
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
    'adherence', 'current', 'dataSufficiency', 'distance', 'eta', 'goal', 'headline', 'lastSessionDaysAgo', 'lastWeighInDaysAgo', 'longRun',
    'onPaceForTargetDate', 'race', 'ratePerWeek', 'reachedAt', 'reasons', 'safeBand', 'target', 'verdict',
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
  // Last week (Sep 28 - Oct 4) held one 10 km run: this week's safe step is ~11 km, the goal stays 30 km.
  assert.equal(p.distance!.stepTargetKm, 11);
  assert.equal(p.distance!.text, '8.5 of ~11 km running this week · goal 30 km');
  // The stat states it; the "Why" does not repeat it.
  assert.equal(p.reasons.some(r => r.kind === 'week_distance'), false);
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
  // Last week 16 km = 9.9 mi -> a step of 11 whole miles (17.7 km); the goal 30 km = 18.6 mi.
  assert.equal(p.distance!.stepTargetKm, 17.7);
  assert.equal(p.distance!.text, '5 of ~11 mi running this week · goal 18.6 mi');
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

test('endurance distance step: no last-week running -> the goal; a near-zero last week has no base to grow from', () => {
  // Runs only this week (and 20 days ago): last week is empty.
  const none = computeGoalProgress(distanceInput({ 0: 8, 20: 12 }));
  assert.equal(none.distance!.stepTargetKm, 30);
  assert.equal(none.distance!.text, '8 of 30 km running this week');
  // No distance data at all.
  const noData = computeGoalProgress(enduranceInput([3, 3, 3, 3], {
    target: { weightKg: null, date: null, weeklySessions: 3, weeklyDistanceKm: 30 },
  }));
  assert.equal(noData.distance!.stepTargetKm, 30);
  assert.equal(noData.distance!.text, '0 of 30 km running this week');
  // 0.6 km last week: nothing to take 10% of.
  const tiny = computeGoalProgress(distanceInput({ 0: 5, 4: 0.6 }));
  assert.equal(tiny.distance!.stepTargetKm, 30);
  assert.equal(tiny.distance!.text, '5 of 30 km running this week');
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

test('endurance race: a race passed more than 14 days ago is null; labels cover 5K / custom / no distance; verdict is unchanged', () => {
  const without = computeGoalProgress(enduranceInput([4, 3, 2, 2]));
  const passed = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, -15), distanceKm: 21.1 } }));
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

/** Weekly goal 50 km, peak week before the taper 40 km; last week held one 10 km run (the growth step would be 11 km). */
function phaseInput(daysOut: number, over: Partial<GoalProgressInput> = {}): GoalProgressInput {
  return distanceInput({ 0: 3.5, 1: 5, 3: 10, 9: 12, 16: 9, 23: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, daysOut), distanceKm: 21.1 },
    racePeakWeekKm: 40,
    ...over,
  });
}

const reasonOf = (p: GoalProgress, kind: string): string | undefined => p.reasons.find(r => r.kind === kind)?.text;

test('race phase: build keeps the growth step and adds the phase to the payload only', () => {
  const p = computeGoalProgress(phaseInput(84));
  assert.equal(p.race?.phase, 'build');
  assert.equal(p.race?.daysSince, undefined);
  assert.equal(p.distance!.stepTargetKm, 11); // ~10% over last week's 10 km, not a phase target
  assert.equal(reasonOf(p, 'race_phase'), undefined);
  assert.equal(computeGoalProgress(phaseInput(22)).race?.phase, 'build');
});

test('race phase: taper uses x0.75 of the peak week 14-21 days out and x0.6 8-13 days out, not the growth step', () => {
  const early = computeGoalProgress(phaseInput(18));
  assert.equal(early.race?.phase, 'taper');
  assert.equal(early.distance!.stepTargetKm, 30); // round(40 x 0.75)
  assert.equal(early.distance!.text, '8.5 of ~30 km running this week · goal 50 km');
  assert.equal(reasonOf(early, 'race_phase'), 'Taper: ~30 km this week — keep a little intensity, cut volume');
  const late = computeGoalProgress(phaseInput(10));
  assert.equal(late.race?.phase, 'taper');
  assert.equal(late.distance!.stepTargetKm, 24); // round(40 x 0.6)
  assert.equal(reasonOf(late, 'race_phase'), 'Taper: ~24 km this week — keep a little intensity, cut volume');
  assert.equal(computeGoalProgress(phaseInput(14)).distance!.stepTargetKm, 30);
  assert.equal(computeGoalProgress(phaseInput(13)).distance!.stepTargetKm, 24);
  assert.equal(computeGoalProgress(phaseInput(21)).distance!.stepTargetKm, 30);
  assert.equal(computeGoalProgress(phaseInput(8)).distance!.stepTargetKm, 24);
});

test('race phase: the phase reason sits right behind the race line', () => {
  const taper = computeGoalProgress(phaseInput(10));
  assert.deepEqual(taper.reasons.map(r => r.kind).slice(0, 2), ['race', 'race_phase']);
  assert.equal(taper.reasons.length, 3);
  assertWellFormed(taper);
});

test('race phase: race week targets x0.4 of the peak week (race excluded) and says to keep runs short and easy', () => {
  const p = computeGoalProgress(phaseInput(5));
  assert.equal(p.race?.phase, 'race_week');
  assert.equal(p.race?.weeksToGo, 0);
  assert.equal(p.distance!.stepTargetKm, 16); // round(40 x 0.4)
  assert.equal(reasonOf(p, 'race_phase'), `Race week — short easy runs, rest 1–2 days before ${'Oct 11'}`);
  // 7 days out is race week too (the boundary), with a week's countdown.
  const seven = computeGoalProgress(phaseInput(7));
  assert.equal(seven.race?.phase, 'race_week');
  assert.equal(seven.race?.weeksToGo, 1);
  assert.equal(seven.distance!.stepTargetKm, 16);
});

test('race phase: race day is race week; the race run itself is not counted against the week', () => {
  // TODAY is Tuesday; Monday's 5 km is this week's real running, today's 21.1 km is the race.
  const p = computeGoalProgress(distanceInput({ 0: 21.1, 1: 5, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: TODAY, distanceKm: 21.1 },
    racePeakWeekKm: 40,
  }));
  assert.equal(p.race?.phase, 'race_week');
  assert.equal(p.race?.daysToGo, 0);
  assert.equal(p.distance!.thisWeekKm, 5);
  assert.equal(p.distance!.stepTargetKm, 16);
  assert.match(reasonOf(p, 'race_phase')!, /^Race day — /);
});

test('race phase: after the race the race stays for 14 days as "recovery" with daysSince and a next step', () => {
  const p = computeGoalProgress(phaseInput(-3));
  assert.ok(p.race);
  assert.equal(p.race.phase, 'recovery');
  assert.equal(p.race.daysSince, 3);
  assert.equal(p.race.daysToGo, 0);
  assert.equal(p.race.weeksToGo, 0);
  assert.equal(p.race.label, 'Half marathon');
  assert.equal(p.headline, 'Race done — Oct 3 · recovery week 1');
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'race_phase', 'next_step']);
  assert.equal(p.reasons[0].text, 'Half marathon done (Oct 3)');
  assert.equal(p.reasons[1].text, 'Recovery: easy only this week (~16 km max)');
  assert.deepEqual(p.reasons[2], {
    kind: 'next_step',
    text: 'Set your next goal: a new race, a weekly distance target, or maintenance',
    tone: 'neutral',
  });
  assert.equal(p.distance!.stepTargetKm, 16); // week 1: x0.4 of the 40 km peak
  assertWellFormed(p);
});

test('race phase: recovery week 1 is days 1-7 after the race, week 2 days 8-14 (x0.6), then the race is gone', () => {
  assert.equal(computeGoalProgress(phaseInput(-1)).headline, 'Race done — Oct 5 · recovery week 1');
  assert.equal(computeGoalProgress(phaseInput(-7)).headline, 'Race done — Sep 29 · recovery week 1');
  const wk2 = computeGoalProgress(phaseInput(-8));
  assert.equal(wk2.headline, 'Race done — Sep 28 · recovery week 2');
  assert.equal(wk2.distance!.stepTargetKm, 24);
  assert.equal(reasonOf(wk2, 'race_phase'), 'Recovery: easy only this week (~24 km max)');
  const last = computeGoalProgress(phaseInput(-14));
  assert.equal(last.race?.phase, 'recovery');
  assert.equal(last.race?.daysSince, 14);
  const gone = computeGoalProgress(phaseInput(-15));
  assert.equal(gone.race, null);
  assert.equal(gone.reasons.some(r => r.kind === 'next_step' || r.kind === 'race_phase'), false);
  // Back on the growth step once the recovery is over (last week's 10 km -> ~11 km).
  assert.equal(gone.distance!.stepTargetKm, 11);
});

test('race phase: recovery counts only the running after race day', () => {
  // Race was Monday (TODAY - 1): Monday's race run is excluded, today's easy 4 km is the recovery week so far.
  const p = computeGoalProgress(distanceInput({ 0: 4, 1: 21.1, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, -1), distanceKm: 21.1 },
    racePeakWeekKm: 40,
  }));
  assert.equal(p.race?.phase, 'recovery');
  assert.equal(p.distance!.thisWeekKm, 4);
  assert.equal(p.distance!.text, '4 of up to 16 km running this week (recovery)');
});

// ── Race lifecycle: the verdict is phase-aware (a planned drop is never "behind") ──

/**
 * A runner whose 4-week average is falling hard (28 km before, 8.5 km this week so far) against a 50 km goal:
 * without a race the verdict reads 'behind'. `daysOut` null = no race.
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

test('phase verdict: taper with a falling 4-week average is never "behind" — on_track within the band', () => {
  assert.equal(noRaceVerdict(), 'behind'); // the setup really is a falling 4-week average
  for (const daysOut of [21, 18, 14, 13, 10, 8]) {
    const p = computeGoalProgress(fallingInput(daysOut));
    assert.equal(p.race?.phase, 'taper');
    assert.equal(p.verdict, 'on_track', `${daysOut} days out`);
    assert.notEqual(p.verdict, 'stalled');
    // The headline matches the verdict (no leftover "Behind — averaging …").
    assert.match(p.headline, /^Taper week — 8\.5 of ~(30|24) km$/, p.headline);
    assert.equal(p.reasons.find(r => r.kind === 'race_phase')?.tone, 'neutral');
  }
});

test('phase verdict: a taper undershoot reads "building"; early in the week it is pro-rated, so Monday never undershoots', () => {
  // Sunday Oct 11: 6 of 7 days are done, so 8.5 km of a ~30 km taper (60% = 18 km) is under.
  const sunday = computeGoalProgress(phaseInput(18, { todayKey: '2026-10-11', race: { date: '2026-10-29', distanceKm: 21.1 } }));
  assert.equal(sunday.race?.phase, 'taper');
  assert.equal(sunday.distance!.thisWeekKm, 8.5);
  assert.equal(sunday.verdict, 'building');
  assert.equal(sunday.headline, 'Taper week — 8.5 of ~30 km');
  // Monday: nothing is due yet, so the same 8.5 km (on and after Oct 12 would be 0) is not an undershoot.
  const monday = computeGoalProgress(phaseInput(18, { todayKey: '2026-10-12', race: { date: '2026-10-30', distanceKm: 21.1 } }));
  assert.equal(monday.verdict, 'on_track');
});

test('phase verdict: running well over the plan stays on_track but the phase line goes on watch', () => {
  // Taper 18 days out: ~30 km target; 38 km is over 125% and 8 km over.
  const taper = computeGoalProgress(distanceInput({ 0: 18, 1: 20, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, 18), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(taper.verdict, 'on_track');
  assert.equal(taper.headline, 'Taper week — 38 of ~30 km, over the plan');
  const reason = taper.reasons.find(r => r.kind === 'race_phase')!;
  assert.equal(reason.tone, 'watch');
  assert.equal(reason.text, 'Taper: ~30 km this week — keep a little intensity, cut volume; already 38 km — ease off');
  // 36 km is within 125%: no flag.
  const within = computeGoalProgress(distanceInput({ 0: 18, 1: 18, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, 18), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(within.reasons.find(r => r.kind === 'race_phase')?.tone, 'neutral');
});

test('phase verdict: race week is on_track under its ceiling and flags running over it', () => {
  const ok = computeGoalProgress(phaseInput(5));
  assert.equal(ok.verdict, 'on_track');
  assert.equal(ok.headline, 'Race week — 8.5 of ~16 km before the race');
  // 20 km against a 16 km ceiling (+10% = 17.6): over.
  const over = computeGoalProgress(distanceInput({ 0: 10, 1: 10, 3: 5 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, 5), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(over.verdict, 'on_track');
  assert.equal(over.headline, 'Race week — 20 of ~16 km before the race, over the plan');
  assert.equal(over.reasons.find(r => r.kind === 'race_phase')?.tone, 'watch');
  assert.match(over.reasons.find(r => r.kind === 'race_phase')!.text, /^Race week — short easy runs, rest 1–2 days before Oct 11; already 20 km — ease off$/);
  // Race day: the race itself does not count, and nobody is told to "ease off" on race day.
  const raceDay = computeGoalProgress(distanceInput({ 0: 21.1, 1: 5, 3: 10 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: TODAY, distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(raceDay.verdict, 'on_track');
  assert.doesNotMatch(raceDay.reasons.map(r => r.text).join(' | '), /ease off/);
});

test('phase verdict: a recovery week is on_track (never "behind"), the race-done headline stays; overshooting flags the line', () => {
  assert.equal(noRaceVerdict(), 'behind');
  for (const daysSince of [1, 3, 7, 8, 14]) {
    const p = computeGoalProgress(fallingInput(-daysSince));
    assert.equal(p.race?.phase, 'recovery');
    assert.equal(p.verdict, 'on_track', `${daysSince} days after`);
    assert.match(p.headline, /^Race done — \w{3} \d+ · recovery week [12]$/);
    assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'race_phase', 'next_step']);
  }
  const over = computeGoalProgress(distanceInput({ 0: 10, 1: 10, 3: 5 }, {
    target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 50 },
    race: { date: addDays(TODAY, -3), distanceKm: 21.1 }, racePeakWeekKm: 40,
  }));
  assert.equal(over.verdict, 'on_track');
  assert.equal(over.headline, 'Race done — Oct 3 · recovery week 1');
  assert.deepEqual(over.reasons.map(r => r.kind), ['race', 'race_phase', 'next_step']);
  assert.equal(over.reasons[1].tone, 'watch');
  assert.equal(over.reasons[1].text, 'Recovery: easy only this week (~16 km max); already 20 km — ease off');
});

test('phase verdict: build phase, no-distance goals and thin data keep their verdict; no new verdict values', () => {
  // Build (22 / 84 days out): exactly the no-race verdict.
  for (const daysOut of [22, 84]) assert.equal(computeGoalProgress(fallingInput(daysOut)).verdict, noRaceVerdict(), `${daysOut}`);
  // A race 15 days after is over: back to the plain verdict.
  assert.equal(computeGoalProgress(fallingInput(-15)).verdict, noRaceVerdict());
  // Too few sessions stays insufficient_data in a taper.
  const thin = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 10), distanceKm: 21.1 } }));
  assert.equal(thin.verdict, 'insufficient_data');
  // No weekly distance goal: nothing to measure against, the sessions-based verdict is untouched.
  const sessionsOnly = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 10), distanceKm: 21.1 } }));
  const sessionsOnlyNoRace = computeGoalProgress(enduranceInput([4, 3, 2, 2]));
  assert.equal(sessionsOnly.verdict, sessionsOnlyNoRace.verdict);
  assert.equal(sessionsOnly.headline, sessionsOnlyNoRace.headline);
});

test('race phase: long run reason says "peak target" in taper / race week and nothing in recovery', () => {
  const taper = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 19), distanceKm: 21.1 } }));
  assert.equal(taper.race?.phase, 'taper');
  assert.equal(reasonOf(taper, 'long_run'), 'Long run 14 km · peak target 18 km');
  assert.equal(taper.reasons.some(r => /build to/i.test(r.text)), false);
  const raceWeek = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 4), distanceKm: 21.1 } }));
  assert.equal(reasonOf(raceWeek, 'long_run'), 'Long run 14 km · peak target 18 km');
  const recovery = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, -2), distanceKm: 21.1 } }));
  assert.equal(recovery.reasons.some(r => r.kind === 'long_run'), false);
  assert.equal(recovery.longRun?.targetPeakKm, null);
  // Build still builds.
  const build = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 84), distanceKm: 21.1 } }));
  assert.match(reasonOf(build, 'long_run')!, /build to 18 km by/);
});

test('race phase: without a measured peak week the weekly goal stands in, still capped at the goal', () => {
  const p = computeGoalProgress(phaseInput(18, { racePeakWeekKm: null, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 } }));
  assert.equal(p.distance!.stepTargetKm, 23); // round(30 x 0.75)
  // A peak far above the goal never asks for more than the goal.
  const over = computeGoalProgress(phaseInput(18, { racePeakWeekKm: 60, target: { weightKg: null, date: null, weeklySessions: null, weeklyDistanceKm: 30 } }));
  assert.equal(over.distance!.stepTargetKm, 30);
  assert.equal(over.distance!.text, '8.5 of 30 km running this week');
});

test('race phase: imperial targets are whole miles in the copy, km in the structured fields', () => {
  const p = computeGoalProgress(phaseInput(18, { unitSystem: 'imperial' }));
  assert.equal(p.race?.phase, 'taper');
  // 40 km = 24.85 mi; x0.75 = 18.64 -> 19 mi.
  assert.match(reasonOf(p, 'race_phase')!, /^Taper: ~19 mi this week/);
  assert.ok(Math.abs(p.distance!.stepTargetKm / 1.609344 - 19) < 0.05, `${p.distance!.stepTargetKm}`);
});

test('race phase: a race with no distance goal and no running history has phase copy without a number', () => {
  const p = computeGoalProgress(enduranceInput([4, 3, 2, 2], { race: { date: addDays(TODAY, 10), distanceKm: 21.1 } }));
  assert.equal(p.distance, null);
  assert.equal(p.race?.phase, 'taper');
  assert.equal(reasonOf(p, 'race_phase'), 'Taper: cut volume this week — keep a little intensity');
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

test('long run: below target reads "Long run 14 km · build to 18 km by mid-Dec", right after the volume trend', () => {
  // Race Dec 30 → peak planned 3 weeks out (Dec 9) → "mid-Dec".
  const p = computeGoalProgress(longRunInput([14, 12, 16, 10], { race: { date: '2026-12-30', distanceKm: 21.1 } }));
  // Race first, the verdict's volume trend always kept, then the long run (this week's distance is the card's stat, not a reason).
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'volume', 'long_run']);
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
  // Three weeks out is the taper's first day: even there it is "peak target", never "build to".
  // (Two sessions -> insufficient_data, so the long run is not crowded out of the cap-3 Why by the volume trend.)
  const p = computeGoalProgress(distanceInput({ 3: 14, 10: 12 }, { race: { date: addDays(TODAY, 21), distanceKm: 21.1 } }));
  assert.equal(p.race?.phase, 'taper');
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
  assert.deepEqual(p.reasons.map(r => r.kind).slice(0, 2), ['race', 'long_run']);
  assert.equal(p.reasons.some(r => r.kind === 'week_distance'), false);
  assert.ok(p.reasons.length <= 3);
});

// ── Endurance "Why" selection: race, then the verdict's volume trend, then long run / watch ──

/** A building distance runner (recent 2 weeks up ~125% on the 2 before) 12 weeks from a half marathon. */
const BUILDING_KM = { 1: 12, 4: 10, 8: 10, 11: 10, 15: 5, 18: 5, 22: 4, 25: 4 };
const HALF_IN_12_WEEKS = { race: { date: addDays(TODAY, 84), distanceKm: 21.1 } };
/** Daily series that is `recent` for the last 14 days and `prior` before that. */
const twoHalves = (recent: number, prior: number) =>
  Array.from({ length: 28 }, (_, i) => ({ day: addDays(TODAY, -i), value: i < 14 ? recent : prior }));

test('endurance Why: race, then the volume trend behind the verdict, then the long run — never this week\'s distance', () => {
  const p = computeGoalProgress(distanceInput(BUILDING_KM, HALF_IN_12_WEEKS));
  assert.equal(p.verdict, 'building');
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'volume', 'long_run']);
  // The kept volume reason is the one the headline rests on.
  assert.match(p.reasons[1].text, /^Weekly training distance up \d+% \(/);
  assert.match(p.reasons[1].text, /last 2 weeks vs the 2 before/);
  assert.match(p.reasons[2].text, /^Long run 12 km · build to 18 km by /);
  // This week's distance lives in the stat, not in the reasons.
  assert.equal(p.reasons.some(r => r.kind === 'week_distance'), false);
  assert.match(p.distance!.text, /of ~22 km running this week · goal 30 km$/);
  assertWellFormed(p);
});

test('endurance Why: a watch-tone recovery reason outranks the long run and is never cut', () => {
  // Resting HR up 6 bpm over the last 2 weeks (watch); HRV flat.
  const p = computeGoalProgress(distanceInput(BUILDING_KM, { ...HALF_IN_12_WEEKS, restingHr: twoHalves(58, 52), hrv: twoHalves(60, 60) }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'volume', 'resting_hr']);
  const rhr = p.reasons[2];
  assert.equal(rhr.tone, 'watch');
  assert.match(rhr.text, /^Resting heart rate trending up: 52 → 58 bpm/);
  assert.equal(p.reasons.some(r => r.kind === 'long_run'), false);
  // A falling HRV is a watch too.
  const hrv = computeGoalProgress(distanceInput(BUILDING_KM, { ...HALF_IN_12_WEEKS, hrv: twoHalves(50, 70) }));
  assert.deepEqual(hrv.reasons.map(r => r.kind), ['race', 'volume', 'hrv']);
  assert.equal(hrv.reasons[2].tone, 'watch');
});

test('endurance Why: a good recovery trend does not displace the long run', () => {
  const p = computeGoalProgress(distanceInput(BUILDING_KM, { ...HALF_IN_12_WEEKS, restingHr: twoHalves(50, 54) }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['race', 'volume', 'long_run']);
});

test('endurance Why without a race: volume first, then every watch-tone reason ahead of the rest (cap 3)', () => {
  const p = computeGoalProgress(distanceInput(BUILDING_KM, { restingHr: twoHalves(58, 52), hrv: twoHalves(50, 70) }));
  assert.deepEqual(p.reasons.map(r => r.kind), ['volume', 'resting_hr', 'hrv']);
  assert.deepEqual(p.reasons.map(r => r.tone), ['good', 'watch', 'watch']);
  // No watch: the remaining slots go to the usual order (sessions before resting HR / HRV).
  const calm = computeGoalProgress(distanceInput(BUILDING_KM, { restingHr: twoHalves(52, 52), hrv: twoHalves(60, 60) }));
  assert.deepEqual(calm.reasons.map(r => r.kind), ['volume', 'sessions', 'resting_hr']);
});

test('endurance Why: a falling volume trend (watch) is still the first reason', () => {
  const p = computeGoalProgress(distanceInput({ 1: 4, 4: 4, 8: 4, 11: 4, 15: 10, 18: 10, 22: 10, 25: 10 }, { ...HALF_IN_12_WEEKS, restingHr: twoHalves(58, 52) }));
  assert.equal(p.reasons[0].kind, 'race');
  assert.equal(p.reasons[1].kind, 'volume');
  assert.equal(p.reasons[1].tone, 'watch');
  assert.equal(p.reasons.length, 3);
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

test('reached (weight loss): headline names the target and the day the trend crossed it; reachedAt is that day', () => {
  const readings = ramp(40, 88, -0.07);
  const p = computeGoalProgress(reachedLossInput());
  const crossing = computeWeightTrend(readings).days.find(d => 86 - d.trendKg > -0.1);
  assert.ok(crossing, 'fixture crosses the target');
  assert.equal(p.verdict, 'reached');
  assert.equal(p.reachedAt, crossing!.day);
  assert.match(p.headline, /^Goal reached — 86 kg \(\w{3} \d{1,2}\)$/);
  assert.equal(p.current.progressPct, 100);
  assert.equal(p.eta, null);
  assertWellFormed(p);
});

test('reached (weight loss): reasons lead with the reach, drop the green safe-band rate, end with the next step', () => {
  const p = computeGoalProgress(reachedLossInput());
  assert.deepEqual(p.reasons.map(r => r.kind), ['reached', 'position', 'next_step']);
  assert.equal(p.reasons[0].tone, 'good');
  assert.match(p.reasons[0].text, /first reached \w{3} \d{1,2}/);
  assert.deepEqual(p.reasons[2], { kind: 'next_step', text: 'Set a new target or switch to maintenance', tone: 'neutral' });
  // Continued loss is not "inside the safe band" any more.
  assert.ok(!p.reasons.some(r => r.kind === 'rate' || /safe band/.test(r.text)));
  // Trend ~85.3 kg vs 86 kg: within 1 kg.
  assert.deepEqual(p.reasons[1], { kind: 'position', text: 'Holding near target', tone: 'neutral' });
  assertWellFormed(p);
});

test('reached (weight loss): well past the target reads "Below target by X kg"; imperial reads lb', () => {
  const p = computeGoalProgress(reachedLossInput({ target: { weightKg: 90, date: null, weeklySessions: null } }));
  assert.equal(p.verdict, 'reached');
  const pos = p.reasons.find(r => r.kind === 'position')!;
  assert.match(pos.text, /^Below target by \d+\.\d kg$/);
  assert.equal(pos.tone, 'neutral');
  const lb = computeGoalProgress(reachedLossInput({ target: { weightKg: 90, date: null, weeklySessions: null }, unitSystem: 'imperial' }));
  assert.match(lb.headline, /^Goal reached — 198\.4 lb/);
  assert.match(lb.reasons.find(r => r.kind === 'position')!.text, /^Below target by \d+\.\d lb$/);
});

test('reached (weight loss): a target date still reads on pace; under-eating keeps its watch slot ahead of the position', () => {
  const dated = computeGoalProgress(reachedLossInput({ target: { weightKg: 86, date: addDays(TODAY, 30), weeklySessions: null } }));
  assert.equal(dated.verdict, 'reached');
  assert.equal(dated.onPaceForTargetDate, true);
  const intakeDays = Array.from({ length: 7 }, (_, i) => ({ day: addDays(TODAY, -i), kcal: 900, proteinG: 60, source: 'logged' as const }));
  const eating = computeGoalProgress(reachedLossInput({
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
  assert.match(aging.headline, /^[A-Za-z ]+ — about [\d.]+ kg to go$/);
  assert.deepEqual(aging.reasons.map(r => r.kind).slice(0, 2), ['rate', 'weigh_in_age']);
  assert.equal(aging.reasons[1].text, 'Based on a weigh-in 9 days ago');
  // 6 days old is still fresh.
  const recent = computeGoalProgress(lossInput({ weightReadings: shiftReadings(readings, 6) }));
  assert.ok(recent.eta);
  assert.ok(!recent.reasons.some(r => r.kind === 'weigh_in_age'));
  assertWellFormed(aging);
});

test('an ETA already in the past is never pushed forward to today to beat the target date', () => {
  const readings = shiftReadings(ramp(40, 95, -0.07), 5);
  const days = computeWeightTrend(readings).days;
  const lastDay = days[days.length - 1].day;
  const current = days[days.length - 1].trendKg;
  // ~0.2 kg to go at ~0.5 kg/wk: about 3 days after the weigh-in, i.e. 2 days before today.
  const p = computeGoalProgress(lossInput({
    target: { weightKg: Math.round((current - 0.2) * 100) / 100, date: addDays(TODAY, 90), weeklySessions: null },
    weightReadings: readings,
  }));
  assert.equal(p.lastWeighInDaysAgo, 5);
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
  assert.equal(young.reasons.find(r => r.kind === 'adherence')!.text, '6 of 6 planned sessions in 10 days (100%)');
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

test('weight rate says the real span when under 4 weeks of weigh-ins', () => {
  const short = computeGoalProgress(base({ target: { weightKg: 80, date: null, weeklySessions: null }, weightReadings: ramp(10, 90, -0.1) }));
  assert.match(short.reasons.find(r => r.kind === 'rate')!.text, /\) over 9 days/);
  const long = computeGoalProgress(base({ target: { weightKg: 80, date: null, weeklySessions: null }, weightReadings: ramp(60, 95, -0.07) }));
  assert.match(long.reasons.find(r => r.kind === 'rate')!.text, /\) over 4 weeks/);
});

test('lifter with no baseline yet: "First lift comparison on <first set + 28 days>" instead of "Log a few more lifts"', () => {
  // First sets in the week of Mon Oct 5, on Oct 5 and today (Oct 6): comparison lands Nov 2.
  const p = computeGoalProgress(base({
    goal: 'muscle',
    target: { weightKg: null, date: null, weeklySessions: 3 },
    progression: { squat: [wk('2026-10-05', 100)] },
    trainingDays: [addDays(TODAY, -1), TODAY],
  }));
  assert.equal(p.verdict, 'insufficient_data');
  assert.equal(p.headline, 'First lift comparison on Nov 2');
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
