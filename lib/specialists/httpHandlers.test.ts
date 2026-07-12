import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoachHttpHandlers } from './httpHandlers';
import type { CoachEvent } from '@/lib/brain/coach';

async function* events(values: CoachEvent[]): AsyncGenerator<CoachEvent> {
  yield* values;
}

async function sse(response: Response): Promise<Record<string, unknown>[]> {
  return (await response.text()).trim().split('\n\n').map((line) => JSON.parse(line.slice(6)));
}

test('POST preserves legacy event shapes and authenticates before running coach', async () => {
  let calledWith: unknown[] = [];
  const handlers = createCoachHttpHandlers({
    enabled: () => false,
    authenticate(request) {
      const id = request.headers.get('x-user-id');
      if (!id) throw new Error('unauthenticated');
      return id;
    },
    runCoach(userId, message, image, mode) {
      calledWith = [userId, message, image, mode];
      return events([
        { type: 'text', text: 'Hello' },
        { type: 'tool_call', id: 'call-1', name: 'get_sleep_summary', label: 'Sleep', status: 'started' },
        { type: 'tool_data', id: 'call-1', viz: { kind: 'stat', title: 'Sleep', value: '8h' } as never },
        { type: 'done', messageId: 'message-1' },
      ]);
    },
    runAction() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
  });
  const unauthorized = await handlers.POST(new Request('http://local/api/coach', {
    method: 'POST', body: JSON.stringify({ message: 'hello' }),
  }));
  assert.equal(unauthorized.status, 401);

  const response = await handlers.POST(new Request('http://local/api/coach', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'user-a' },
    body: JSON.stringify({ message: ' hello ', imageBase64: 'image', mode: 'onboarding' }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calledWith, ['user-a', 'hello', 'image', 'onboarding']);
  assert.deepEqual((await sse(response)).map((event) => event.type), [
    'text', 'tool_call', 'tool_data', 'done',
  ]);
});

test('feature-off POST ignores specialist-looking extra fields like the legacy route', async () => {
  let messageSeen = '';
  const handlers = createCoachHttpHandlers({
    enabled: () => false,
    authenticate: () => 'user-a',
    runCoach(_userId, message) {
      messageSeen = message;
      return events([{ type: 'done', messageId: 'message-1' }]);
    },
    runAction() { throw new Error('not used'); },
    async restore() { throw new Error('not used'); },
  });
  const response = await handlers.POST(new Request('http://local/api/coach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello', action: 'client_metadata' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(messageSeen, 'hello');
  assert.deepEqual((await sse(response)).map((event) => event.type), ['done']);
});

test('specialist actions are scoped to authenticated user and preserve card-before-persona ordering', async () => {
  let actionUser = '';
  const handlers = createCoachHttpHandlers({
    enabled: () => true,
    authenticate: (request) => request.headers.get('x-user-id') ?? (() => { throw new Error('unauthenticated'); })(),
    runCoach() { throw new Error('not used'); },
    runAction(userId) {
      actionUser = userId;
      return events([
        {
          type: 'handoff_card', phase: 'dismissed', sessionId: 'session-1', objective: 'Plan week',
          specialist: {
            id: 'running-coach', title: 'Running Coach', subtitle: 'Vital Specialist',
            accent: '#4CC9F0', icon: 'figure.run', sessionId: 'session-1',
          },
        },
        {
          type: 'persona_changed',
          persona: {
            id: 'running-coach', title: 'Running Coach', subtitle: 'Vital Specialist',
            accent: '#4CC9F0', icon: 'figure.run', sessionId: 'session-1',
          },
        },
        { type: 'done', messageId: 'action-1' },
      ]);
    },
    async restore() { throw new Error('not used'); },
  });
  const response = await handlers.POST(new Request('http://local/api/coach', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'user-a' },
    body: JSON.stringify({
      sessionId: 'session-1', actionId: 'action-1', action: 'accept_handoff',
    }),
  }));
  assert.equal(actionUser, 'user-a');
  assert.deepEqual((await sse(response)).map((event) => event.type), [
    'handoff_card', 'persona_changed', 'done',
  ]);
});

test('GET is authenticated and returns the restoration payload', async () => {
  let restoredUser = '';
  const payload = { messages: [], activePersona: { id: 'vital' }, pendingCard: null };
  const handlers = createCoachHttpHandlers({
    enabled: () => true,
    authenticate: (request) => request.headers.get('x-user-id') ?? (() => { throw new Error('unauthenticated'); })(),
    runCoach() { throw new Error('not used'); },
    runAction() { throw new Error('not used'); },
    async restore(userId) { restoredUser = userId; return payload as never; },
  });
  assert.equal((await handlers.GET(new Request('http://local/api/coach'))).status, 401);
  const response = await handlers.GET(new Request('http://local/api/coach', {
    headers: { 'x-user-id': 'user-a' },
  }));
  assert.equal(response.status, 200);
  assert.equal(restoredUser, 'user-a');
  assert.deepEqual(await response.json(), payload);
});

test('GET remains unavailable and does not query specialist state while the feature is off', async () => {
  let restored = false;
  const handlers = createCoachHttpHandlers({
    enabled: () => false,
    authenticate: () => 'user-a',
    runCoach() { throw new Error('not used'); },
    runAction() { throw new Error('not used'); },
    async restore() { restored = true; throw new Error('not used'); },
  });
  const response = await handlers.GET(new Request('http://local/api/coach'));
  assert.equal(response.status, 404);
  assert.equal(restored, false);
});
