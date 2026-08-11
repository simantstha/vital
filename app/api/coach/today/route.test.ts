import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

const recommendation = {
  id: 'recommendation-1', user_id: 'user-1', local_day: '2026-08-11', category: 'training',
  action: { title: 'Train', copy: 'Keep it easy.', kind: 'move', timeMinutes: 1020, durationMinutes: 45, intensity: 'easy' },
  evidence: {}, material_signature: 'signature', created_at: new Date(), updated_at: new Date(),
};
const state = { status: 'planned', planItemId: 'plan-1', effectiveAction: recommendation.action };

let selectCalls = 0;
const fakeDb = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => {
      selectCalls += 1;
      return [{ timezone: 'UTC' }];
    } }) }),
  }),
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('@/lib/coachWorkspaceRepository', { namedExports: {
  createOrLoadDailyRecommendation: async () => recommendation,
  hydrateCoachWorkspaceState: async () => state,
} });
const routePromise = import('./route');

process.env.COACH_WORKSPACE_V1 = 'true';

test('GET /api/coach/today returns recommendation and hydrated state', async () => {
  const { GET } = await routePromise;
  const response = await GET(new Request('http://local/api/coach/today?tz=UTC', {
    headers: { 'x-user-id': 'user-1' },
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.recommendation.id, 'recommendation-1');
  assert.deepEqual(body.state, state);
});

test('GET /api/coach/today fails closed before database work when disabled', async () => {
  const { GET } = await routePromise;
  delete process.env.COACH_WORKSPACE_V1;
  selectCalls = 0;
  try {
    const response = await GET(new Request('http://local/api/coach/today?tz=UTC', {
      headers: { 'x-user-id': 'user-1' },
    }));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: 'Coach Workspace is disabled.',
      code: 'COACH_WORKSPACE_DISABLED',
    });
    assert.equal(selectCalls, 0);
  } finally {
    process.env.COACH_WORKSPACE_V1 = 'true';
  }
});
