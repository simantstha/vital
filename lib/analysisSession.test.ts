import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSameSession,
  overlapRatio,
  parseWorkoutWindow,
  priorityRank,
  resolveSessionConflict,
  type SessionCandidate,
  type SessionIdentity,
} from './analysisSession';

function window(startIso: string, endIso: string): { startedAt: Date; endedAt: Date } {
  return { startedAt: new Date(startIso), endedAt: new Date(endIso) };
}

test('overlapRatio: identical windows overlap 100%', () => {
  const a = window('2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z');
  assert.equal(overlapRatio(a, a), 1);
});

test('overlapRatio: disjoint windows overlap 0%', () => {
  const a = window('2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z');
  const b = window('2026-08-01T12:00:00Z', '2026-08-01T13:00:00Z');
  assert.equal(overlapRatio(a, b), 0);
});

test('overlapRatio: is a fraction of the SHORTER duration', () => {
  // a: 60 min, b: 30 min, fully contained inside a -> 100% of the shorter (b).
  const a = window('2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z');
  const b = window('2026-08-01T10:15:00Z', '2026-08-01T10:45:00Z');
  assert.equal(overlapRatio(a, b), 1);
  assert.equal(overlapRatio(b, a), 1);
});

test('overlapRatio: exactly at the 50% threshold', () => {
  // a: 40 min; b: 20 min entirely inside a -> overlap 20/20 = 100% of the shorter... use asymmetric case instead
  const a = window('2026-08-01T10:00:00Z', '2026-08-01T10:40:00Z'); // 40 min
  const b = window('2026-08-01T10:30:00Z', '2026-08-01T11:10:00Z'); // 40 min, overlaps [10:30,10:40] = 10 min
  assert.equal(overlapRatio(a, b), 10 / 40);
});

test('overlapRatio: zero-duration window never overlaps', () => {
  const a = window('2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z');
  const b = window('2026-08-01T09:00:00Z', '2026-08-01T11:00:00Z');
  assert.equal(overlapRatio(a, b), 0);
});

function identity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return { ...window('2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z'), source: 'healthkit', ...overrides };
}

test('isSameSession: true when overlap >= 50% of the shorter duration', () => {
  const a = identity();
  const b = identity({ ...window('2026-08-01T10:30:00Z', '2026-08-01T11:30:00Z') }); // overlaps 30/60 = 50%
  assert.ok(isSameSession(a, b));
});

test('isSameSession: false just under 50%', () => {
  const a = identity();
  const b = identity({ ...window('2026-08-01T10:31:00Z', '2026-08-01T11:31:00Z') }); // overlaps 29/60
  assert.ok(!isSameSession(a, b));
});

test('isSameSession: two WHOOP rows with the same whoopId match regardless of window', () => {
  const a = identity({ source: 'whoop', whoopId: 'w-1', ...window('2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z') });
  const b = identity({ source: 'whoop', whoopId: 'w-1', ...window('2026-08-05T00:00:00Z', '2026-08-05T01:00:00Z') });
  assert.ok(isSameSession(a, b));
});

test('isSameSession: matching whoopId does not count when only one side is WHOOP', () => {
  const a = identity({ source: 'healthkit' });
  const b = identity({ source: 'whoop', whoopId: 'w-1', ...window('2026-08-05T00:00:00Z', '2026-08-05T01:00:00Z') });
  assert.ok(!isSameSession(a, b));
});

test('priorityRank: apple health bundle id is rank 1', () => {
  assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: 'com.apple.health.abc' }), 1);
});

test('priorityRank: no bundle id (older app) is also rank 1', () => {
  assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: null }), 1);
  assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: undefined }), 1);
});

test('priorityRank: other healthkit bundle ids are rank 2', () => {
  assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: 'com.strava.run' }), 2);
});

test('priorityRank: whoop is always rank 3', () => {
  assert.equal(priorityRank({ source: 'whoop', sourceBundleId: null }), 3);
});

test("priorityRank: null/undefined/'apple' preference all keep the original order", () => {
  for (const pref of [undefined, null, 'apple' as const]) {
    assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: 'com.apple.health' }, pref), 1);
    assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: null }, pref), 1);
    assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: 'com.strava.run' }, pref), 2);
    assert.equal(priorityRank({ source: 'whoop', sourceBundleId: null }, pref), 3);
  }
});

test("priorityRank: 'whoop' preference moves WHOOP to rank 1, keeps the two HealthKit ranks in the same relative order", () => {
  assert.equal(priorityRank({ source: 'whoop', sourceBundleId: null }, 'whoop'), 1);
  assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: 'com.apple.health' }, 'whoop'), 2);
  assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: null }, 'whoop'), 2);
  assert.equal(priorityRank({ source: 'healthkit', sourceBundleId: 'com.strava.run' }, 'whoop'), 3);
});

function candidate(overrides: Partial<SessionCandidate> = {}): SessionCandidate {
  return { key: 'k', source: 'healthkit', sourceBundleId: null, notified: false, ...overrides };
}

test('resolveSessionConflict: incoming apple-health beats existing whoop -> incoming wins', () => {
  const existing = candidate({ key: 'whoop-1', source: 'whoop', notified: false });
  const incoming = candidate({ key: 'hk-1', source: 'healthkit', sourceBundleId: 'com.apple.health' });
  const result = resolveSessionConflict(existing, incoming);
  assert.equal(result.outcome, 'incoming_wins');
  assert.equal(result.survivorKey, 'hk-1');
  assert.equal(result.loserKey, 'whoop-1');
});

test('resolveSessionConflict: incoming whoop never beats existing healthkit -> existing wins', () => {
  const existing = candidate({ key: 'hk-1', source: 'healthkit' });
  const incoming = candidate({ key: 'whoop-1', source: 'whoop' });
  const result = resolveSessionConflict(existing, incoming);
  assert.equal(result.outcome, 'existing_wins');
  assert.equal(result.survivorKey, 'hk-1');
  assert.equal(result.loserKey, 'whoop-1');
});

test('resolveSessionConflict: equal-priority healthkit rows -> existing (already persisted) wins', () => {
  const existing = candidate({ key: 'hk-1', sourceBundleId: 'com.strava.run' });
  const incoming = candidate({ key: 'hk-2', sourceBundleId: 'com.strava.run' });
  const result = resolveSessionConflict(existing, incoming);
  assert.equal(result.outcome, 'existing_wins');
  assert.equal(result.survivorKey, 'hk-1');
});

test('resolveSessionConflict: an already-notified existing row is never demoted, even by a higher-priority incoming row', () => {
  const existing = candidate({ key: 'whoop-1', source: 'whoop', notified: true });
  const incoming = candidate({ key: 'hk-1', source: 'healthkit', sourceBundleId: 'com.apple.health' });
  const result = resolveSessionConflict(existing, incoming);
  assert.equal(result.outcome, 'existing_wins');
  assert.equal(result.survivorKey, 'whoop-1');
  assert.equal(result.loserKey, 'hk-1');
});

test("resolveSessionConflict: 'whoop' preference lets a WHOOP row beat an existing HealthKit row", () => {
  const existing = candidate({ key: 'hk-1', source: 'healthkit', sourceBundleId: 'com.apple.health' });
  const incoming = candidate({ key: 'whoop-1', source: 'whoop' });
  const result = resolveSessionConflict(existing, incoming, 'whoop');
  assert.equal(result.outcome, 'incoming_wins');
  assert.equal(result.survivorKey, 'whoop-1');
  assert.equal(result.loserKey, 'hk-1');
});

test("resolveSessionConflict: 'whoop' preference never demotes an already-notified existing HealthKit row", () => {
  const existing = candidate({ key: 'hk-1', source: 'healthkit', sourceBundleId: 'com.apple.health', notified: true });
  const incoming = candidate({ key: 'whoop-1', source: 'whoop' });
  const result = resolveSessionConflict(existing, incoming, 'whoop');
  assert.equal(result.outcome, 'existing_wins');
  assert.equal(result.survivorKey, 'hk-1');
  assert.equal(result.loserKey, 'whoop-1');
});

test('parseWorkoutWindow: parses a valid ISO startTime + durationMin', () => {
  const parsed = parseWorkoutWindow({ startTime: '2026-08-01T10:00:00.000Z', durationMin: 30 });
  assert.ok(parsed);
  assert.equal(parsed!.startedAt.toISOString(), '2026-08-01T10:00:00.000Z');
  assert.equal(parsed!.endedAt.toISOString(), '2026-08-01T10:30:00.000Z');
});

test('parseWorkoutWindow: missing durationMin stays null', () => {
  assert.equal(parseWorkoutWindow({ startTime: '2026-08-01T10:00:00.000Z' }), null);
});

test('parseWorkoutWindow: missing startTime stays null', () => {
  assert.equal(parseWorkoutWindow({ durationMin: 30 }), null);
});

test('parseWorkoutWindow: non-ISO startTime stays null', () => {
  assert.equal(parseWorkoutWindow({ startTime: 'not-a-date', durationMin: 30 }), null);
});

test('parseWorkoutWindow: zero or negative durationMin stays null', () => {
  assert.equal(parseWorkoutWindow({ startTime: '2026-08-01T10:00:00.000Z', durationMin: 0 }), null);
  assert.equal(parseWorkoutWindow({ startTime: '2026-08-01T10:00:00.000Z', durationMin: -5 }), null);
});

test('parseWorkoutWindow: non-object input stays null', () => {
  assert.equal(parseWorkoutWindow(null), null);
  assert.equal(parseWorkoutWindow('nope'), null);
  assert.equal(parseWorkoutWindow([1, 2]), null);
});
