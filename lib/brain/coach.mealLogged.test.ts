import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as realSchema from '../../db/schema';

/**
 * Exercises the `meal_logged` SSE event added so the coach's `log_meal` tool
 * result (which carries the inserted event's `id` + macros) reaches the
 * client instead of only the "Logging your meal…" chip label — see
 * lib/brain/coach.ts's tool-call loop and lib/specialists/httpHandlers.ts's
 * streamEvents.
 *
 * Lives in its own file (not coach.test.ts) for the same reason
 * coach.caching.test.ts does: it needs a fake client that returns a
 * `tool_use` block (coach.test.ts's fake client only ever returns text), and
 * node:test runs each file in its own subprocess so the mocks can't collide.
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
        ? [{ type: 'tool_use', id: `toolu-${randomUUID()}`, name: response.toolName, input: { text: 'two eggs and toast' } }]
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
    toolCallLabel: () => 'Logging your meal…',
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

test('a successful log_meal tool call also yields a meal_logged event with id + macros', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'log_meal' },
    { text: 'Logged it!' },
  ];
  toolResultQueue = [
    JSON.stringify({ ok: true, id: 'evt-123', query: 'two eggs and toast', kcal: 340, c: 28, p: 18, f: 16, matched: 'Two eggs and toast' }),
  ];

  const events: Array<Record<string, unknown>> = [];
  for await (const event of runCoach(randomUUID(), 'I had two eggs and toast')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  const mealLogged = events.find((e) => e.type === 'meal_logged');
  assert.ok(mealLogged, 'expected a meal_logged event in the stream');
  assert.deepEqual(mealLogged, {
    type: 'meal_logged',
    id:   'evt-123',
    name: 'Two eggs and toast',
    kcal: 340,
    p:    18,
    c:    28,
    f:    16,
  });

  // The event must come after the tool_call "done" so a client that renders
  // the receipt keyed off an already-known tool call id never sees it early.
  const doneIdx = events.findIndex((e) => e.type === 'tool_call' && e.status === 'done');
  const mealIdx = events.findIndex((e) => e.type === 'meal_logged');
  assert.ok(doneIdx !== -1 && mealIdx > doneIdx);
});

test('a barcode log_meal result (no "matched" field) falls back to "product" for the event name', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'log_meal' },
    { text: 'Logged it!' },
  ];
  toolResultQueue = [
    JSON.stringify({ ok: true, id: 'evt-456', product: 'Greek Yogurt 170g', servingG: 170, kcal: 120, c: 8, p: 17, f: 1 }),
  ];

  const events: Array<Record<string, unknown>> = [];
  for await (const event of runCoach(randomUUID(), '012345678905')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  const mealLogged = events.find((e) => e.type === 'meal_logged');
  assert.deepEqual(mealLogged, {
    type: 'meal_logged',
    id:   'evt-456',
    name: 'Greek Yogurt 170g',
    kcal: 120,
    p:    17,
    c:    8,
    f:    1,
  });
});

test('a failed log_meal (no nutrition match — plain text, not JSON) yields no meal_logged event', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'log_meal' },
    { text: 'I could not find that.' },
  ];
  toolResultQueue = [
    'Could not find nutrition data for "unobtainium soup". Try being more specific.',
  ];

  const events: Array<Record<string, unknown>> = [];
  for await (const event of runCoach(randomUUID(), 'I had unobtainium soup')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  assert.equal(events.some((e) => e.type === 'meal_logged'), false);
});

test('an unrelated tool call (not log_meal) never yields a meal_logged event', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'get_sleep_summary' },
    { text: 'You slept fine.' },
  ];
  toolResultQueue = [JSON.stringify({ ok: true, id: 'evt-should-not-appear', kcal: 999 })];

  const events: Array<Record<string, unknown>> = [];
  for await (const event of runCoach(randomUUID(), 'how did I sleep?')) {
    events.push(event as unknown as Record<string, unknown>);
  }

  assert.equal(events.some((e) => e.type === 'meal_logged'), false);
});
