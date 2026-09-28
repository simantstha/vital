import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSleepWrite, sleepOwnerSource } from './sleepOwnership';

test('sleepOwnerSource: null/undefined/whoop all mean WHOOP owns', () => {
  assert.equal(sleepOwnerSource(null), 'whoop');
  assert.equal(sleepOwnerSource(undefined), 'whoop');
  assert.equal(sleepOwnerSource('whoop'), 'whoop');
});

test('sleepOwnerSource: apple means HealthKit owns', () => {
  assert.equal(sleepOwnerSource('apple'), 'healthkit');
});

test('resolveSleepWrite: no persisted row -> incoming becomes primary, nothing to archive', () => {
  const decision = resolveSleepWrite({ persisted: null, incomingSource: 'whoop', preferredDevice: null });
  assert.deepEqual(decision, { action: 'primary', archivePersistedAsSecondary: false });
});

test('resolveSleepWrite: same source re-arriving is always a primary refresh', () => {
  const decision = resolveSleepWrite({
    persisted: { source: 'whoop', notified: false },
    incomingSource: 'whoop',
    preferredDevice: null,
  });
  assert.deepEqual(decision, { action: 'primary', archivePersistedAsSecondary: false });
});

test('resolveSleepWrite (null preference, current behavior): a HealthKit upsert never overwrites an existing WHOOP row -> secondary', () => {
  const decision = resolveSleepWrite({
    persisted: { source: 'whoop', notified: false },
    incomingSource: 'healthkit',
    preferredDevice: null,
  });
  assert.deepEqual(decision, { action: 'secondary', archivePersistedAsSecondary: false });
});

test('resolveSleepWrite (null preference): a WHOOP upsert takes over an existing not-yet-notified HealthKit row and archives it', () => {
  const decision = resolveSleepWrite({
    persisted: { source: 'healthkit', notified: false },
    incomingSource: 'whoop',
    preferredDevice: null,
  });
  assert.deepEqual(decision, { action: 'primary', archivePersistedAsSecondary: true });
});

test('resolveSleepWrite (null preference): a WHOOP upsert never un-sends a notification -> stored as secondary instead', () => {
  const decision = resolveSleepWrite({
    persisted: { source: 'healthkit', notified: true },
    incomingSource: 'whoop',
    preferredDevice: null,
  });
  assert.deepEqual(decision, { action: 'secondary', archivePersistedAsSecondary: false });
});

test("resolveSleepWrite ('apple' preference): symmetrically, HealthKit owns — WHOOP upsert never overwrites a HealthKit row", () => {
  const decision = resolveSleepWrite({
    persisted: { source: 'healthkit', notified: false },
    incomingSource: 'whoop',
    preferredDevice: 'apple',
  });
  assert.deepEqual(decision, { action: 'secondary', archivePersistedAsSecondary: false });
});

test("resolveSleepWrite ('apple' preference): HealthKit takes over an existing not-yet-notified WHOOP row and archives it", () => {
  const decision = resolveSleepWrite({
    persisted: { source: 'whoop', notified: false },
    incomingSource: 'healthkit',
    preferredDevice: 'apple',
  });
  assert.deepEqual(decision, { action: 'primary', archivePersistedAsSecondary: true });
});

test("resolveSleepWrite ('apple' preference): the already-notified rule still holds — a notified WHOOP row is never demoted", () => {
  const decision = resolveSleepWrite({
    persisted: { source: 'whoop', notified: true },
    incomingSource: 'healthkit',
    preferredDevice: 'apple',
  });
  assert.deepEqual(decision, { action: 'secondary', archivePersistedAsSecondary: false });
});
