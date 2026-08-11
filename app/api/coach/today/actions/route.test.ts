import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';

let existingInteraction: Record<string, unknown> | undefined;
let recommendation: Record<string, unknown> | undefined;
let planItem: Record<string, unknown> | undefined;
let createdInput: Record<string, unknown> | undefined;

mock.module('@/db', { namedExports: { db: {}, schema: realSchema } });
mock.module('@/lib/coachWorkspaceRepository', { namedExports: {
  findInteractionByActionId: async () => existingInteraction,
  findRecommendationForUser: async () => recommendation,
  userPlanItem: async () => planItem,
  createInteraction: async (input: Record<string, unknown>) => {
    createdInput = input;
    return {
      id: 'interaction-1', recommendation_id: input.recommendationId,
      action_id: input.actionId, action: input.action, plan_item_id: input.planItemId,
      created_at: new Date('2026-08-11T15:00:00.000Z'),
    };
  },
} });
const routePromise = import('./route');

test('POST /api/coach/today/actions rejects unauthenticated requests', async () => {
  const { POST } = await routePromise;
  const response = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST',
    body: JSON.stringify({ actionId: 'tap-1', action: 'accept' }),
  }));

  assert.equal(response.status, 401);
});

test('POST /api/coach/today/actions validates its idempotency key and action', async () => {
  const { POST } = await routePromise;
  const response = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST',
    headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({ actionId: '', action: 'invented' }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'actionId is required.' });
});

test('POST /api/coach/today/actions links an owned plan item and returns a replay unchanged', async () => {
  existingInteraction = undefined;
  recommendation = { id: 'recommendation-1' };
  planItem = { id: 'plan-1' };
  createdInput = undefined;
  const { POST } = await routePromise;
  const request = () => new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({
      actionId: 'tap-1', recommendationId: 'recommendation-1', action: 'complete', planItemId: 'plan-1',
    }),
  });

  const first = await POST(request());
  assert.equal(first.status, 201);
  assert.equal(createdInput?.planItemId, 'plan-1');

  existingInteraction = {
    id: 'interaction-1', recommendation_id: 'recommendation-1', action_id: 'tap-1', action: 'complete',
    plan_item_id: 'plan-1', created_at: new Date('2026-08-11T15:00:00.000Z'),
  };
  const replay = await POST(request());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), await first.clone().json());
});
