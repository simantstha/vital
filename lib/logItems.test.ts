import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapDailySleepRow,
  mapEventToLogItem,
  mapHealthKitWorkout,
  sortLogItemsNewestFirst,
} from './logItems';

test('maps sleep minutes to a stable wake-date sleep session', () => {
  assert.deepEqual(
    mapDailySleepRow({ date: '2026-07-14', value: 451.5 }),
    {
      id: 'sleep-2026-07-14',
      type: 'sleep_session',
      timestamp: '2026-07-14T12:00:00.000Z',
      title: 'Sleep: 7h 31m',
      subtitle: 'Sleep tracked',
      sleepMs: 27_090_000,
      hasExactTime: false,
    },
  );
});

test('normalizes exact workout start times and sorts same-day workouts by their real instants', () => {
  const earlier = mapHealthKitWorkout({
    date: '2026-07-14',
    hkUuid: 'earlier',
    type: 'cycling',
    durationMin: 30,
    startTime: '2026-07-14T07:15:00-05:00',
  }, 0);
  const later = mapHealthKitWorkout({
    date: '2026-07-14',
    hkUuid: 'later',
    type: 'running',
    durationMin: 45,
    startTime: '2026-07-14T18:30:00-05:00',
  }, 1);

  assert.deepEqual(earlier, {
    id: 'earlier',
    type: 'workout_completed',
    timestamp: '2026-07-14T12:15:00.000Z',
    title: 'Cycling — 30 min',
    subtitle: 'Workout logged',
    hasExactTime: true,
  });
  assert.deepEqual(later, {
    id: 'later',
    type: 'workout_completed',
    timestamp: '2026-07-14T23:30:00.000Z',
    title: 'Running — 45 min',
    subtitle: 'Workout logged',
    hasExactTime: true,
  });
  assert.deepEqual(
    sortLogItemsNewestFirst([earlier, later]).map((item) => item.timestamp),
    ['2026-07-14T23:30:00.000Z', '2026-07-14T12:15:00.000Z'],
  );
});

test('uses an inexact noon anchor for missing and invalid workout start times', () => {
  for (const startTime of [undefined, 'not-a-date', '2026-07-13', '2026-02-30T08:00:00Z']) {
    const item = mapHealthKitWorkout({
      date: '2026-07-13',
      hkUuid: 'legacy',
      type: 'strength',
      startTime,
    }, 0);

    assert.deepEqual(item, {
      id: 'legacy',
      type: 'workout_completed',
      timestamp: '2026-07-13T12:00:00.000Z',
      title: 'Strength',
      subtitle: 'Workout logged',
      hasExactTime: false,
    });
  }
});

test('maps legacy events without changing identity, formatting, or optional fields', () => {
  assert.deepEqual(mapEventToLogItem({
    id: 'meal-event',
    type: 'meal_logged',
    timestamp: new Date('2026-07-14T20:00:00.000Z'),
    payload: {
      description: 'Dinner',
      kcal: 700.4,
      c: 50,
      p: 40,
      imageThumb: 'https://example.com/meal.jpg',
    },
  }), {
    id: 'meal-event',
    type: 'meal_logged',
    timestamp: '2026-07-14T20:00:00.000Z',
    title: 'Dinner · 700 kcal',
    subtitle: '50g carbs · 40g protein',
    imageThumb: 'https://example.com/meal.jpg',
    kcal: 700,
  });

  assert.deepEqual(mapEventToLogItem({
    id: 'workout-event',
    type: 'workout_completed',
    timestamp: new Date('2026-07-14T18:00:00.000Z'),
    payload: { type: 'running', distance_m: 5_250, calories: 410, avg_hr: 145 },
  }), {
    id: 'workout-event',
    type: 'workout_completed',
    timestamp: '2026-07-14T18:00:00.000Z',
    title: 'Running — 5.3 km',
    subtitle: '~410 kcal · avg 145 bpm',
    km: 5.25,
  });

  assert.deepEqual(mapEventToLogItem({
    id: 'sleep-event',
    type: 'sleep_session',
    timestamp: new Date('2026-07-14T13:00:00.000Z'),
    payload: { duration_s: 28_800, efficiency: 92, rhr: 52 },
  }), {
    id: 'sleep-event',
    type: 'sleep_session',
    timestamp: '2026-07-14T13:00:00.000Z',
    title: 'Sleep: 8h 00m',
    subtitle: '92% efficiency · RHR 52 bpm',
    sleepMs: 28_800_000,
  });
});
