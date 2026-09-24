import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real POST/GET handlers against fakes for `@/db` and
 * `@/lib/brain/context` (no Postgres, no Anthropic network call).
 * mock.module() must run before ./route is first imported; node:test
 * isolates each test file in its own subprocess.
 *
 * Focus:
 *  - GET falls back to payload.description when payload.name is missing
 *    (coach-logged rows historically wrote only `description`).
 *  - POST's `reaction: false` / `?reaction=0` opt-out skips
 *    assembleContext (and so the Haiku call) entirely, returning
 *    immediately with an empty coachReaction; the default (both omitted)
 *    still calls it.
 */

const state: {
  usersRow: Array<{ timezone: string | null }>;
  eventsRows: Array<typeof realSchema.events.$inferSelect>;
} = { usersRow: [{ timezone: 'UTC' }], eventsRows: [] };

let insertedValues: Array<Record<string, unknown>> = [];
let nextInsertedId = 'event-1';
let assembleContextCalls = 0;

const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      if (table === realSchema.users) {
        return { where: () => ({ limit: async () => state.usersRow }) };
      }
      if (table === realSchema.events) {
        return { where: async () => state.eventsRows };
      }
      throw new Error(`unexpected table in select().from(): ${String(table)}`);
    },
  }),
  insert: (table: unknown) => {
    if (table !== realSchema.events) throw new Error(`unexpected table in insert(): ${String(table)}`);
    return {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return { returning: async () => [{ id: nextInsertedId }] };
      },
    };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/brain/context', {
  namedExports: {
    assembleContext: async () => {
      assembleContextCalls += 1;
      // Non-fatal by design (see route's try/catch) — this lets tests prove
      // the coach-reaction branch was (or wasn't) entered without also
      // needing to fake the Anthropic SDK call that follows it.
      throw new Error('assembleContext should not need a real DB in this test');
    },
  },
});

const routePromise = import('./route');

function eventRow(overrides: Partial<typeof realSchema.events.$inferSelect> = {}): typeof realSchema.events.$inferSelect {
  return {
    id: 'evt-1',
    user_id: 'user-1',
    timestamp: new Date('2026-09-24T12:00:00Z'),
    type: 'meal_logged',
    payload: {},
    source: 'coach',
    ...overrides,
  } as typeof realSchema.events.$inferSelect;
}

function getRequest(query = ''): Request {
  return new Request(`http://local/api/meals/log${query}`, { headers: { 'x-user-id': 'user-1' } });
}

function postRequest(body: Record<string, unknown>, query = ''): Request {
  return new Request(`http://local/api/meals/log${query}`, {
    method: 'POST',
    headers: { 'x-user-id': 'user-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── GET: name fallback ──────────────────────────────────────────────────────

test('GET falls back to payload.description when payload.name is missing (coach-logged rows)', async () => {
  state.eventsRows = [
    eventRow({ id: 'evt-coach', payload: { kcal: 350, c: 30, p: 18, f: 15, description: 'eggs and toast' } }),
    eventRow({ id: 'evt-manual', payload: { kcal: 400, name: 'Chicken Salad', c: 20, p: 30, f: 15 } }),
  ];

  const { GET } = await routePromise;
  const res = await GET(getRequest('?tz=UTC&date=2026-09-24'));
  assert.equal(res.status, 200);
  const body = await res.json();

  const coach = body.items.find((i: { id: string }) => i.id === 'evt-coach');
  const manual = body.items.find((i: { id: string }) => i.id === 'evt-manual');
  assert.ok(coach, 'coach-logged row should appear');
  assert.equal(coach.name, 'eggs and toast');
  assert.equal(manual.name, 'Chicken Salad');
});

test('GET prefers payload.name over payload.description when both are present', () => {
  return (async () => {
    state.eventsRows = [
      eventRow({ id: 'evt-both', payload: { kcal: 300, name: 'Named Thing', description: 'raw query text' } }),
    ];
    const { GET } = await routePromise;
    const res = await GET(getRequest('?tz=UTC&date=2026-09-24'));
    const body = await res.json();
    assert.equal(body.items[0].name, 'Named Thing');
  })();
});

// ─── POST: reaction opt-out ──────────────────────────────────────────────────

test('POST with reaction: false skips assembleContext and returns an empty coachReaction immediately', async () => {
  insertedValues = [];
  assembleContextCalls = 0;
  nextInsertedId = 'event-no-reaction';

  const { POST } = await routePromise;
  const res = await POST(postRequest({
    name: 'Chicken Salad', kcal: 400, c: 20, p: 30, f: 15, source: 'recent', reaction: false,
  }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.eventId, 'event-no-reaction');
  assert.equal(body.coachReaction, '');
  assert.equal(assembleContextCalls, 0, 'assembleContext must not be called when reaction: false');
  assert.equal(insertedValues.length, 1);
});

test('POST with ?reaction=0 query param also skips assembleContext', async () => {
  insertedValues = [];
  assembleContextCalls = 0;

  const { POST } = await routePromise;
  const res = await POST(postRequest(
    { name: 'Custom log', kcal: 200, c: 0, p: 0, f: 0, source: 'manual' },
    '?reaction=0',
  ));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.coachReaction, '');
  assert.equal(assembleContextCalls, 0);
});

test('POST with reaction omitted (default) still calls assembleContext (unchanged behavior)', async () => {
  insertedValues = [];
  assembleContextCalls = 0;

  const { POST } = await routePromise;
  const res = await POST(postRequest({
    name: 'Grilled Chicken', kcal: 300, c: 5, p: 45, f: 10, source: 'search',
  }));

  assert.equal(res.status, 200);
  const body = await res.json();
  // assembleContext is mocked to throw -> the route's non-fatal catch still
  // returns ok + eventId with an empty coachReaction, but the call count
  // proves the branch was entered (unlike the opt-out tests above).
  assert.equal(body.ok, true);
  assert.equal(body.coachReaction, '');
  assert.equal(assembleContextCalls, 1, 'assembleContext must still be called by default');
});
