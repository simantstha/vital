import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeRecovery,
  selectHrvSource,
  sleepEfficiencyFromHealthKitStages,
  sleepFromWhoopStageSummary,
  buildRecoveryHistory,
  summarizeRecoveryTrend,
  type RecoveryInput,
} from './recovery';

/**
 * Unit tests for the pure recovery-scoring module (lib/brain/recovery.ts),
 * which replaces the fabricating two-line formula in the old
 * lib/brain/brief.ts. Runs without a DATABASE_URL — recovery.ts has no `@/db`
 * import, same split as lib/brain/whoopContext.test.ts.
 *
 * Case 1 below is THE SHIPPED BUG: HRV 80 vs baseline 77 (barely above
 * baseline) with a short, middling-efficiency night used to round-trip to a
 * suspiciously high score under the old formula. The new weighted model
 * scores it 61 (amber) — proportionate to the data, not saturated.
 */

function baseInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    hrvSource: 'hrv_sdnn',
    hrv: 80,
    hrvBaseline: 80,
    hrvBaselineEstablished: true,
    hrvBaselineFromShortWindow: false,
    asleepMinutes: 480,
    sleepEfficiencyPct: 90,
    sleepGoalMinutes: 480,
    ...overrides,
  };
}

test('HRV barely above baseline with a short night scores 61/amber, not saturated (the shipped bug)', () => {
  const result = computeRecovery(baseInput({ hrv: 80, hrvBaseline: 77, asleepMinutes: 290, sleepEfficiencyPct: 90 }));
  assert.equal(result.score, 61);
  assert.equal(result.band, 'amber');
  assert.notEqual(result.score, 100);
});

test('HRV at baseline with a full, efficient night scores 85', () => {
  const result = computeRecovery(baseInput({ hrv: 80, hrvBaseline: 80, asleepMinutes: 480, sleepEfficiencyPct: 92 }));
  assert.equal(result.score, 85);
});

test('HRV 3x baseline saturates the HRV component at its full 60 points', () => {
  const result = computeRecovery(baseInput({ hrv: 75, hrvBaseline: 25, asleepMinutes: 200, sleepEfficiencyPct: 50 }));
  assert.equal(result.components.hrv?.points, 60);
  assert.equal(result.components.hrv?.factor, 1);
});

test('290 vs 510 minutes asleep (same efficiency) differ by ~30 points', () => {
  const short = computeRecovery(baseInput({ asleepMinutes: 290, sleepEfficiencyPct: 90 }));
  const long = computeRecovery(baseInput({ asleepMinutes: 510, sleepEfficiencyPct: 90 }));
  assert.equal(short.score, 55);
  assert.equal(long.score, 85);
  assert.equal((long.score ?? 0) - (short.score ?? 0), 30);
});

test('480 vs 600 minutes asleep score identically — no oversleep bonus past the goal', () => {
  const atGoal = computeRecovery(baseInput({ asleepMinutes: 480, sleepEfficiencyPct: 90 }));
  const overGoal = computeRecovery(baseInput({ asleepMinutes: 600, sleepEfficiencyPct: 90 }));
  assert.equal(atGoal.score, overGoal.score);
  assert.equal(atGoal.components.sleepDuration?.factor, 1);
  assert.equal(overGoal.components.sleepDuration?.factor, 1);
});

test('a lower sleep goal makes fewer minutes count as full duration credit', () => {
  const result = computeRecovery(baseInput({ asleepMinutes: 420, sleepGoalMinutes: 420 }));
  assert.equal(result.components.sleepDuration?.factor, 1);
  assert.equal(result.components.sleepDuration?.points, 30);
});

test('missing sleep duration drops it from the score instead of imputing it', () => {
  const result = computeRecovery(baseInput({ hrv: 80, hrvBaseline: 80, asleepMinutes: null, sleepEfficiencyPct: 85 }));
  assert.equal(result.score, 75);
  assert.equal(result.confidence, 'provisional');
  assert.ok(result.gaps.includes('no_sleep_duration'));
  assert.equal(result.components.sleepDuration, null);
});

test('missing sleep efficiency only shrinks the denominator to 90 (HRV + duration)', () => {
  const result = computeRecovery(baseInput({ hrv: 80, hrvBaseline: 80, asleepMinutes: 480, sleepEfficiencyPct: null }));
  assert.deepEqual(result.gaps, ['no_sleep_efficiency']);
  assert.equal(result.components.sleepEfficiency, null);
  assert.equal(result.components.sleepDuration?.weight, 30);
  assert.equal(result.components.hrv?.weight, 60);
  // (60*0.75 + 30*1.0) / 90 * 100 = 83.33... -> 83
  assert.equal(result.score, 83);
});

test('missing HRV means insufficient confidence and a null score/band', () => {
  const result = computeRecovery(baseInput({ hrv: null }));
  assert.equal(result.score, null);
  assert.equal(result.band, null);
  assert.equal(result.confidence, 'insufficient');
  assert.deepEqual(result.gaps, ['no_hrv']);
  assert.deepEqual(result.components, { hrv: null, sleepDuration: null, sleepEfficiency: null });
});

test('an unestablished HRV baseline caps confidence at provisional', () => {
  const result = computeRecovery(baseInput({ hrvBaselineEstablished: false }));
  assert.equal(result.confidence, 'provisional');
  assert.deepEqual(result.gaps, ['baseline_calibrating']);
});

test('selectHrvSource: WHOOP-only connection with a recent point picks WHOOP', () => {
  const source = selectHrvSource({
    whoopConnected: true,
    whoopRecentPointDays: 3,
    whoopBaselineDataDays: 30,
    healthkitRecentPointDays: 0,
    healthkitBaselineDataDays: 0,
  });
  assert.equal(source, 'whoop_hrv_rmssd');
});

test('selectHrvSource: HealthKit-only (no WHOOP) picks HealthKit', () => {
  const source = selectHrvSource({
    whoopConnected: false,
    whoopRecentPointDays: 0,
    whoopBaselineDataDays: 0,
    healthkitRecentPointDays: 5,
    healthkitBaselineDataDays: 30,
  });
  assert.equal(source, 'hrv_sdnn');
});

test('selectHrvSource: both sources have recent points — WHOOP wins', () => {
  const source = selectHrvSource({
    whoopConnected: true,
    whoopRecentPointDays: 2,
    whoopBaselineDataDays: 30,
    healthkitRecentPointDays: 5,
    healthkitBaselineDataDays: 30,
  });
  assert.equal(source, 'whoop_hrv_rmssd');
});

test('selectHrvSource: a WHOOP recent-point window under a week still picks WHOOP (no 7-day stability requirement)', () => {
  const source = selectHrvSource({
    whoopConnected: true,
    whoopRecentPointDays: 6,
    whoopBaselineDataDays: 6,
    healthkitRecentPointDays: 5,
    healthkitBaselineDataDays: 30,
  });
  assert.equal(source, 'whoop_hrv_rmssd');
});

test('selectHrvSource: WHOOP not connected falls back to HealthKit even with WHOOP baseline history', () => {
  const source = selectHrvSource({
    whoopConnected: false,
    whoopRecentPointDays: 0,
    whoopBaselineDataDays: 5,
    healthkitRecentPointDays: 0,
    healthkitBaselineDataDays: 3,
  });
  assert.equal(source, 'hrv_sdnn');
});

test('sleepEfficiencyFromHealthKitStages derives efficiency from asleep/awake minutes', () => {
  assert.equal(sleepEfficiencyFromHealthKitStages(435, { awake: 45 }), 91);
  assert.equal(sleepEfficiencyFromHealthKitStages(435, { awakeMinutes: 45 }), 91);
  assert.equal(sleepEfficiencyFromHealthKitStages(435, null), null);
  assert.equal(sleepEfficiencyFromHealthKitStages(435, {}), null);
});

test('sleepFromWhoopStageSummary converts in-bed time to asleep time via total_awake_time_milli', () => {
  const derived = sleepFromWhoopStageSummary(480, { total_awake_time_milli: 45 * 60_000 });
  assert.deepEqual(derived, { asleepMinutes: 435, efficiencyPct: 91 });

  // A WHOOP night derived this way scores identically to a HealthKit night
  // reporting the same asleep-minutes/efficiency directly — the scorer only
  // cares about the numbers, not which wearable produced them.
  const fromWhoop = computeRecovery(baseInput({
    hrvSource: 'whoop_hrv_rmssd',
    asleepMinutes: derived!.asleepMinutes,
    sleepEfficiencyPct: derived!.efficiencyPct,
  }));
  const fromHealthKit = computeRecovery(baseInput({
    hrvSource: 'hrv_sdnn',
    asleepMinutes: 435,
    sleepEfficiencyPct: 91,
  }));
  assert.equal(fromWhoop.score, fromHealthKit.score);
  assert.equal(fromWhoop.band, fromHealthKit.band);
});

test('sleepFromWhoopStageSummary returns null when the stage summary has no awake-time field or result is non-positive', () => {
  assert.equal(sleepFromWhoopStageSummary(480, {}), null);
  assert.equal(sleepFromWhoopStageSummary(480, null), null);
  assert.equal(sleepFromWhoopStageSummary(40, { total_awake_time_milli: 45 * 60_000 }), null); // awake > in-bed
});

test('buildRecoveryHistory omits a day with no HRV instead of fabricating a near-perfect score', () => {
  const shared = {
    hrvSource: 'hrv_sdnn' as const,
    hrvBaseline: 80,
    hrvBaselineEstablished: true,
    hrvBaselineFromShortWindow: false,
    sleepGoalMinutes: 480,
  };
  const history = buildRecoveryHistory(
    [
      { date: '2026-08-02', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
      { date: '2026-08-01', asleepMinutes: 480, sleepEfficiencyPct: 90 }, // no hrv — must be dropped, not scored ~97
    ],
    shared,
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].date, '2026-08-02');
});

test('buildRecoveryHistory sorts newest-first by date', () => {
  const shared = {
    hrvSource: 'hrv_sdnn' as const,
    hrvBaseline: 80,
    hrvBaselineEstablished: true,
    hrvBaselineFromShortWindow: false,
    sleepGoalMinutes: 480,
  };
  const history = buildRecoveryHistory(
    [
      { date: '2026-08-01', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
      { date: '2026-08-03', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
      { date: '2026-08-02', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
    ],
    shared,
  );
  assert.deepEqual(history.map((d) => d.date), ['2026-08-03', '2026-08-02', '2026-08-01']);
});

test('summarizeRecoveryTrend returns unknown when either comparison window has fewer than 2 days', () => {
  const shared = {
    hrvSource: 'hrv_sdnn' as const,
    hrvBaseline: 80,
    hrvBaselineEstablished: true,
    hrvBaselineFromShortWindow: false,
    sleepGoalMinutes: 480,
  };
  // 4 days: recent window (3) has enough, older window only has 1 — still unknown.
  const history = buildRecoveryHistory(
    [
      { date: '2026-08-04', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
      { date: '2026-08-03', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
      { date: '2026-08-02', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
      { date: '2026-08-01', hrv: 80, asleepMinutes: 480, sleepEfficiencyPct: 90 },
    ],
    shared,
  );
  const summary = summarizeRecoveryTrend(history);
  assert.equal(summary.trend, 'unknown');
  assert.notEqual(summary.avgRecovery, null);
});

test('summarizeRecoveryTrend returns null averages for an empty history', () => {
  const summary = summarizeRecoveryTrend([]);
  assert.deepEqual(summary, { avgRecovery: null, avgHrv: null, trend: 'unknown' });
});
