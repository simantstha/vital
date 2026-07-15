import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateStreakDays, collectQualifyingDays } from './streak';

test('returns zero when neither today nor yesterday qualifies', () => {
  assert.equal(calculateStreakDays(new Set(['2026-07-10']), new Date('2026-07-14T12:00:00Z'), 'UTC'), 0);
});

test('counts a streak anchored on today and deduplicates repeated activity', () => {
  const days = new Set(['2026-07-14', '2026-07-14', '2026-07-13', '2026-07-12']);
  assert.equal(calculateStreakDays(days, new Date('2026-07-14T12:00:00Z'), 'UTC'), 3);
});

test('allows an active streak to be anchored on yesterday', () => {
  const days = new Set(['2026-07-13', '2026-07-12', '2026-07-11']);
  assert.equal(calculateStreakDays(days, new Date('2026-07-14T12:00:00Z'), 'UTC'), 3);
});

test('stops at the first gap and supports long streaks', () => {
  const days = new Set<string>();
  for (let day = 1; day <= 30; day += 1) days.add(`2026-06-${String(day).padStart(2, '0')}`);
  days.delete('2026-06-20');
  assert.equal(calculateStreakDays(days, new Date('2026-06-30T12:00:00Z'), 'UTC'), 10);
});

test('uses the requested timezone at a UTC date boundary', () => {
  const now = new Date('2026-07-14T01:00:00Z');
  const days = new Set(['2026-07-14', '2026-07-13']);
  assert.equal(calculateStreakDays(days, now, 'America/Chicago'), 1);
  assert.equal(calculateStreakDays(days, now, 'UTC'), 2);
});

test('walks local calendar days across daylight-saving transitions', () => {
  const days = new Set(['2026-03-09', '2026-03-08', '2026-03-07']);
  assert.equal(
    calculateStreakDays(days, new Date('2026-03-09T17:00:00Z'), 'America/Chicago'),
    3,
  );
});

test('collects only meaningful activity and deduplicates local days', () => {
  const days = collectQualifyingDays({
    timeZone: 'America/Chicago',
    events: [
      { type: 'meal_logged', timestamp: new Date('2026-07-14T02:00:00Z') },
      { type: 'workout_completed', timestamp: new Date('2026-07-13T18:00:00Z') },
      { type: 'hrv_reading', timestamp: new Date('2026-07-14T18:00:00Z') },
    ],
    dailyMetrics: [
      { date: '2026-07-12', metric: 'workouts', value: 1 },
      { date: '2026-07-11', metric: 'workouts', value: 0 },
      { date: '2026-07-10', metric: 'sleep_minutes', value: 480 },
    ],
    messages: [
      { role: 'user', timestamp: new Date('2026-07-14T15:00:00Z') },
      { role: 'assistant', timestamp: new Date('2026-07-10T15:00:00Z') },
    ],
    planItems: [
      { localDay: '2026-07-09', status: 'done' },
      { localDay: '2026-07-08', status: 'pending' },
    ],
  });

  assert.deepEqual([...days].sort(), ['2026-07-09', '2026-07-12', '2026-07-13', '2026-07-14']);
});

test('undoing the only completed plan item removes that qualifying day', () => {
  const done = collectQualifyingDays({
    timeZone: 'UTC', events: [], dailyMetrics: [], messages: [],
    planItems: [{ localDay: '2026-07-14', status: 'done' }],
  });
  const undone = collectQualifyingDays({
    timeZone: 'UTC', events: [], dailyMetrics: [], messages: [],
    planItems: [{ localDay: '2026-07-14', status: 'pending' }],
  });

  assert.equal(calculateStreakDays(done, new Date('2026-07-14T12:00:00Z'), 'UTC'), 1);
  assert.equal(calculateStreakDays(undone, new Date('2026-07-14T12:00:00Z'), 'UTC'), 0);
});
