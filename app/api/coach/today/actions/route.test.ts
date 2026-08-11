import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '@/db/schema';
import type { ApplyCoachActionInput } from '@/lib/coachWorkspaceRepository';

let appliedActionInput: ApplyCoachActionInput | undefined;
let created = true;
let applyError: Error | undefined;

function lastAppliedAction(): ApplyCoachActionInput | undefined {
  return appliedActionInput;
}

mock.module('@/db', { namedExports: { db: {}, schema: realSchema } });
mock.module('@/lib/coachWorkspaceRepository', { namedExports: {
  applyCoachAction: async (input: ApplyCoachActionInput) => {
    if (applyError) throw applyError;
    appliedActionInput = input;
    return {
      created,
      interaction: {
        id: 'interaction-atomic', recommendation_id: input.recommendationId,
        action_id: input.actionId, action: input.action, plan_item_id: 'plan-atomic',
        created_at: new Date('2026-08-11T15:00:00.000Z'),
      },
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

test('POST /api/coach/today/actions returns an idempotent replay unchanged', async () => {
  applyError = undefined;
  created = true;
  const { POST } = await routePromise;
  const request = () => new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({
      actionId: 'tap-1', recommendationId: 'recommendation-1', action: 'complete',
    }),
  });

  const first = await POST(request());
  assert.equal(first.status, 201);

  created = false;
  const replay = await POST(request());
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), await first.clone().json());
});

test('POST accepts only the Coach Workspace action vocabulary and delegates accept atomically', async () => {
  applyError = undefined;
  appliedActionInput = undefined;
  created = true;
  const { POST } = await routePromise;
  const accepted = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({ actionId: 'accept-1', recommendationId: 'recommendation-1', action: 'accept' }),
  }));

  assert.equal(accepted.status, 201);
  assert.equal(lastAppliedAction()?.action, 'accept');
  assert.equal(Object.hasOwn(lastAppliedAction() ?? {}, 'planItemId'), false);

  const unsupported = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({ actionId: 'dismiss-1', recommendationId: 'recommendation-1', action: 'dismiss' }),
  }));
  assert.equal(unsupported.status, 400);
});

test('POST sends a bounded adjustment to the atomic repository operation', async () => {
  applyError = undefined;
  appliedActionInput = undefined;
  created = true;
  const { POST } = await routePromise;
  const response = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({
      actionId: 'adjust-1', recommendationId: 'recommendation-1', action: 'adjust',
      adjustment: { timeMinutes: 1080, durationMinutes: 45, intensity: 'moderate' },
    }),
  }));

  assert.equal(response.status, 201);
  assert.deepEqual(lastAppliedAction()?.adjustment, {
    timeMinutes: 1080, durationMinutes: 45, intensity: 'moderate',
  });
});

test('POST rejects an empty adjustment instead of creating a no-op interaction', async () => {
  const { POST } = await routePromise;
  const response = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({ actionId: 'adjust-empty', recommendationId: 'recommendation-1', action: 'adjust', adjustment: {} }),
  }));

  assert.equal(response.status, 400);
});

test('POST rejects null-only adjustment fields', async () => {
  const { POST } = await routePromise;
  const response = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({ actionId: 'adjust-null', recommendationId: 'recommendation-1', action: 'adjust', adjustment: { timeMinutes: null } }),
  }));

  assert.equal(response.status, 400);
});

test('POST surfaces repository calibration rejection as a client error', async () => {
  applyError = new Error('accept is not allowed for calibration recommendations.');
  const { POST } = await routePromise;
  const response = await POST(new Request('http://local/api/coach/today/actions', {
    method: 'POST', headers: { 'x-user-id': 'user-1' },
    body: JSON.stringify({ actionId: 'accept-calibration', recommendationId: 'calibration-1', action: 'accept' }),
  }));
  applyError = undefined;

  assert.equal(response.status, 400);
});
