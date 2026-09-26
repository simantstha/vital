import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bucketWorkoutMarkers,
  markersFromDailyMetrics,
  mergeWorkoutMarkers,
  type DailyMetricWorkoutRow,
  type Marker,
  type RawEvent,
} from './trendsMarkers';

function event(timestamp: string, payload: unknown = {}): RawEvent {
  return { timestamp: new Date(timestamp), payload };
}

function dmRow(date: string, payload: unknown, value?: number): DailyMetricWorkoutRow {
  return { date, value: value ?? (Array.isArray(payload) ? payload.length : 0), payload };
}

test('bucketWorkoutMarkers: single workout in a day labels its type', () => {
  const markers = bucketWorkoutMarkers([event('2026-09-01T12:00:00Z', { type: 'running' })], 'UTC');
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: 'Running', count: 1 }]);
});

test('bucketWorkoutMarkers: several workouts in a day use a count label', () => {
  const markers = bucketWorkoutMarkers(
    [
      event('2026-09-01T08:00:00Z', { type: 'running' }),
      event('2026-09-01T18:00:00Z', { type: 'cycling' }),
    ],
    'UTC',
  );
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: '2 workouts', count: 2 }]);
});

test('bucketWorkoutMarkers: single workout with no recognizable type falls back to a count label', () => {
  const markers = bucketWorkoutMarkers([event('2026-09-01T12:00:00Z', {})], 'UTC');
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: '1 workout', count: 1 }]);
});

test('bucketWorkoutMarkers: reads WHOOP sport_name as the type', () => {
  const markers = bucketWorkoutMarkers([event('2026-09-01T12:00:00Z', { sport_name: 'cycling' })], 'UTC');
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: 'Cycling', count: 1 }]);
});

test('bucketWorkoutMarkers: reads legacy workout_type as the type', () => {
  const markers = bucketWorkoutMarkers([event('2026-09-01T12:00:00Z', { workout_type: 'yoga' })], 'UTC');
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: 'Yoga', count: 1 }]);
});

test('bucketWorkoutMarkers: results are sorted oldest to newest', () => {
  const markers = bucketWorkoutMarkers(
    [event('2026-09-05T12:00:00Z', { type: 'running' }), event('2026-09-01T12:00:00Z', { type: 'cycling' })],
    'UTC',
  );
  assert.deepEqual(markers.map((m) => m.date), ['2026-09-01', '2026-09-05']);
});

test('bucketWorkoutMarkers: no events yields no markers', () => {
  assert.deepEqual(bucketWorkoutMarkers([], 'UTC'), []);
});

// ─── timezone: UTC and local day differ ────────────────────────────────────

test('bucketWorkoutMarkers: a late-UTC-evening workout buckets to the NEXT local day east of UTC', () => {
  // 2026-09-01 23:00 UTC is 2026-09-02 08:00 in Asia/Tokyo (UTC+9).
  const markers = bucketWorkoutMarkers(
    [event('2026-09-01T23:00:00Z', { type: 'running' })],
    'Asia/Tokyo',
  );
  assert.deepEqual(markers, [{ date: '2026-09-02', kind: 'workout', label: 'Running', count: 1 }]);
});

test('bucketWorkoutMarkers: an early-UTC-morning workout buckets to the PREVIOUS local day west of UTC', () => {
  // 2026-09-01 02:00 UTC is 2026-08-31 19:00 in America/Los_Angeles (UTC-7 in September DST).
  const markers = bucketWorkoutMarkers(
    [event('2026-09-01T02:00:00Z', { type: 'running' })],
    'America/Los_Angeles',
  );
  assert.deepEqual(markers, [{ date: '2026-08-31', kind: 'workout', label: 'Running', count: 1 }]);
});

test('bucketWorkoutMarkers: two events that are the same local day but different UTC days merge into one marker', () => {
  const markers = bucketWorkoutMarkers(
    [
      event('2026-09-01T23:30:00Z', { type: 'running' }),   // 2026-09-02 08:30 Tokyo
      event('2026-09-02T01:00:00Z', { type: 'cycling' }),   // 2026-09-02 10:00 Tokyo
    ],
    'Asia/Tokyo',
  );
  assert.deepEqual(markers, [{ date: '2026-09-02', kind: 'workout', label: '2 workouts', count: 2 }]);
});

// ─── markersFromDailyMetrics: the HealthKit-derived 'workouts' rows ────────

test('markersFromDailyMetrics: single workout labels its type from the payload', () => {
  const markers = markersFromDailyMetrics([
    dmRow('2026-09-01', [{ hkUuid: 'a', type: 'running', durationMin: 30 }]),
  ]);
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: 'Running', count: 1 }]);
});

test('markersFromDailyMetrics: several workouts in a day use a count label', () => {
  const markers = markersFromDailyMetrics([
    dmRow('2026-09-01', [
      { hkUuid: 'a', type: 'running', durationMin: 30 },
      { hkUuid: 'b', type: 'cycling', durationMin: 45 },
    ]),
  ]);
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: '2 workouts', count: 2 }]);
});

test('markersFromDailyMetrics: a malformed (non-array) payload falls back to `value` for the count', () => {
  const markers = markersFromDailyMetrics([dmRow('2026-09-01', { not: 'an array' }, 3)]);
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: '3 workouts', count: 3 }]);
});

test('markersFromDailyMetrics: a null payload falls back to `value`', () => {
  const markers = markersFromDailyMetrics([dmRow('2026-09-01', null, 1)]);
  assert.deepEqual(markers, [{ date: '2026-09-01', kind: 'workout', label: '1 workout', count: 1 }]);
});

test('markersFromDailyMetrics: an empty-array payload (workout deleted, day re-synced) is dropped', () => {
  const markers = markersFromDailyMetrics([dmRow('2026-09-01', [])]);
  assert.deepEqual(markers, []);
});

test('markersFromDailyMetrics: a value of 0 with a non-array payload is dropped', () => {
  const markers = markersFromDailyMetrics([dmRow('2026-09-01', null, 0)]);
  assert.deepEqual(markers, []);
});

test('markersFromDailyMetrics: results are sorted oldest to newest', () => {
  const markers = markersFromDailyMetrics([
    dmRow('2026-09-05', [{ hkUuid: 'a', type: 'running' }]),
    dmRow('2026-09-01', [{ hkUuid: 'b', type: 'cycling' }]),
  ]);
  assert.deepEqual(markers.map((m) => m.date), ['2026-09-01', '2026-09-05']);
});

// ─── mergeWorkoutMarkers: daily_metrics wins over events on the same date ──

test('mergeWorkoutMarkers: a daily_metrics-only day passes through', () => {
  const primary: Marker[] = [{ date: '2026-09-01', kind: 'workout', label: 'Running', count: 1 }];
  assert.deepEqual(mergeWorkoutMarkers(primary, []), primary);
});

test('mergeWorkoutMarkers: an events-only day passes through', () => {
  const secondary: Marker[] = [{ date: '2026-09-02', kind: 'workout', label: 'Cycling', count: 1 }];
  assert.deepEqual(mergeWorkoutMarkers([], secondary), secondary);
});

test('mergeWorkoutMarkers: a day present in both sources keeps only the daily_metrics marker (no double count)', () => {
  const primary: Marker[] = [{ date: '2026-09-01', kind: 'workout', label: 'Running', count: 1 }];
  const secondary: Marker[] = [{ date: '2026-09-01', kind: 'workout', label: '3 workouts', count: 3 }];
  assert.deepEqual(mergeWorkoutMarkers(primary, secondary), primary);
});

test('mergeWorkoutMarkers: a zero-count primary marker does not suppress a WHOOP event on the same date', () => {
  const primary: Marker[] = [{ date: '2026-09-01', kind: 'workout', label: '0 workouts', count: 0 }];
  const secondary: Marker[] = [{ date: '2026-09-01', kind: 'workout', label: 'Cycling', count: 1 }];
  assert.deepEqual(mergeWorkoutMarkers(primary, secondary), secondary);
});

test('mergeWorkoutMarkers: drops zero-count markers from either source entirely', () => {
  const primary: Marker[] = [{ date: '2026-09-01', kind: 'workout', label: '0 workouts', count: 0 }];
  const secondary: Marker[] = [{ date: '2026-09-02', kind: 'workout', label: '0 workouts', count: 0 }];
  assert.deepEqual(mergeWorkoutMarkers(primary, secondary), []);
});

test('mergeWorkoutMarkers: merges disjoint dates from both sources, sorted oldest to newest', () => {
  const primary: Marker[] = [{ date: '2026-09-03', kind: 'workout', label: 'Running', count: 1 }];
  const secondary: Marker[] = [{ date: '2026-09-01', kind: 'workout', label: 'Cycling', count: 1 }];
  assert.deepEqual(mergeWorkoutMarkers(primary, secondary), [
    { date: '2026-09-01', kind: 'workout', label: 'Cycling', count: 1 },
    { date: '2026-09-03', kind: 'workout', label: 'Running', count: 1 },
  ]);
});
