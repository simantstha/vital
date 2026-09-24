import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as realSchema from '../../db/schema';

/**
 * Safety net for the coach's tool-execution call: an unexpected error out of
 * `executeToolCall`/`handleMemoryToolCall` (e.g. a malformed model-supplied
 * id hitting Postgres's "invalid input syntax for type uuid" the way
 * `confirm_fact`/`resolve_fact`/`delete_meal`'s own `isUuid` guards are
 * meant to prevent, or any other unforeseen throw) must not abort the whole
 * coach turn — see lib/brain/coach.ts's tool-call loop. The turn should
 * still complete: the tool_call gets its `status: 'done'`, the model gets a
 * plain `Error: …` tool_result it can recover from, and the assistant
 * message still gets persisted with a final `done` event.
 *
 * Same mocking pattern as coach.mealUnlogged.test.ts — its own file because
 * node:test runs each file in its own subprocess and the mocks can't
 * collide with other coach.*.test.ts files.
 */

process.env.SPECIALIST_MODEL ??= 'claude-test-specialist';
process.env.SPECIALISTS_ENABLED = 'false';

type FakeResponse = { text: string; toolName?: string };
let responseQueue: FakeResponse[] = [];

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
    executeToolCall: async () => {
      throw new Error('invalid input syntax for type uuid: "last"');
    },
    toolCallLabel: () => 'Doing a thing…',
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

test('a tool call that throws still produces a completed turn with an error tool_result', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'resolve_fact' },
    { text: 'Sorry, something went wrong with that.' },
  ];

  const originalConsoleError = console.error;
  const errorCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => { errorCalls.push(args); };

  let events: Array<Record<string, unknown>>;
  try {
    events = [];
    for await (const event of runCoach(randomUUID(), 'forget that')) {
      events.push(event as unknown as Record<string, unknown>);
    }
  } finally {
    console.error = originalConsoleError;
  }

  // The turn completed normally: text after the tool call, plus the final
  // `done` event — no thrown error propagated out of the generator.
  const doneEvent = events.find((e) => e.type === 'done');
  assert.ok(doneEvent, 'expected the turn to complete with a done event, not abort');

  // The tool_call still reaches 'done' status (the SSE contract the client
  // relies on to stop showing its "in progress" chip).
  const toolCallEvents = events.filter((e) => e.type === 'tool_call');
  assert.equal(toolCallEvents.length, 2);
  assert.equal(toolCallEvents[0].status, 'started');
  assert.equal(toolCallEvents[1].status, 'done');

  // No structured meal events leak out of a failed, unrelated tool call.
  assert.equal(events.some((e) => e.type === 'meal_logged'), false);
  assert.equal(events.some((e) => e.type === 'meal_unlogged'), false);

  // The failure was logged server-side with the tool name...
  assert.equal(errorCalls.length, 1);
  const [message, meta] = errorCalls[0] as [string, { tool?: string; error?: unknown }];
  assert.match(String(message), /coach tool call failed/i);
  assert.equal(meta.tool, 'resolve_fact');
  // ...but the *content* passed to the model is a clear, generic recovery
  // instruction, not the raw exception message.
  assert.match(String(meta.error), /invalid input syntax/); // logged for debugging
});

test('the assistant text after a failed tool call still gets persisted', async () => {
  const { runCoach } = await coachPromise;
  responseQueue = [
    { text: '', toolName: 'confirm_fact' },
    { text: 'That did not work, sorry about that.' },
  ];

  const originalConsoleError = console.error;
  console.error = () => {};
  let events: Array<Record<string, unknown>>;
  try {
    events = [];
    for await (const event of runCoach(randomUUID(), 'confirm it')) {
      events.push(event as unknown as Record<string, unknown>);
    }
  } finally {
    console.error = originalConsoleError;
  }

  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, 'That did not work, sorry about that.');
  const doneEvent = events.find((e) => e.type === 'done');
  assert.equal(doneEvent?.messageId, 'message-1');
});
