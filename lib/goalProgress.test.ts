import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeGoalProgress,
  HEADLINE_MAX_CHARS,
  type GoalProgress,
  type GoalProgressInput,
} from './goalProgress';
import type { WeightReading } from './weightTrend';
import type { ProgressionSummary } from './workoutRepository';

const TODAY = '2026-10-06';

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
  assert.equal(p.onPaceForTargetDate, false);
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
    'Bench Press': [wk('2026-09-07', prior), wk('2026-09-28', recent)],
    Squat: [wk('2026-09-07', 140), wk('2026-09-28', recent > prior ? 145 : 140)],
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
  assert.match(p.headline, /no lift is above its best from 4 weeks ago/i);
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
  assert.equal(p.verdict, 'progressing', 'verdict stays lift-based');
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

test('endurance without a weekly-sessions target → needs_target', () => {
  const p = computeGoalProgress(base({ goal: 'endurance' }));
  assert.equal(p.verdict, 'needs_target');
  assert.match(p.headline, /weekly session goal/);
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
  assert.match(p.headline, /^Building — training time up \d+% over 4 weeks/);
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
    'current', 'dataSufficiency', 'eta', 'goal', 'headline', 'onPaceForTargetDate',
    'ratePerWeek', 'reasons', 'safeBand', 'target', 'verdict',
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
  }));
  assert.match(p.headline, /Bench Press est\. 1RM up 11 lb/);
  const lift = p.reasons.find(r => r.kind === 'lift');
  assert.match(lift!.text, /\+11 lb vs 4 weeks ago \(220\.5 → 231\.5 lb\)/);
});
