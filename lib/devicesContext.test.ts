import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDevicePatch, resolvePrimaryDevices } from './devicesContext';

// ── resolvePrimaryDevices ───────────────────────────────────────────────────

test('resolvePrimaryDevices: all-null explicit, WHOOP not connected -> apple everywhere', () => {
  const resolved = resolvePrimaryDevices({ workouts: null, sleep: null, recovery: null }, false);
  assert.deepEqual(resolved, { workouts: 'apple', sleep: 'apple', recovery: 'apple' });
});

test('resolvePrimaryDevices: all-null explicit, WHOOP connected -> workouts still apple, sleep/recovery whoop', () => {
  const resolved = resolvePrimaryDevices({ workouts: null, sleep: null, recovery: null }, true);
  assert.deepEqual(resolved, { workouts: 'apple', sleep: 'whoop', recovery: 'whoop' });
});

test('resolvePrimaryDevices: an explicit override always wins outright, regardless of connection', () => {
  const resolved = resolvePrimaryDevices({ workouts: 'whoop', sleep: 'apple', recovery: 'apple' }, false);
  assert.deepEqual(resolved, { workouts: 'whoop', sleep: 'apple', recovery: 'apple' });
});

test('resolvePrimaryDevices: mixed explicit/auto', () => {
  const resolved = resolvePrimaryDevices({ workouts: 'whoop', sleep: null, recovery: null }, true);
  assert.deepEqual(resolved, { workouts: 'whoop', sleep: 'whoop', recovery: 'whoop' });
});

// ── parseDevicePatch ─────────────────────────────────────────────────────────

test('parseDevicePatch: a full valid body parses every key', () => {
  const parsed = parseDevicePatch({ primary: { workouts: 'whoop', sleep: 'apple', recovery: null } });
  assert.deepEqual(parsed, { workouts: 'whoop', sleep: 'apple', recovery: null });
});

test('parseDevicePatch: a partial body only includes the keys present', () => {
  const parsed = parseDevicePatch({ primary: { sleep: 'whoop' } });
  assert.deepEqual(parsed, { sleep: 'whoop' });
});

test('parseDevicePatch: null resets a preference to auto', () => {
  const parsed = parseDevicePatch({ primary: { workouts: null } });
  assert.deepEqual(parsed, { workouts: null });
});

test('parseDevicePatch: rejects a non-object body', () => {
  assert.equal(parseDevicePatch(null), null);
  assert.equal(parseDevicePatch('nope'), null);
  assert.equal(parseDevicePatch([1, 2]), null);
});

test('parseDevicePatch: rejects a missing or malformed `primary` key', () => {
  assert.equal(parseDevicePatch({}), null);
  assert.equal(parseDevicePatch({ primary: null }), null);
  assert.equal(parseDevicePatch({ primary: 'apple' }), null);
});

test('parseDevicePatch: rejects an invalid device value strictly', () => {
  assert.equal(parseDevicePatch({ primary: { workouts: 'garmin' } }), null);
  assert.equal(parseDevicePatch({ primary: { workouts: 1 } }), null);
  assert.equal(parseDevicePatch({ primary: { workouts: undefined } }), null); // key present but undefined has no valid effect -> no valid key set
});

test('parseDevicePatch: an empty `primary` object (no keys at all) is rejected', () => {
  assert.equal(parseDevicePatch({ primary: {} }), null);
});

test('parseDevicePatch: unknown extra keys inside primary are ignored, not rejected', () => {
  const parsed = parseDevicePatch({ primary: { workouts: 'apple', bogus: 'x' } });
  assert.deepEqual(parsed, { workouts: 'apple' });
});
