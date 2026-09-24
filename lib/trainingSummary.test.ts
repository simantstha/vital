import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

/**
 * Drives the real `resolveTrainingSummary` against a fake `@/db` (plan_items
 * + workout_sets — also exercises the real, unmocked lib/workoutRepository.ts
 * against the same fake) and a fake `@/lib/brain/tools` (queryWorkouts, so
 * this doesn't need to satisfy that module's many other imports). Same
 * pattern as app/api/trends/route.test.ts and lib/workoutRepository.test.ts.
 * mock.module() must run before ./trainingSummary is first imported;
 * node:test isolates each test file in its own subprocess.
 */

interface FakeWorkoutSet {
  session_id: string;
  set_index: number;
  exercise: string;
  exercise_display: string;
  local_day: string;
  performed_at: Date;
  reps: number;
  load_kg: number | null;
  is_warmup: boolean;
}

const state: {
  planRows: Array<{ local_day: string }>;
  sets: FakeWorkoutSet[];
  workouts: Array<{ date: string; distanceM?: number; [key: string]: unknown }>;
} = { planRows: [], sets: [], workouts: [] };

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.plan_items) {
        return { where: async () => state.planRows };
      }
      if (table === realSchema.workout_sets) {
        const chain = {
          where: () => ({
            orderBy: (..._order: unknown[]) => {
              const rows = Promise.resolve(state.sets) as Promise<FakeWorkoutSet[]> & { limit: (n: number) => Promise<FakeWorkoutSet[]> };
              rows.limit = async (n: number) => state.sets.slice(0, n);
              return rows;
            },
          }),
        };
        return chain;
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/tools', {
  namedExports: {
    queryWorkouts: async (_userId: string, _days: number) => state.workouts,
  },
});

const modPromise = import('./trainingSummary');

function reset(): void {
  state.planRows = [];
  state.sets = [];
  state.workouts = [];
}

// Wednesday 2026-09-23 -> local week Mon 2026-09-21 .. Sun 2026-09-27.
const TODAY = '2026-09-23';
const WEEK_START = '2026-09-21';

test('empty user: nulls and zeros where honest, never guessed', async () => {
  reset();
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.week.start, WEEK_START);
  assert.equal(summary.week.plannedSessions, null, 'no plan data at all -> null, not 0');
  assert.equal(summary.week.completedSessions, 0, 'no logged sets -> honestly 0, not null');
  assert.equal(summary.week.days.length, 7);
  assert.ok(summary.week.days.every(d => d.planned === false && d.completed === false));

  assert.equal(summary.volume.unit, 'km');
  assert.equal(summary.volume.done, null, 'no workouts with distance -> null, not 0');
  assert.equal(summary.volume.target, null, 'no plan/goal defines a target in this schema');

  assert.equal(summary.lastLift, null);
});

test('plannedSessions: counts distinct days with a move plan item; days[] dots line up', async () => {
  reset();
  state.planRows = [{ local_day: '2026-09-22' }, { local_day: '2026-09-24' }];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.week.plannedSessions, 2);
  const byDate = new Map(summary.week.days.map(d => [d.date, d]));
  assert.equal(byDate.get('2026-09-22')?.planned, true);
  assert.equal(byDate.get('2026-09-24')?.planned, true);
  assert.equal(byDate.get('2026-09-21')?.planned, false);
});

test('completedSessions: counts distinct local days with a logged non-warmup set', async () => {
  reset();
  state.sets = [
    { session_id: 's1', set_index: 1, exercise: 'squat', exercise_display: 'Squat', local_day: '2026-09-22', performed_at: new Date('2026-09-22T18:00:00Z'), reps: 5, load_kg: 100, is_warmup: false },
    { session_id: 's2', set_index: 1, exercise: 'row', exercise_display: 'Row', local_day: '2026-09-22', performed_at: new Date('2026-09-22T19:00:00Z'), reps: 8, load_kg: 40, is_warmup: false },
    { session_id: 's3', set_index: 1, exercise: 'bench', exercise_display: 'Bench', local_day: '2026-09-25', performed_at: new Date('2026-09-25T18:00:00Z'), reps: 5, load_kg: 80, is_warmup: true },
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  // Two sessions same day -> one completed day (09-22); the only 09-25 set is
  // a warmup, so that day is not completed.
  assert.equal(summary.week.completedSessions, 1);
  const byDate = new Map(summary.week.days.map(d => [d.date, d]));
  assert.equal(byDate.get('2026-09-22')?.completed, true);
  assert.equal(byDate.get('2026-09-25')?.completed, false);
});

test('completedSessions: a run-only week (no workout_sets at all) still counts from HealthKit workouts', async () => {
  reset();
  state.workouts = [
    { date: '2026-09-23', type: 'run', durationMin: 35, distanceM: 5000 },
    { date: '2026-09-26', type: 'run', durationMin: 40, distanceM: 6000 },
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.week.completedSessions, 2, 'a marathoner who ran twice this week is not reported as 0');
  const byDate = new Map(summary.week.days.map(d => [d.date, d]));
  assert.equal(byDate.get('2026-09-23')?.completed, true);
  assert.equal(byDate.get('2026-09-26')?.completed, true);
  assert.equal(byDate.get('2026-09-24')?.completed, false);
});

test('completedSessions: a day with both a strength session and a run counts once', async () => {
  reset();
  state.sets = [
    { session_id: 's1', set_index: 1, exercise: 'squat', exercise_display: 'Squat', local_day: '2026-09-22', performed_at: new Date('2026-09-22T08:00:00Z'), reps: 5, load_kg: 100, is_warmup: false },
  ];
  state.workouts = [
    { date: '2026-09-22', type: 'run', durationMin: 30, distanceM: 5000 },
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.week.completedSessions, 1, 'union, not a sum, of the two signals for the same day');
  assert.equal(summary.week.days.find(d => d.date === '2026-09-22')?.completed, true);
});

test('completedSessions: a HealthKit workout from a prior week is excluded', async () => {
  reset();
  state.workouts = [
    { date: '2026-09-14', type: 'run', durationMin: 30, distanceM: 5000 }, // the Monday before this week
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.week.completedSessions, 0);
  assert.ok(summary.week.days.every(d => d.completed === false));
});

test('completedSessions: a trivial (<10min) HealthKit workout does not count', async () => {
  reset();
  state.workouts = [
    { date: '2026-09-23', type: 'walk', durationMin: 5, distanceM: 300 },
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.week.completedSessions, 0, 'a 5-minute auto-detected blip should not light up a training dot');
  assert.equal(summary.week.days.find(d => d.date === '2026-09-23')?.completed, false);
});

test('completedSessions: a HealthKit workout with no duration field at all still counts (never hides real activity)', async () => {
  reset();
  state.workouts = [
    { date: '2026-09-23', type: 'run', distanceM: 5000 }, // no durationMin
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.week.completedSessions, 1);
});

test('volume: sums only workouts carrying a distance reading, within the local week', async () => {
  reset();
  state.workouts = [
    { date: '2026-09-22', type: 'run', distanceM: 5000 },
    { date: '2026-09-24', type: 'run', distanceM: 10000 },
    { date: '2026-09-25', type: 'strength' }, // no distanceM at all
    { date: '2026-09-14', type: 'run', distanceM: 99000 }, // last week — excluded
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.equal(summary.volume.done, 15, '5km + 10km, the strength+no-distance and prior-week runs excluded');
});

test('lastLift: passed through from the most recent logged session', async () => {
  reset();
  state.sets = [
    { session_id: 's1', set_index: 1, exercise: 'deadlift', exercise_display: 'Deadlift', local_day: '2026-09-22', performed_at: new Date('2026-09-22T18:00:00Z'), reps: 5, load_kg: 140, is_warmup: false },
    { session_id: 's1', set_index: 2, exercise: 'deadlift', exercise_display: 'Deadlift', local_day: '2026-09-22', performed_at: new Date('2026-09-22T18:05:00Z'), reps: 5, load_kg: 150, is_warmup: false },
  ];
  const { resolveTrainingSummary } = await modPromise;
  const summary = await resolveTrainingSummary('user-1', TODAY);

  assert.deepEqual(summary.lastLift, {
    exercise: 'Deadlift',
    date:     '2026-09-22',
    sets:     2,
    reps:     5,
    weightKg: 150,
  });
});
