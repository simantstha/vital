import assert from 'node:assert/strict';
import test from 'node:test';

import { assessWeightSignals } from '../brain/weightSignals';
import { COOLDOWN_DAYS, shortlist } from './arbiter';
import { applyEvidenceGate } from './evidence';
import {
  detectGoalFindings,
  detectInactivityStreak,
  detectLowProteinStreak,
  detectOffPace,
  detectStalledLift,
  detectTooFastLoss,
  detectWeightPlateau,
  type GoalInsightInput,
} from './goalDetectors';
import { runInsightPass, withinDeliveryCaps, type InsightPassRepository } from './nudgeWorker';
import type { CertifiedFinding, Finding } from './types';

// 2026-10-07 is a Wednesday; its Monday is 2026-10-05, last completed week 2026-09-28.
const TODAY = '2026-10-07';

function day(offset: number): string {
  const d = new Date(Date.UTC(2026, 9, 7));
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function input(overrides: Partial<GoalInsightInput> = {}): GoalInsightInput {
  return {
    goal: 'general', unitSystem: 'metric', todayKey: TODAY, weightSignals: [],
    targetWeightKg: null, targetDate: null, proteinTargetG: null, loggedDays: [],
    trainingDays: [], progression: {}, liftSessionDays: {}, exerciseDisplay: {}, weeklyVerdicts: [],
    ...overrides,
  };
}

function certify(f: Finding): CertifiedFinding {
  return { ...f, confirmedOnRuns: 2 };
}

/** Every goal finding must be shortlist-able and then blocked inside the per-kind cooldown. */
function assertCooldown(f: Finding): void {
  assert.equal(shortlist([certify(f)], { goal: null, recentKinds: new Map() }).length, 1);
  assert.deepEqual(shortlist([certify(f)], { goal: null, recentKinds: new Map([[f.kind, 6]]) }), []);
  assert.ok(COOLDOWN_DAYS >= 7);
  const now = new Date('2026-10-07T12:00:00Z');
  const sent = [{ kind: f.kind, sentAt: new Date(now.getTime() - 6 * 86_400_000) }];
  assert.equal(withinDeliveryCaps(sent, now, f.kind), false);
}

function assertSafeCopy(f: Finding): void {
  assert.ok(f.copy);
  const text = `${f.copy.title} ${f.copy.body} ${f.copy.openingMessage}`.toLowerCase();
  for (const bad of ['lazy', 'fail', 'cheat', 'should have', 'guilt', 'kcal', 'calories', 'cut back', 'eat less']) {
    assert.ok(!text.includes(bad), `copy contains "${bad}"`);
  }
  assert.equal(f.pValue, null);
  assert.deepEqual(f.metrics, []);
  assert.ok(f.signature.startsWith('goal:'));
}

// ── weight_plateau ──────────────────────────────────────────────────────────

const plateauSignal = { kind: 'plateau' as const, severity: 'info' as const, facts: { pctPerWeek: 0.05, trendKg: 82.1 } };

test('weight_plateau fires for a fat-loss user and quotes the trend', () => {
  const f = detectWeightPlateau(input({ goal: 'weight_loss', weightSignals: [plateauSignal] }));
  assert.ok(f);
  assert.equal(f.kind, 'weight_plateau');
  assert.match(f.copy!.body, /flat at 82\.1 kg for 2 weeks/);
  assertSafeCopy(f);
  assertCooldown(f);
});

test('weight_plateau is unit-aware', () => {
  const f = detectWeightPlateau(input({ goal: 'weight_loss', unitSystem: 'imperial', weightSignals: [plateauSignal] }));
  assert.match(f!.copy!.body, /181 lb/);
});

test('weight_plateau does not fire without the signal', () => {
  assert.equal(detectWeightPlateau(input({ goal: 'weight_loss' })), null);
});

test('weight_plateau does not fire for the wrong goal', () => {
  assert.equal(detectWeightPlateau(input({ goal: 'muscle', weightSignals: [plateauSignal] })), null);
});

// ── too_fast_loss ───────────────────────────────────────────────────────────

const fastSignal = { kind: 'too_fast_loss' as const, severity: 'watch' as const, facts: { rateKgPerWeek: -1.2, pctPerWeek: 1.5, sustained: 'yes' } };

test('too_fast_loss fires, suggests eating more and never shames', () => {
  const f = detectTooFastLoss(input({ goal: 'weight_loss', weightSignals: [fastSignal] }));
  assert.ok(f);
  assert.match(f.copy!.body, /1\.2 kg a week/);
  assert.match(f.copy!.body, /eating a little more/);
  assert.match(f.copy!.openingMessage, /how have you been feeling/i);
  assertSafeCopy(f);
  assertCooldown(f);
});

test('too_fast_loss does not fire without the signal or for the wrong goal', () => {
  assert.equal(detectTooFastLoss(input({ goal: 'weight_loss' })), null);
  assert.equal(detectTooFastLoss(input({ goal: 'muscle', weightSignals: [fastSignal] })), null);
});

test('too_fast_loss outranks the other goal findings', () => {
  const all = [
    detectTooFastLoss(input({ goal: 'weight_loss', weightSignals: [fastSignal] })),
    detectWeightPlateau(input({ goal: 'weight_loss', weightSignals: [plateauSignal] })),
  ].filter((f): f is Finding => f !== null).map(certify);
  assert.equal(shortlist(all, { goal: 'weight_loss', recentKinds: new Map() })[0].kind, 'too_fast_loss');
});

// ── stalled_lift ────────────────────────────────────────────────────────────

// recent window starts 2026-09-14 (current Monday 2026-10-05 minus 21 days).
const stalledProgression = {
  squat: [
    { weekStart: '2026-08-31', bestEstimatedOneRepMaxKg: 120, volumeKg: 1, totalSets: 3, totalReps: 15 },
    { weekStart: '2026-09-14', bestEstimatedOneRepMaxKg: 118, volumeKg: 1, totalSets: 3, totalReps: 15 },
    { weekStart: '2026-09-28', bestEstimatedOneRepMaxKg: 119, volumeKg: 1, totalSets: 3, totalReps: 15 },
  ],
};
const squatDays = ['2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06'];

function stalledInput(over: Partial<GoalInsightInput> = {}): GoalInsightInput {
  return input({
    goal: 'muscle', progression: stalledProgression,
    liftSessionDays: { squat: squatDays }, exerciseDisplay: { squat: 'Back squat' }, ...over,
  });
}

test('stalled_lift fires for a muscle user with no e1RM gain in 3 weeks and >=3 sessions', () => {
  const f = detectStalledLift(stalledInput());
  assert.ok(f);
  assert.match(f.copy!.body, /Back squat/);
  assert.match(f.copy!.body, /120\.0 kg/);
  assert.equal(f.detail.sessions, 4);
  assertSafeCopy(f);
  assertCooldown(f);
});

test('stalled_lift does not fire when e1RM improved', () => {
  const improving = { squat: [...stalledProgression.squat.slice(0, 2), { ...stalledProgression.squat[2], bestEstimatedOneRepMaxKg: 126 }] };
  assert.equal(detectStalledLift(stalledInput({ progression: improving })), null);
});

test('stalled_lift needs at least 3 sessions in the window', () => {
  assert.equal(detectStalledLift(stalledInput({ liftSessionDays: { squat: ['2026-09-15', '2026-10-06'] } })), null);
});

test('stalled_lift does not fire for the wrong goal', () => {
  assert.equal(detectStalledLift(stalledInput({ goal: 'weight_loss' })), null);
});

// ── low_protein_streak ──────────────────────────────────────────────────────

function logged(offsets: number[], proteinG: number, mealCount = 3) {
  return offsets.map((o) => ({ day: day(o), mealCount, proteinG }));
}

test('low_protein_streak fires for muscle and fat-loss users on 4 of 5 low days', () => {
  for (const goal of ['muscle', 'weight_loss']) {
    const f = detectLowProteinStreak(input({
      goal, proteinTargetG: 150,
      loggedDays: [...logged([-1, -2, -3, -4], 90), ...logged([-5], 140)],
    }));
    assert.ok(f, goal);
    assert.match(f.copy!.body, /4 of your last 5 logged days/);
    assert.match(f.copy!.body, /150 g/);
    assertSafeCopy(f);
    assertCooldown(f);
  }
});

test('low_protein_streak ignores partially logged days', () => {
  // 4 low days but only one meal each: they do not count, leaving < 5 qualifying days.
  const f = detectLowProteinStreak(input({
    goal: 'muscle', proteinTargetG: 150,
    loggedDays: [...logged([-1, -2, -3, -4], 40, 1), ...logged([-5], 140)],
  }));
  assert.equal(f, null);
});

test('low_protein_streak does not fire with only 3 low days, or when the data is stale', () => {
  assert.equal(detectLowProteinStreak(input({
    goal: 'muscle', proteinTargetG: 150,
    loggedDays: [...logged([-1, -2, -3], 90), ...logged([-4, -5], 150)],
  })), null);
  assert.equal(detectLowProteinStreak(input({
    goal: 'muscle', proteinTargetG: 150, loggedDays: logged([-6, -7, -8, -9, -10], 90),
  })), null);
});

test('low_protein_streak does not fire for the wrong goal or without a target', () => {
  const days = logged([-1, -2, -3, -4, -5], 90);
  assert.equal(detectLowProteinStreak(input({ goal: 'endurance', proteinTargetG: 150, loggedDays: days })), null);
  assert.equal(detectLowProteinStreak(input({ goal: 'muscle', proteinTargetG: null, loggedDays: days })), null);
});

// ── inactivity_streak ───────────────────────────────────────────────────────

// 3 workouts a week for 4 weeks, the last one 6 days ago.
const baselineDays = Array.from({ length: 12 }, (_, i) => day(-6 - i * 2));

test('inactivity_streak fires for any goal after 5+ quiet days from a >=2/week baseline', () => {
  for (const goal of ['general', 'muscle', 'weight_loss', 'endurance']) {
    const f = detectInactivityStreak(input({ goal, trainingDays: baselineDays }));
    assert.ok(f, goal);
    assert.equal(f.detail.daysSinceLast, 6);
    assert.match(f.copy!.body, /6 days/);
    assert.match(f.copy!.openingMessage, /No judgement/);
    assertSafeCopy(f);
    assertCooldown(f);
  }
});

test('inactivity_streak does not fire after only 4 quiet days', () => {
  assert.equal(detectInactivityStreak(input({ trainingDays: [...baselineDays, day(-4)] })), null);
});

test('inactivity_streak does not fire when the baseline is under 2 a week', () => {
  assert.equal(detectInactivityStreak(input({ trainingDays: [day(-6), day(-13), day(-20), day(-27), day(-34)] })), null);
});

test('inactivity_streak does not fire for a long-lapsed user or with no history', () => {
  assert.equal(detectInactivityStreak(input({ trainingDays: baselineDays.map((_, i) => day(-30 - i * 2)) })), null);
  assert.equal(detectInactivityStreak(input()), null);
});

// ── off_pace ────────────────────────────────────────────────────────────────

function offPaceInput(over: Partial<GoalInsightInput> = {}): GoalInsightInput {
  return input({
    goal: 'weight_loss', targetWeightKg: 75, targetDate: '2026-12-15',
    weeklyVerdicts: [
      { weekStart: '2026-09-28', verdict: 'behind' },
      { weekStart: '2026-09-21', verdict: 'behind' },
    ],
    ...over,
  });
}

test('off_pace fires after two consecutive behind weekly reviews with a target date', () => {
  const f = detectOffPace(offPaceInput());
  assert.ok(f);
  assert.match(f.copy!.body, /75\.0 kg by Dec 15/);
  assertSafeCopy(f);
  assertCooldown(f);
});

test('off_pace does not fire on a single behind week, a gap, or stale reviews', () => {
  assert.equal(detectOffPace(offPaceInput({ weeklyVerdicts: [{ weekStart: '2026-09-28', verdict: 'behind' }, { weekStart: '2026-09-21', verdict: 'on_track' }] })), null);
  assert.equal(detectOffPace(offPaceInput({ weeklyVerdicts: [{ weekStart: '2026-09-28', verdict: 'behind' }, { weekStart: '2026-09-14', verdict: 'behind' }] })), null);
  assert.equal(detectOffPace(offPaceInput({ weeklyVerdicts: [{ weekStart: '2026-09-21', verdict: 'behind' }, { weekStart: '2026-09-14', verdict: 'behind' }] })), null);
});

test('off_pace needs a future target date and a fat-loss goal', () => {
  assert.equal(detectOffPace(offPaceInput({ targetDate: null })), null);
  assert.equal(detectOffPace(offPaceInput({ targetDate: '2026-10-01' })), null);
  assert.equal(detectOffPace(offPaceInput({ goal: 'muscle' })), null);
});

// ── pipeline integration ────────────────────────────────────────────────────

test('goal findings pass the evidence gate with no established metrics', () => {
  const findings = detectGoalFindings(offPaceInput({
    weightSignals: [plateauSignal, fastSignal], trainingDays: baselineDays,
  }));
  assert.deepEqual(
    new Set(findings.map((f) => f.kind)),
    new Set(['weight_plateau', 'too_fast_loss', 'inactivity_streak', 'off_pace']),
  );
  assert.equal(applyEvidenceGate(findings, new Set()).length, findings.length);
});

function goalRepo(goalInput: GoalInsightInput, previous: Set<string>, inserted: { kind: string; title: string; opening: string }[]): InsightPassRepository {
  return {
    async loadSeries(_u, metrics) { return metrics.map((metric) => ({ metric, points: [] })); },
    async establishedMetrics() { return new Set<string>(); },
    async loadGoalInput() { return goalInput; },
    async recordFindings() {},
    async previousRunSignatures() { return previous; },
    async sentNudgeHistory() { return []; },
    async voiceContext() { return { goal: 'weight_loss', facts: [], recentlySaid: [] }; },
    async insertPendingNudge(_u, _d, kind, nudge) { inserted.push({ kind, title: nudge.title, opening: nudge.openingMessage }); return 'n1'; },
    async markNudgeSent() {},
    async listDevices() { return []; },
  };
}

test('runInsightPass delivers a confirmed goal finding using its own copy', async () => {
  const inserted: { kind: string; title: string; opening: string }[] = [];
  const repo = goalRepo(input({ goal: 'weight_loss', weightSignals: [plateauSignal] }), new Set(['goal:weight_plateau']), inserted);
  const outcome = await runInsightPass({
    repository: repo, userId: 'u', now: new Date('2026-10-07T15:00:00Z'), localDay: TODAY, mode: 'live',
    generateNudge: async () => JSON.stringify({ signature: 'goal:weight_plateau', title: 'model title', body: 'model body', openingMessage: 'model opening' }),
    push: async () => ({ outcome: 'sent', retireToken: false }),
  });
  assert.equal(outcome.delivered, true);
  assert.equal(inserted[0].kind, 'weight_plateau');
  assert.equal(inserted[0].title, 'Your weight trend has flattened');
  assert.match(inserted[0].opening, /flat at 82\.1 kg/);
});

test('runInsightPass stays silent on the first day a goal finding appears (needs two runs)', async () => {
  const inserted: { kind: string; title: string; opening: string }[] = [];
  const repo = goalRepo(input({ goal: 'weight_loss', weightSignals: [plateauSignal] }), new Set<string>(), inserted);
  const outcome = await runInsightPass({
    repository: repo, userId: 'u', now: new Date('2026-10-07T15:00:00Z'), localDay: TODAY, mode: 'live',
    generateNudge: async () => '', push: async () => ({ outcome: 'sent', retireToken: false }),
  });
  assert.equal(outcome.delivered, false);
  assert.equal(inserted.length, 0);
});

// ── one stall definition (lib/liftChange.ts) ────────────────────────────────

const wv = (weekStart: string, e: number, volumeKg: number) => ({ weekStart, bestEstimatedOneRepMaxKg: e, volumeKg, totalSets: 5, totalReps: 25 });
// Current Monday 2026-10-05. Flat 100 kg lift, steady volume across 6 weeks.
const flatWeeks = [
  wv('2026-08-31', 100, 1000), wv('2026-09-07', 100, 1000), wv('2026-09-14', 100, 1000),
  wv('2026-09-21', 100, 1000), wv('2026-09-28', 100, 1000), wv('2026-10-05', 100, 1000),
];

test('stalled_lift: flat vs 4 weeks ago (< +1%) fires, a +1% gain does not', () => {
  assert.ok(detectStalledLift(stalledInput({ progression: { squat: flatWeeks } })));
  const gained = flatWeeks.map((w) => (w.weekStart >= '2026-09-28' ? { ...w, bestEstimatedOneRepMaxKg: 101 } : w));
  assert.equal(detectStalledLift(stalledInput({ progression: { squat: gained } })), null);
});

test('stalled_lift: skipped after a break (no sets in the 2 weeks before the recent window)', () => {
  const afterBreak = flatWeeks.filter((w) => w.weekStart !== '2026-09-14' && w.weekStart !== '2026-09-21');
  assert.equal(detectStalledLift(stalledInput({ progression: { squat: afterBreak } })), null);
});

test('stalled_lift: skipped when the recent window is a deload (< 60% of the 4-week average volume)', () => {
  const deload = flatWeeks.map((w) => (w.weekStart >= '2026-09-28' ? { ...w, volumeKg: 400 } : w));
  assert.equal(detectStalledLift(stalledInput({ progression: { squat: deload } })), null);
});

test('stalled_lift: an empty current week does not hide or fake a stall (uses the last 2 weeks with sets)', () => {
  const noCurrent = flatWeeks.filter((w) => w.weekStart !== '2026-10-05');
  assert.ok(detectStalledLift(stalledInput({ progression: { squat: noCurrent } })));
});

test('stalled_lift: display name falls back to Title Case', () => {
  const f = detectStalledLift(stalledInput({ progression: { 'bench press': flatWeeks }, liftSessionDays: { 'bench press': squatDays }, exerciseDisplay: {} }));
  assert.ok(f);
  assert.match(f.copy!.title, /Bench Press/);
});

test('off_pace ignores reviews of weeks that ended before the goal was re-anchored', () => {
  assert.ok(detectOffPace(offPaceInput({ goalStartedDay: '2026-09-10' })));
  // Goal began 2026-09-24: the 09-21 week (ended 09-27) is fine, but a start of 09-28 voids it.
  assert.ok(detectOffPace(offPaceInput({ goalStartedDay: '2026-09-27' })));
  assert.equal(detectOffPace(offPaceInput({ goalStartedDay: '2026-09-28' })), null);
});

// ── weight_plateau needs a current weigh-in ─────────────────────────────────

test('weight_plateau stays quiet for a user who stopped weighing in (signal comes from todayKey-aware assessWeightSignals)', () => {
  // A flat, established 20-day trend whose newest weigh-in is `age` days before TODAY.
  const flatTrend = (age: number) => {
    const days = Array.from({ length: 21 }, (_, i) => ({ day: day(-(age + 20 - i)), rawKg: 82, trendKg: 82 }));
    return { days, delta7dKgPerWeek: 0, delta30dKgPerWeek: 0, established: true };
  };
  const nudgeFor = (age: number) => detectWeightPlateau(input({
    goal: 'weight_loss',
    weightSignals: assessWeightSignals({
      trend: flatTrend(age), dailyIntakeKcal: [], floorKcal: 0, goal: 'weight_loss', todayKey: TODAY,
    }),
  }));
  assert.ok(nudgeFor(1), 'a current flat trend still nudges');
  assert.ok(nudgeFor(4), 'weighed in 4 days ago still counts as current');
  assert.equal(nudgeFor(5), null);
  assert.equal(nudgeFor(30), null);
});
