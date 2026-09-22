import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

/**
 * `@/db` must be mocked before the route module's first import (same
 * constraint as app/api/meals/log/route.test.ts and app/api/today/route.test.ts).
 * The route reads `schema.users` (timezone lookup) directly and writes
 * `schema.workout_sets` via lib/workoutRepository.ts's logWorkoutSession —
 * both go through this one fake `db`.
 */

const state: { userRow: Record<string, unknown> | undefined } = {
  userRow: { id: 'user-1', timezone: 'America/Chicago' },
};
const upserts: Array<Record<string, unknown>> = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => (state.userRow ? [state.userRow] : []) }) };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
  insert: (table: unknown) => {
    if (table !== realSchema.workout_sets) {
      throw new Error(`unexpected table in insert(): ${String(table)}`);
    }
    return {
      values: (rows: Array<Record<string, unknown>>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            for (const row of rows) upserts.push(row);
            return rows.map((r, i) => ({ id: `set-${i}`, created_at: new Date(), ...r }));
          },
        }),
      }),
    };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function req(body: unknown, headers: Record<string, string> = { 'x-user-id': 'user-1' }): Request {
  return new Request('http://local/api/workouts/sets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST 401s without an x-user-id header', async () => {
  const { POST } = await routePromise;
  const response = await POST(req({ sessionId: 's1', source: 'manual', sets: [{ exercise: 'squat', reps: 5 }] }, {}));
  assert.equal(response.status, 401);
});

test('POST 400s on a malformed body', async () => {
  const { POST } = await routePromise;
  const response = await POST(req({ sessionId: '', source: 'manual', sets: [] }));
  assert.equal(response.status, 400);
});

test('POST 400s on an invalid source', async () => {
  const { POST } = await routePromise;
  const response = await POST(req({ sessionId: 's1', source: 'bogus', sets: [{ exercise: 'squat', reps: 5 }] }));
  assert.equal(response.status, 400);
});

test('POST logs a session of sets and echoes them back', async () => {
  const { POST } = await routePromise;
  upserts.length = 0;

  const response = await POST(req({
    sessionId: 'session-1',
    source: 'coach',
    sets: [
      { exercise: 'Squat', reps: 5, loadKg: 102.06 },
      { exercise: 'Squat', reps: 5, loadKg: 102.06 },
      { exercise: 'Squat', reps: 5, loadKg: 102.06 },
    ],
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.sets.length, 3);

  assert.equal(upserts.length, 3);
  assert.equal(upserts[0].exercise, 'squat'); // normalized lowercase
  assert.equal(upserts[0].set_index, 1);
  assert.equal(upserts[1].set_index, 2);
  assert.equal(upserts[2].set_index, 3);
  assert.equal(upserts[0].local_day, upserts[0].local_day); // sanity: present
});

test('POST rejects a set with a non-positive rep count', async () => {
  const { POST } = await routePromise;
  const response = await POST(req({
    sessionId: 'session-2',
    source: 'manual',
    sets: [{ exercise: 'squat', reps: 0 }],
  }));
  assert.equal(response.status, 400);
});

test('POST 400s on an invalid performedAt', async () => {
  const { POST } = await routePromise;
  const response = await POST(req({
    sessionId: 'session-3',
    source: 'manual',
    performedAt: 'not-a-date',
    sets: [{ exercise: 'squat', reps: 5 }],
  }));
  assert.equal(response.status, 400);
});
