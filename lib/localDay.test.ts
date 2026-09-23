import assert from 'node:assert/strict';
import test from 'node:test';

import { localDayKey, localHour, previousDayKey, weekDayKeys, weekStartKeyForDay } from './localDay';

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

test('weekStartKeyForDay: Monday maps to itself', () => {
  assert.equal(weekStartKeyForDay('2026-09-21'), '2026-09-21');
});

test('weekStartKeyForDay: Sunday maps to the Monday that started its own week', () => {
  assert.equal(weekStartKeyForDay('2026-09-27'), '2026-09-21');
});

test('weekDayKeys: Monday..Sunday for the given week start', () => {
  assert.deepEqual(weekDayKeys('2026-09-21'), [
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24',
    '2026-09-25', '2026-09-26', '2026-09-27',
  ]);
});

// A Sunday-night workout in the user's local zone must land in the week that
// is ending, not the Monday of the following week — the whole reason
// week-bucketing goes through localDayKey → weekStartKeyForDay on the local
// day key, never on the raw UTC instant.
test('week boundary: a Sunday-night local workout counts in the week that is ending, not the next one', () => {
  // 2026-09-28T02:30:00Z is Sunday 2026-09-27 21:30 in America/Chicago (UTC-5, CDT) —
  // late Sunday night locally, but already Monday in UTC.
  const loggedAt = new Date('2026-09-28T02:30:00Z');
  const tz = 'America/Chicago';

  const localDay = localDayKey(loggedAt, tz);
  assert.equal(localDay, '2026-09-27', 'the workout is on the local Sunday, not the UTC Monday');

  const weekStart = weekStartKeyForDay(localDay);
  assert.equal(weekStart, '2026-09-21', 'it belongs to the week that started the previous Monday');
  assert.ok(weekDayKeys(weekStart).includes(localDay));
  assert.ok(!weekDayKeys('2026-09-28').includes(localDay), 'not the following week');
});
