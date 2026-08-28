import assert from 'node:assert/strict';
import test from 'node:test';

import { localDayKey, localHour, previousDayKey } from './localDay';

test('previousDayKey rolls back across a year boundary', () => {
  assert.equal(previousDayKey('2026-01-01'), '2025-12-31');
});

test('previousDayKey rolls back across a month boundary', () => {
  assert.equal(previousDayKey('2026-03-01'), '2026-02-28');
});

test('previousDayKey does not skip a day on a US spring-forward date', () => {
  // Calendar arithmetic, not `Date` minus 24h — subtracting 24h from a Date
  // on this date would land on the same local day again in a DST-observing
  // zone, which is exactly the bug this function exists to avoid.
  assert.equal(previousDayKey('2026-03-09'), '2026-03-08');
});

test('localHour reads the hour in the given timezone', () => {
  // 2026-07-15T02:00:00Z is 2026-07-14T21:00 in America/Chicago (UTC-5, CDT).
  assert.equal(localHour(new Date('2026-07-15T02:00:00Z'), 'America/Chicago'), 21);
});

test('localHour returns 0 (not 24) at local midnight', () => {
  // 2026-07-15T05:00:00Z is 2026-07-15T00:00 in America/Chicago (UTC-5, CDT).
  // This guards hourCycle: 'h23' — hour12: false renders midnight as "24" on
  // some ICU builds, which would silently break callers expecting 0-23.
  assert.equal(localHour(new Date('2026-07-15T05:00:00Z'), 'America/Chicago'), 0);
});

test('localHour falls back to UTC hours when tz is missing', () => {
  const d = new Date('2026-07-15T05:00:00Z');
  assert.equal(localHour(d, undefined), d.getUTCHours());
});

test('localHour falls back to UTC hours when tz is invalid', () => {
  const d = new Date('2026-07-15T05:00:00Z');
  assert.equal(localHour(d, 'Not/AZone'), d.getUTCHours());
});

// Several modules depend on the null/invalid-tz path of localDayKey being
// character-identical to the old `.toISOString().split('T')[0]` behavior —
// this pins that backward-compatibility contract so it can't regress silently.
test('localDayKey matches the legacy toISOString().split("T")[0] behavior when tz is absent or invalid', () => {
  const d = new Date('2026-07-15T05:00:00Z');
  assert.equal(localDayKey(d, undefined), d.toISOString().split('T')[0]);
  assert.equal(localDayKey(d, null), d.toISOString().split('T')[0]);
  assert.equal(localDayKey(d, 'Not/AZone'), d.toISOString().split('T')[0]);
});
