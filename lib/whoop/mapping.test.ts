import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWhoopWindow, type WhoopSyncWindowInput } from './mapping';
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from './client';

function emptyInput(): WhoopSyncWindowInput {
  return { cycles: [], recoveries: [], sleeps: [], workouts: [] };
}

function cycle(overrides: Partial<WhoopCycle> = {}): WhoopCycle {
  return {
    id: 1,
    user_id: 999,
    start: '2026-07-18T23:30:00.000Z',
    end: '2026-07-19T10:00:00.000Z',
    score_state: 'SCORED',
    score: { strain: 12.5, kilojoule: 8000, average_heart_rate: 80, max_heart_rate: 150 },
    ...overrides,
  };
}

function recovery(overrides: Partial<WhoopRecovery> = {}): WhoopRecovery {
  return {
    cycle_id: 1,
    sleep_id: 'sleep-1',
    user_id: 999,
    score_state: 'SCORED',
    score: {
      recovery_score: 67,
      resting_heart_rate: 52,
      hrv_rmssd_milli: 45.2,
      spo2_percentage: 97.5,
      skin_temp_celsius: 33.1,
    },
    ...overrides,
  };
}

function sleep(overrides: Partial<WhoopSleep> = {}): WhoopSleep {
  return {
    id: 'sleep-1',
    user_id: 999,
    start: '2026-07-18T23:30:00.000Z', // 6:30pm America/Chicago (UTC-5) — previous local day
    end: '2026-07-19T07:00:00.000Z',
    nap: false,
    score_state: 'SCORED',
    score: { stage_summary: { deep_minutes: 90 }, respiratory_rate: 14.2, sleep_performance_percentage: 88 },
    ...overrides,
  };
}

function workout(overrides: Partial<WhoopWorkout> = {}): WhoopWorkout {
  return {
    id: 'workout-1',
    user_id: 999,
    start: '2026-07-19T14:00:00.000Z',
    end: '2026-07-19T15:00:00.000Z',
    sport_name: 'running',
    score_state: 'SCORED',
    score: { strain: 14.1, average_heart_rate: 140, max_heart_rate: 175, kilojoule: 2092, distance_meter: 8000 },
    ...overrides,
  };
}

test('cycle with a score maps to whoop_day_strain, day-keyed in the user timezone', () => {
  const input = { ...emptyInput(), cycles: [cycle()] };
  const { dailyMetrics } = mapWhoopWindow(input, 'America/Chicago');

  assert.deepEqual(dailyMetrics, [
    { date: '2026-07-18', metric: 'whoop_day_strain', value: 12.5, payload: null },
  ]);
});

test('cycle without a score is skipped but still feeds recovery day-keying', () => {
  const input = {
    ...emptyInput(),
    cycles: [cycle({ score: null, score_state: 'PENDING_SCORE' })],
    recoveries: [recovery()],
  };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');

  // No whoop_day_strain row (unscored cycle), but the recovery still resolves
  // its date from the cycle's start.
  assert.equal(dailyMetrics.some((m) => m.metric === 'whoop_day_strain'), false);
  assert.ok(dailyMetrics.some((m) => m.metric === 'whoop_recovery' && m.date === '2026-07-18'));
});

test('recovery with a full score maps all five metrics, keyed by its cycle start date', () => {
  const input = { ...emptyInput(), cycles: [cycle()], recoveries: [recovery()] };
  const { dailyMetrics } = mapWhoopWindow(input, 'America/Chicago');

  const byMetric = new Map(dailyMetrics.map((m) => [m.metric, m]));
  assert.equal(byMetric.get('whoop_recovery')?.value, 67);
  assert.equal(byMetric.get('whoop_recovery')?.date, '2026-07-18');
  assert.equal(byMetric.get('whoop_hrv_rmssd')?.value, 45.2);
  assert.equal(byMetric.get('whoop_resting_hr')?.value, 52);
  assert.equal(byMetric.get('whoop_spo2')?.value, 97.5);
  assert.equal(byMetric.get('whoop_skin_temp')?.value, 33.1);
});

test('recovery with partial score omits only the missing metrics, never writes 0', () => {
  const input = {
    ...emptyInput(),
    cycles: [cycle()],
    recoveries: [recovery({ score: {
      recovery_score: 40, resting_heart_rate: 60, hrv_rmssd_milli: 30, spo2_percentage: null, skin_temp_celsius: null,
    } })],
  };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');
  const recoveryMetrics = dailyMetrics.filter((m) => m.metric !== 'whoop_day_strain').map((m) => m.metric).sort();

  assert.deepEqual(recoveryMetrics, ['whoop_hrv_rmssd', 'whoop_recovery', 'whoop_resting_hr']);
});

test('recovery with no score at all is skipped entirely (recovery not closed yet)', () => {
  const input = { ...emptyInput(), cycles: [cycle({ score: null, score_state: 'PENDING_SCORE' })], recoveries: [recovery({ score: null, score_state: 'PENDING_SCORE' })] };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');

  assert.deepEqual(dailyMetrics, []);
});

test('recovery whose cycle is missing from this window is skipped rather than guessing a date', () => {
  const input = { ...emptyInput(), cycles: [], recoveries: [recovery({ cycle_id: 999 })] };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');

  assert.deepEqual(dailyMetrics, []);
});

test('non-nap sleep maps duration to whoop_sleep_min with stage/respiratory/performance payload', () => {
  const input = { ...emptyInput(), sleeps: [sleep()] };
  const { dailyMetrics } = mapWhoopWindow(input, 'America/Chicago');

  assert.equal(dailyMetrics.length, 1);
  const [row] = dailyMetrics;
  assert.equal(row.metric, 'whoop_sleep_min');
  assert.equal(row.date, '2026-07-18'); // 6:30pm Chicago start
  assert.equal(row.value, 450); // 7.5h
  assert.deepEqual(row.payload, {
    stages: { deep_minutes: 90 },
    respiratory_rate: 14.2,
    performance: 88,
  });
});

test('nap sleep is skipped', () => {
  const input = { ...emptyInput(), sleeps: [sleep({ nap: true })] };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');

  assert.deepEqual(dailyMetrics, []);
});

test('sleep with no score yet still writes duration, with null payload extras', () => {
  const input = { ...emptyInput(), sleeps: [sleep({ score: null, score_state: 'PENDING_SCORE' })] };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');

  assert.equal(dailyMetrics.length, 1);
  assert.equal(dailyMetrics[0].metric, 'whoop_sleep_min');
  assert.deepEqual(dailyMetrics[0].payload, { stages: null, respiratory_rate: null, performance: null });
});

test('workout maps to an event payload with kilojoule converted to kcal', () => {
  const input = { ...emptyInput(), workouts: [workout()] };
  const { workoutEvents } = mapWhoopWindow(input, 'UTC');

  assert.equal(workoutEvents.length, 1);
  const [event] = workoutEvents;
  assert.equal(event.whoopId, 'workout-1');
  assert.deepEqual(event.timestamp, new Date('2026-07-19T14:00:00.000Z'));
  assert.deepEqual(event.payload, {
    whoopId: 'workout-1',
    sport_name: 'running',
    strain: 14.1,
    avg_hr: 140,
    max_hr: 175,
    kcal: 500, // 2092 kJ / 4.184
    distance_m: 8000,
  });
});

test('workout with no score yet is still recorded as an event, with null score fields', () => {
  const input = { ...emptyInput(), workouts: [workout({ score: null, score_state: 'PENDING_SCORE' })] };
  const { workoutEvents } = mapWhoopWindow(input, 'UTC');

  assert.equal(workoutEvents.length, 1);
  assert.deepEqual(workoutEvents[0].payload, {
    whoopId: 'workout-1',
    sport_name: 'running',
    strain: null,
    avg_hr: null,
    max_hr: null,
    kcal: null,
    distance_m: null,
  });
});

test('cycle with score but strain is null skips whoop_day_strain row', () => {
  const input = {
    ...emptyInput(),
    cycles: [cycle({ score: { strain: null, kilojoule: 8000, average_heart_rate: 80, max_heart_rate: 150 } })],
  };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');

  assert.equal(dailyMetrics.some((m) => m.metric === 'whoop_day_strain'), false);
});

test('recovery with score but recovery_score is null skips whoop_recovery row but writes other metrics', () => {
  const input = {
    ...emptyInput(),
    cycles: [cycle()],
    recoveries: [recovery({ score: {
      recovery_score: null,
      resting_heart_rate: 55,
      hrv_rmssd_milli: 48.5,
      spo2_percentage: 96,
      skin_temp_celsius: 33.5,
    } })],
  };
  const { dailyMetrics } = mapWhoopWindow(input, 'UTC');
  const byMetric = new Map(dailyMetrics.map((m) => [m.metric, m]));

  assert.equal(byMetric.has('whoop_recovery'), false);
  assert.equal(byMetric.get('whoop_hrv_rmssd')?.value, 48.5);
  assert.equal(byMetric.get('whoop_resting_hr')?.value, 55);
  assert.equal(byMetric.get('whoop_spo2')?.value, 96);
  assert.equal(byMetric.get('whoop_skin_temp')?.value, 33.5);
});
