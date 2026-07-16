import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

/**
 * Drives the real POST handler against a fake `@/db` transaction (no
 * Postgres), covering auth + the request/response contract. Deep
 * validation-error and overlap-replace-semantics coverage lives in
 * lib/calendarIngest.test.ts (pure) and lib/calendarIngestStore.test.ts
 * (SQL-shape); this file just proves the route wires them together
 * correctly. `@/db` must be mocked before the route module's first import
 * in this process, so this lives in its own file (node:test isolates each
 * test file in its own subprocess).
 *
 * mock.module() can only be called once per specifier per process, so
 * `transactionCalls` is mutable state each test inspects/resets rather than
 * re-mocking per test.
 */
let transactionCalls = 0;
const fakeDb = {
  transaction: async <T>(op: (tx: unknown) => Promise<T>): Promise<T> => {
    transactionCalls += 1;
    const deletedFor: unknown[] = [];
    const insertedRows: Array<Record<string, unknown>> = [];
    const tx = {
      delete: () => ({ where: async (predicate: unknown) => { deletedFor.push(predicate); } }),
      insert: () => ({ values: async (rows: Array<Record<string, unknown>>) => { insertedRows.push(...rows); } }),
    };
    lastTransactionDetail = { deletedFor, insertedRows };
    return op(tx);
  },
};
let lastTransactionDetail: { deletedFor: unknown[]; insertedRows: Array<Record<string, unknown>> } | null = null;

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/ingest/calendar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST 401s without an x-user-id header', async () => {
  const { POST } = await routePromise;
  const response = await POST(request({ windowStart: '2026-07-16T00:00:00.000Z', windowEnd: '2026-07-17T00:00:00.000Z', blocks: [] }));
  assert.equal(response.status, 401);
});

test('POST 400s on a validation failure without touching the store', async () => {
  transactionCalls = 0;
  const { POST } = await routePromise;

  const response = await POST(request(
    { windowStart: '2026-07-17T00:00:00.000Z', windowEnd: '2026-07-16T00:00:00.000Z', blocks: [] }, // end before start
    { 'x-user-id': 'user-1' },
  ));

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /windowEnd must be after windowStart/);
  assert.equal(transactionCalls, 0);
});

test('POST replaces the window and echoes the inserted count on success', async () => {
  transactionCalls = 0;
  const { POST } = await routePromise;

  const response = await POST(request(
    {
      windowStart: '2026-07-16T00:00:00.000Z',
      windowEnd: '2026-07-17T00:00:00.000Z',
      blocks: [{ start: '2026-07-16T09:00:00.000Z', end: '2026-07-16T09:30:00.000Z', title: 'Standup' }],
    },
    { 'x-user-id': 'user-1' },
  ));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { replaced: 1 });
  assert.equal(transactionCalls, 1);
  assert.equal(lastTransactionDetail?.deletedFor.length, 1);
  assert.equal(lastTransactionDetail?.insertedRows.length, 1);
  assert.equal(lastTransactionDetail?.insertedRows[0].user_id, 'user-1');
  assert.equal(lastTransactionDetail?.insertedRows[0].title, 'Standup');
});

test('POST 400s on invalid JSON', async () => {
  transactionCalls = 0;
  const { POST } = await routePromise;

  const response = await POST(new Request('http://local/api/ingest/calendar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
    body: '{not json',
  }));
  assert.equal(response.status, 400);
  assert.equal(transactionCalls, 0);
});
