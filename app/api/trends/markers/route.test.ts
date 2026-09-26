import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real GET handler against a fake `@/db` — no Postgres.
 * mock.module() must run before ./route is first imported; node:test
 * isolates each test file in its own subprocess.
 */

const state: {
  usersRow: Array<{ timezone: string | null }>;
  eventRows: Array<{ timestamp: Date; payload: unknown }>;
} = { usersRow: [{ timezone: 'UTC' }], eventRows: [] };

const eventsWhereCalls: unknown[] = [];

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) return { where: () => ({ limit: async () => state.usersRow }) };
      if (table === realSchema.events) {
        return {
          where: (cond: unknown) => {
            eventsWhereCalls.push(cond);
            return Promise.resolve(state.eventRows);
          },
        };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

const routePromise = import('./route');

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://local/api/trends/markers${query}`, { headers });
}

test('no x-user-id -> 401', async () => {
  const { GET } = await routePromise;
  const res = await GET(request(''));
  assert.equal(res.status, 401);
});

test('default days is 90 when not provided', async () => {
  state.eventRows = [];
  const { GET } = await routePromise;
  const res = await GET(request('', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.equal(body.days, 90);
});

test('days is clamped to [1, 365]', async () => {
  state.eventRows = [];
  const { GET } = await routePromise;
  const tooBig = await (await GET(request('?days=9999', { 'x-user-id': 'user-1' }))).json();
  assert.equal(tooBig.days, 365);
  const tooSmall = await (await GET(request('?days=0', { 'x-user-id': 'user-1' }))).json();
  assert.equal(tooSmall.days, 1);
});

test('buckets workout_completed events into local-day markers, oldest to newest', async () => {
  state.usersRow = [{ timezone: 'UTC' }];
  state.eventRows = [
    { timestamp: new Date('2026-09-05T12:00:00Z'), payload: { type: 'running' } },
    { timestamp: new Date('2026-09-01T08:00:00Z'), payload: { type: 'cycling' } },
    { timestamp: new Date('2026-09-01T18:00:00Z'), payload: { type: 'yoga' } },
  ];
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.markers, [
    { date: '2026-09-01', kind: 'workout', label: '2 workouts', count: 2 },
    { date: '2026-09-05', kind: 'workout', label: 'Running', count: 1 },
  ]);
});

test('empty result set yields no markers', async () => {
  state.eventRows = [];
  const { GET } = await routePromise;
  const res = await GET(request('?days=30', { 'x-user-id': 'user-1' }));
  const body = await res.json();
  assert.deepEqual(body.markers, []);
});
