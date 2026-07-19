import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../../../../db/schema';

let deleteCalls = 0;
let shouldThrow = false;
const fakeDb = {
  delete: () => ({
    where: async () => {
      deleteCalls += 1;
      if (shouldThrow) throw new Error('db down');
    },
  }),
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
const routePromise = import('./route');

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://local/api/whoop/disconnect', { method: 'POST', headers });
}

test('POST 401s without an x-user-id header', async () => {
  const { POST } = await routePromise;
  const res = await POST(request());
  assert.equal(res.status, 401);
});

test('POST deletes the connection row and returns { ok: true }', async () => {
  deleteCalls = 0;
  const { POST } = await routePromise;
  const res = await POST(request({ 'x-user-id': 'user-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  assert.equal(deleteCalls, 1);
});

test('POST still returns { ok: true } when there was no connection to delete', async () => {
  // The fake delete() is a no-op success regardless of row existence — same
  // as a real SQL DELETE matching zero rows — so this asserts the happy path
  // is unconditional, not gated on existence.
  deleteCalls = 0;
  const { POST } = await routePromise;
  const res = await POST(request({ 'x-user-id': 'user-with-no-connection' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('POST 500s when the DB delete fails', async () => {
  shouldThrow = true;
  try {
    const { POST } = await routePromise;
    const res = await POST(request({ 'x-user-id': 'user-1' }));
    assert.equal(res.status, 500);
  } finally {
    shouldThrow = false;
  }
});
