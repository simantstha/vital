import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

/**
 * `@/db` must be mocked before this module's first import — same constraint
 * documented in app/api/today/route.test.ts and app/api/logs/route.test.ts
 * (db/index.ts throws at import time without DATABASE_URL, which CI's `npm
 * test` step deliberately doesn't set — see .github/workflows/pr-checks.yml).
 */

interface FakeRow {
  session_id: string;
  set_index: number;
  [key: string]: unknown;
}

const state: { sets: FakeRow[] } = { sets: [] };
const upserts: FakeRow[] = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table !== realSchema.workout_sets) {
        throw new Error(`unexpected table in select().from(): ${String(table)}`);
      }
      // Supports both call shapes used by the repository:
      //   .where(...).orderBy(...).limit(...)   (getExerciseHistory / getLastSessionForExercise's first query)
      //   .where(...).orderBy(...)               (getSetsSince / getLastSessionForExercise's second query)
      const chain = {
        where: (_cond: unknown) => ({
          orderBy: (..._order: unknown[]) => {
            const rows = Promise.resolve(state.sets) as Promise<FakeRow[]> & { limit: (n: number) => Promise<FakeRow[]> };
            rows.limit = async (n: number) => state.sets.slice(0, n);
            return rows;
          },
        }),
      };
      return chain;
    },
  }),
  insert: (table: unknown) => {
    if (table !== realSchema.workout_sets) {
      throw new Error(`unexpected table in insert(): ${String(table)}`);
    }
    return {
      values: (rows: FakeRow[]) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            for (const row of rows) upserts.push(row);
            return rows;
          },
        }),
      }),
    };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const repoPromise = import('./workoutRepository');

// ── Pure aggregation ─────────────────────────────────────────────────────────

test('estimateOneRepMax: Epley formula', async () => {
  const { estimateOneRepMax } = await repoPromise;
  assert.equal(estimateOneRepMax(100, 1), 100);
  assert.equal(Math.round(estimateOneRepMax(100, 5) * 100) / 100, 116.67);
  assert.equal(estimateOneRepMax(100, 0), 0);
});

test('weekStartKey: buckets to the Monday of the containing week (UTC)', async () => {
  const { weekStartKey } = await repoPromise;
  assert.equal(weekStartKey(new Date('2026-09-22T12:00:00Z')), '2026-09-21'); // Tuesday -> Monday
  assert.equal(weekStartKey(new Date('2026-09-21T00:00:00Z')), '2026-09-21'); // Monday -> itself
  assert.equal(weekStartKey(new Date('2026-09-27T23:59:00Z')), '2026-09-21'); // Sunday -> previous Monday
});

test('summarizeProgression: best e1RM and volume per exercise per week', async () => {
  const { summarizeProgression } = await repoPromise;
  const sets = [
    { exercise: 'squat', performed_at: new Date('2026-09-21T10:00:00Z'), reps: 5, load_kg: 100, is_warmup: false },
    { exercise: 'squat', performed_at: new Date('2026-09-21T10:05:00Z'), reps: 5, load_kg: 105, is_warmup: false },
    { exercise: 'squat', performed_at: new Date('2026-09-23T10:00:00Z'), reps: 3, load_kg: 110, is_warmup: false },
    { exercise: 'squat', performed_at: new Date('2026-09-28T10:00:00Z'), reps: 5, load_kg: 115, is_warmup: false }, // next week
  ];

  const summary = summarizeProgression(sets);
  assert.ok(summary.squat);
  assert.equal(summary.squat.length, 2);

  const week1 = summary.squat[0];
  assert.equal(week1.weekStart, '2026-09-21');
  assert.equal(week1.totalSets, 3);
  assert.equal(week1.totalReps, 13);
  assert.equal(week1.volumeKg, 5 * 100 + 5 * 105 + 3 * 110);
  // best e1RM across the week's sets: 100x5=116.67, 105x5=122.5, 110x3=121 -> 122.5 wins
  assert.equal(week1.bestEstimatedOneRepMaxKg, 122.5);

  const week2 = summary.squat[1];
  assert.equal(week2.weekStart, '2026-09-28');
  assert.equal(week2.totalSets, 1);
});

test('summarizeProgression: warmup sets are excluded from volume and 1RM', async () => {
  const { summarizeProgression } = await repoPromise;
  const sets = [
    { exercise: 'bench press', performed_at: new Date('2026-09-21T10:00:00Z'), reps: 10, load_kg: 40, is_warmup: true },
    { exercise: 'bench press', performed_at: new Date('2026-09-21T10:05:00Z'), reps: 5, load_kg: 90, is_warmup: false },
  ];
  const summary = summarizeProgression(sets);
  assert.equal(summary['bench press'][0].totalSets, 1);
  assert.equal(summary['bench press'][0].volumeKg, 5 * 90);
});

test('summarizeProgression: bodyweight sets count toward reps but not volume/1RM', async () => {
  const { summarizeProgression } = await repoPromise;
  const sets = [
    { exercise: 'pull-up', performed_at: new Date('2026-09-21T10:00:00Z'), reps: 10, load_kg: null, is_warmup: false },
    { exercise: 'pull-up', performed_at: new Date('2026-09-21T10:05:00Z'), reps: 8, load_kg: null, is_warmup: false },
  ];
  const summary = summarizeProgression(sets);
  assert.equal(summary['pull-up'][0].totalSets, 2);
  assert.equal(summary['pull-up'][0].totalReps, 18);
  assert.equal(summary['pull-up'][0].volumeKg, 0);
  assert.equal(summary['pull-up'][0].bestEstimatedOneRepMaxKg, null);
});

test('summarizeProgression: separate exercises stay separate', async () => {
  const { summarizeProgression } = await repoPromise;
  const sets = [
    { exercise: 'squat', performed_at: new Date('2026-09-21T10:00:00Z'), reps: 5, load_kg: 100, is_warmup: false },
    { exercise: 'deadlift', performed_at: new Date('2026-09-21T10:00:00Z'), reps: 5, load_kg: 140, is_warmup: false },
  ];
  const summary = summarizeProgression(sets);
  assert.equal(Object.keys(summary).sort().join(','), 'deadlift,squat');
});

// ── DB-backed (mocked) ───────────────────────────────────────────────────────

test('logWorkoutSession: writes one row per set, keyed by session_id + set_index', async () => {
  const { logWorkoutSession } = await repoPromise;
  upserts.length = 0;

  await logWorkoutSession({
    userId: 'user-1',
    sessionId: 'session-abc',
    performedAt: new Date('2026-09-22T18:00:00Z'),
    timezone: 'UTC',
    source: 'coach',
    sets: [
      { exercise: 'squat', exerciseDisplay: 'Squat', setIndex: 1, reps: 5, loadKg: 102.06, rpe: null },
      { exercise: 'squat', exerciseDisplay: 'Squat', setIndex: 2, reps: 5, loadKg: 102.06, rpe: null },
    ],
  });

  assert.equal(upserts.length, 2);
  assert.equal(upserts[0].session_id, 'session-abc');
  assert.equal(upserts[0].set_index, 1);
  assert.equal(upserts[0].local_day, '2026-09-22');
  assert.equal(upserts[1].set_index, 2);
});

test('logWorkoutSession: no-op for an empty set list', async () => {
  const { logWorkoutSession } = await repoPromise;
  upserts.length = 0;
  const result = await logWorkoutSession({
    userId: 'user-1',
    sessionId: 'session-empty',
    performedAt: new Date(),
    timezone: 'UTC',
    source: 'manual',
    sets: [],
  });
  assert.deepEqual(result, []);
  assert.equal(upserts.length, 0);
});

test('getExerciseHistory: returns rows from the mocked query', async () => {
  const { getExerciseHistory } = await repoPromise;
  state.sets = [
    { id: '1', session_id: 's1', set_index: 1, exercise: 'squat', reps: 5, load_kg: 100 } as FakeRow,
  ];
  const rows = await getExerciseHistory('user-1', 'squat');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exercise, 'squat');
});

test('getLastSessionForExercise: returns [] when nothing is logged', async () => {
  const { getLastSessionForExercise } = await repoPromise;
  state.sets = [];
  const rows = await getLastSessionForExercise('user-1', 'squat');
  assert.deepEqual(rows, []);
});

// ── completedLocalDays ───────────────────────────────────────────────────────

test('completedLocalDays: distinct local days with at least one non-warmup set', async () => {
  const { completedLocalDays } = await repoPromise;
  const days = completedLocalDays([
    { local_day: '2026-09-21', is_warmup: false },
    { local_day: '2026-09-21', is_warmup: false }, // same day, second set
    { local_day: '2026-09-22', is_warmup: true },  // warmup-only day doesn't count
    { local_day: '2026-09-23', is_warmup: false },
  ] as never);
  assert.deepEqual([...days].sort(), ['2026-09-21', '2026-09-23']);
});

test('completedLocalDays: empty input -> empty set (never guessed)', async () => {
  const { completedLocalDays } = await repoPromise;
  assert.equal(completedLocalDays([]).size, 0);
});

// ── pickTopSet / computeLastLift ─────────────────────────────────────────────

test('pickTopSet: the heaviest-load set wins', async () => {
  const { pickTopSet } = await repoPromise;
  const top = pickTopSet([
    { reps: 5, load_kg: 100 },
    { reps: 3, load_kg: 120 },
    { reps: 8, load_kg: 80 },
  ]);
  assert.equal(top?.load_kg, 120);
});

test('pickTopSet: bodyweight-only sets (all null load) keep the first set', async () => {
  const { pickTopSet } = await repoPromise;
  const sets = [{ reps: 10, load_kg: null }, { reps: 8, load_kg: null }];
  assert.equal(pickTopSet(sets), sets[0]);
});

test('pickTopSet: empty input returns undefined', async () => {
  const { pickTopSet } = await repoPromise;
  assert.equal(pickTopSet([]), undefined);
});

test('computeLastLift: reports the top set of the given session/exercise sets', async () => {
  const { computeLastLift } = await repoPromise;
  const lift = computeLastLift([
    { exercise_display: 'Bench Press', local_day: '2026-09-21', reps: 5, load_kg: 80 },
    { exercise_display: 'Bench Press', local_day: '2026-09-21', reps: 5, load_kg: 85 },
    { exercise_display: 'Bench Press', local_day: '2026-09-21', reps: 3, load_kg: 90 },
  ] as never);
  assert.deepEqual(lift, {
    exercise: 'Bench Press',
    date:     '2026-09-21',
    sets:     3,
    reps:     3,
    weightKg: 90,
  });
});

test('computeLastLift: bodyweight lift reports weightKg null, not zero or guessed', async () => {
  const { computeLastLift } = await repoPromise;
  const lift = computeLastLift([
    { exercise_display: 'Pull-up', local_day: '2026-09-21', reps: 10, load_kg: null },
  ] as never);
  assert.equal(lift?.weightKg, null);
});

test('computeLastLift: null when nothing was logged', async () => {
  const { computeLastLift } = await repoPromise;
  assert.equal(computeLastLift([]), null);
});

// ── getLastLift (DB-backed) ──────────────────────────────────────────────────
// The shared fakeDb above doesn't filter by `.where()` condition (see its
// header comment), so this exercises getLastLift's composition
// (getMostRecentWorkingSet -> getSessionExerciseSets -> computeLastLift)
// against a fixture that already represents a single session/exercise, the
// same way the other DB-backed tests in this file work around that limit.

test('getLastLift: returns null when the user has never logged a set', async () => {
  const { getLastLift } = await repoPromise;
  state.sets = [];
  assert.equal(await getLastLift('user-1'), null);
});

test('getLastLift: builds the lastLift card from the most recent session', async () => {
  const { getLastLift } = await repoPromise;
  state.sets = [
    {
      session_id: 's1', set_index: 1, exercise: 'squat', exercise_display: 'Squat',
      local_day: '2026-09-22', performed_at: new Date('2026-09-22T18:00:00Z'),
      reps: 5, load_kg: 100, is_warmup: false,
    } as FakeRow,
    {
      session_id: 's1', set_index: 2, exercise: 'squat', exercise_display: 'Squat',
      local_day: '2026-09-22', performed_at: new Date('2026-09-22T18:05:00Z'),
      reps: 5, load_kg: 105, is_warmup: false,
    } as FakeRow,
  ];
  const lift = await getLastLift('user-1');
  assert.deepEqual(lift, {
    exercise: 'Squat',
    date:     '2026-09-22',
    sets:     2,
    reps:     5,
    weightKg: 105,
  });
});
