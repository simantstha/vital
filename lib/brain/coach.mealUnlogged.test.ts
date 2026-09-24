import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as realSchema from '../../db/schema';

/**
 * Exercises the `meal_unlogged` SSE event added so the coach's `delete_meal`
 * tool result (a successful undo) reaches the client and can flip the
 * matching inline receipt to "Removed" — see lib/brain/coach.ts's tool-call
 * loop and lib/specialists/httpHandlers.ts's streamEvents.
 *
 * Lives in its own file for the same reason coach.mealLogged.test.ts does:
 * it needs a fake client returning a `tool_use` block, and node:test runs
 * each file in its own subprocess so the mocks can't collide.
 */

process.env.SPECIALIST_MODEL ??= 'claude-test-specialist';
process.env.SPECIALISTS_ENABLED = 'false';

type FakeResponse = { text: string; toolName?: string };
let responseQueue: FakeResponse[] = [];
let toolResultQueue: string[] = [];

const fakeAnthropicClient = {
  messages: {
    stream: (_params: unknown) => {
      const response = responseQueue.shift() ?? { text: 'done' };
      const content = response.toolName
        ? [{ type: 'tool_use', id: `toolu-${randomUUID()}`, name: response.toolName, input: {} }]
        : [{ type: 'text', text: response.text }];
      return {
        [Symbol.asyncIterator]: async function* () {
          if (!response.toolName && response.text) {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: response.text } };
          }
        },
        finalMessage: async () => ({
          stop_reason: response.toolName ? 'tool_use' : 'end_turn',
          content,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };
    },
  },
};
mock.module('./anthropicClient', { namedExports: { client: fakeAnthropicClient } });

const fakeDb = {
  insert: (table: unknown) => {
    if (table !== realSchema.messages) throw new Error(`unexpected insert table: ${String(table)}`);
    return {
      values: () => {
        const promise = Promise.resolve(undefined) as Promise<undefined> & {
          returning?: () => Promise<Array<{ id: string }>>;
        };
        promise.returning = async () => [{ id: 'message-1' }];
        return promise;
      },
    };
  },
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

mock.module('./context', {
  namedExports: {
    assembleContext: async () => ({
      hardConstraints: [],
      calibration: { status: 'ready', metrics: {} },
      unitSystem: 'metric',
      recentMessages: [],
      promptText: 'FAKE APPLICATION CONTEXT',
    }),
  },
});
mock.module('./tools', {
  namedExports: {
    BRAIN_TOOLS: [],
    executeToolCall: async () => toolResultQueue.shift() ?? JSON.stringify({ ok: true }),
    toolCallLabel: () => 'Removing that…',
  },
});
mock.module('./coachViz', { namedExports: { buildCoachViz: () => null } });
mock.module('@/lib/memory', {
  namedExports: { MEMORY_TOOLS: [], handleToolCall: () => { throw new Error('unused'); } },
});

class FakeSessionRepository {
  async findByUserAndId() { return null; }
  async findOpenByUser() { return null; }
  async insert(session: unknown) { return session; }
  async update(session: unknown) { return session; }
  async findExpiredPending() { return []; }
}
mock.module('@/lib/specialists/sessionRepository', {
  namedExports: { DrizzleSpecialistSessionRepository: FakeSessionRepository },
});

const coachPromise = import('./coach');

test('a successful delete_meal tool call yields a meal_unlogged event with id', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'delete_meal' },
    { text: 'Removed it!' },
  ];
  toolResultQueue = [
    JSON.stringify({ ok: true, id: 'evt-123', name: 'Two eggs and toast' }),
  ];

  const events: Array<Record<string, unknown>> = [];
  for await (const event of runCoach(randomUUID(), 'undo that')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  const mealUnlogged = events.find((e) => e.type === 'meal_unlogged');
  assert.deepEqual(mealUnlogged, { type: 'meal_unlogged', id: 'evt-123' });

  // Same ordering guarantee as meal_logged: after the tool_call "done".
  const doneIdx = events.findIndex((e) => e.type === 'tool_call' && e.status === 'done');
  const unloggedIdx = events.findIndex((e) => e.type === 'meal_unlogged');
  assert.ok(doneIdx !== -1 && unloggedIdx > doneIdx);
});

test('a failed delete_meal (plain "Error: …" text, not JSON) yields no meal_unlogged event', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'delete_meal' },
    { text: 'There was nothing recent to undo.' },
  ];
  toolResultQueue = [
    'Error: no meal logged in the last 30 minutes is eligible to undo.',
  ];

  const events: Array<Record<string, unknown>> = [];
  for await (const event of runCoach(randomUUID(), 'undo that')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  assert.equal(events.some((e) => e.type === 'meal_unlogged'), false);
});

test('an unrelated tool call (not delete_meal) never yields a meal_unlogged event', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'get_sleep_summary' },
    { text: 'You slept fine.' },
  ];
  toolResultQueue = [JSON.stringify({ ok: true, id: 'evt-should-not-appear' })];

  const events: Array<Record<string, unknown>> = [];
  for await (const event of runCoach(randomUUID(), 'how did I sleep?')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  assert.equal(events.some((e) => e.type === 'meal_unlogged'), false);
});
