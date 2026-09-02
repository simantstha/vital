import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as realSchema from '../../db/schema';

/**
 * Exercises the runCoach/runSpecialistAction control flow added by the
 * specialist-handoff-continuation refactor (2026-09-01) without touching
 * Postgres or the Anthropic API. Everything coach.ts talks to is faked:
 *
 *  - './anthropicClient' -> a fake `client` whose messages.stream() returns a
 *    queued canned response (one text chunk, stop_reason 'end_turn'). Mocked
 *    via this relative specifier, not '@anthropic-ai/sdk' directly — under
 *    this project's test invocation (`node --import tsx
 *    --experimental-test-module-mocks --test`), mocking a bare package
 *    specifier does not reliably intercept a *nested* module's (coach.ts's)
 *    static import of that package; a relative specifier does, which is
 *    exactly why anthropicClient.ts exists as its own module.
 *  - '@/db' -> only supports inserting into schema.messages (the one table
 *    coach.ts itself touches directly).
 *  - './context', './tools', './coachViz', '@/lib/memory' -> the minimal
 *    stand-ins those steps need; none of these tests exercise a tool call, so
 *    executeToolCall/handleToolCall assert if reached. Each of these is
 *    imported ONLY by coach.ts, so the doubles only have to satisfy coach.ts's
 *    own import list.
 *
 * './persona' is deliberately NOT mocked. It has no runtime imports at all
 * (its three imports are all `import type`), so the real module is free to
 * load — and it is reached by a SECOND consumer besides coach.ts:
 * orchestration.ts's buildSpecialistPrompt imports `unitsInstructionBlock`
 * from it. A persona double written against coach.ts's usage alone
 * (assemblePersona) therefore breaks the specialist path with
 * "unitsInstructionBlock is not a function". Using the real module removes
 * that whole class of missing-export bug rather than patching it one symbol
 * at a time.
 *  - '@/lib/specialists/sessionRepository' -> an in-memory repository backed
 *    by a module-level Map so this file can seed a session directly and have
 *    coach.ts's own SpecialistSessionService instance see it.
 *  - '@/lib/specialists/actionRepository' -> a FakeActionStore, structurally
 *    the same idempotent claim/complete store as orchestration.ts's own
 *    InMemorySpecialistActionStore (kept separate, not imported from there,
 *    so this file never statically imports anything from
 *    '@/lib/specialists/orchestration' — that module's
 *    ConcurrentSpecialistSessionUpdateError re-export touches './sessions',
 *    which touches './registry' for real; a static import would run that
 *    before SPECIALIST_MODEL is set below, since static imports are
 *    evaluated before any of this file's own top-level statements).
 *
 * '@/lib/specialists/sessions', 'registry', 'orchestration', 'coachRuntime',
 * and 'coachIntegration' are all left REAL and only ever dynamically
 * imported (via `./coach`): none of them touch Postgres, and this is exactly
 * the control-flow glue under test.
 *
 * registry.ts's module-level `specialistRegistry` singleton reads
 * SPECIALIST_MODEL once, at first import — so it's set here before the first
 * import of anything specialist-shaped, and nothing specialist-shaped is
 * ever imported statically in this file.
 */

process.env.SPECIALIST_MODEL ??= 'claude-test-specialist';

type FakeResponse = {
  text: string;
  stopReason?: 'end_turn' | 'tool_use';
  usage?: { input_tokens: number; output_tokens: number };
  /**
   * When set, the stream throws this mid-iteration (after any `text` above has
   * been yielded) instead of completing — i.e. a provider failure that lands
   * INSIDE coach.ts's try block, which is the only way to reach its
   * handleModelFailure catch. A plain Error (not an AbortError) so
   * isModelStreamInterruption() returns false and the session is failed rather
   * than preserved.
   */
  failWith?: Error;
};

let responseQueue: FakeResponse[] = [];
const streamCalls: Array<{ model: string; system: string; messages: unknown[] }> = [];

const fakeAnthropicClient = {
  messages: {
    stream: (params: { model: string; system: string; messages: unknown[] }) => {
      streamCalls.push(params);
      const response = responseQueue.shift() ?? { text: 'OK', stopReason: 'end_turn' as const };
      return {
        [Symbol.asyncIterator]: async function* () {
          if (response.text) {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: response.text } };
          }
          if (response.failWith) throw response.failWith;
        },
        finalMessage: async () => ({
          stop_reason: response.stopReason ?? 'end_turn',
          content: response.text ? [{ type: 'text', text: response.text }] : [],
          usage: response.usage ?? { input_tokens: 10, output_tokens: 5 },
        }),
      };
    },
  },
};
mock.module('./anthropicClient', { namedExports: { client: fakeAnthropicClient } });

let insertedMessages: Array<Record<string, unknown>> = [];
let nextMessageId = 1;
const fakeDb = {
  insert: (table: unknown) => {
    if (table !== realSchema.messages) throw new Error(`unexpected insert table: ${String(table)}`);
    return {
      values: (vals: Record<string, unknown>) => {
        insertedMessages.push(vals);
        const id = `message-${nextMessageId++}`;
        const promise = Promise.resolve(undefined) as Promise<undefined> & {
          returning?: () => Promise<Array<{ id: string }>>;
        };
        promise.returning = async () => [{ id }];
        return promise;
      },
    };
  },
};
mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });

mock.module('./context', {
  namedExports: {
    // Only the 5 fields coach.ts itself reads off the context — assembleContext's
    // full shape (today/schedule/baselines/...) is exercised by context.test.ts.
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
    executeToolCall: async () => { throw new Error('no test in this file exercises a tool call'); },
    toolCallLabel: () => 'unused',
  },
});
mock.module('./coachViz', {
  namedExports: { buildCoachViz: () => null },
});
mock.module('@/lib/memory', {
  namedExports: {
    MEMORY_TOOLS: [],
    handleToolCall: () => { throw new Error('no test in this file exercises a memory tool call'); },
  },
});

const OPEN_STATUSES = ['proposed', 'active', 'return_proposed'];
type FakeSpecialistSession = {
  id: string; userId: string; objective: string; manifestId: string; manifestVersion: string;
  status: string; cardOccurrenceId: string; inboundHandoff: unknown; returnHandoff: unknown;
  failureReason: string | null; proposedAt: Date; activatedAt: Date | null; returnProposedAt: Date | null;
  completedAt: Date | null; declinedAt: Date | null; failedAt: Date | null; expiresAt: Date | null;
  updatedAt: Date;
};
const sessionRows = new Map<string, FakeSpecialistSession>();

class FakeSessionRepository {
  async findByUserAndId(userId: string, id: string) {
    const row = sessionRows.get(id);
    return row && row.userId === userId ? structuredClone(row) : null;
  }
  async findOpenByUser(userId: string) {
    const row = [...sessionRows.values()].find((c) => c.userId === userId && OPEN_STATUSES.includes(c.status));
    return row ? structuredClone(row) : null;
  }
  async insert(session: FakeSpecialistSession) {
    sessionRows.set(session.id, structuredClone(session));
    return structuredClone(session);
  }
  async update(session: FakeSpecialistSession, expectedStatus: string) {
    const stored = sessionRows.get(session.id);
    if (!stored || stored.status !== expectedStatus) throw new Error(`concurrent update on ${session.id}`);
    sessionRows.set(session.id, structuredClone(session));
    return structuredClone(session);
  }
  async findExpiredPending() { return []; }
}
mock.module('@/lib/specialists/sessionRepository', {
  namedExports: { DrizzleSpecialistSessionRepository: FakeSessionRepository },
});

// Mirrors orchestration.ts's own InMemorySpecialistActionStore (claim once,
// complete once, replay the stored result after) without importing that
// module — see the file-level comment on why a static import of anything
// specialist-shaped isn't safe here.
class FakeActionStore {
  private readonly rows = new Map<string, { sessionId: string; cardOccurrenceId: string; action: string; result: unknown }>();
  async claim(userId: string, actionId: string, sessionId: string, cardOccurrenceId: string, action: string) {
    const key = `${userId}:${actionId}`;
    const existing = this.rows.get(key);
    if (existing) return { ...structuredClone(existing), isNew: false };
    const claim = { sessionId, cardOccurrenceId, action, result: null };
    this.rows.set(key, claim);
    return { ...structuredClone(claim), isNew: true };
  }
  async complete(userId: string, actionId: string, result: unknown) {
    const key = `${userId}:${actionId}`;
    const claim = this.rows.get(key);
    if (!claim) throw new Error(`action ${actionId} not claimed`);
    if (claim.result) return structuredClone(claim.result);
    claim.result = structuredClone(result);
    return structuredClone(result);
  }
}
mock.module('@/lib/specialists/actionRepository', {
  namedExports: {
    SpecialistActionRepository: FakeActionStore,
    DrizzleSpecialistActionPersistence: class {},
  },
});

const coachPromise = import('./coach');

function seedProposedSession(overrides: {
  userId: string;
  manifestId?: string;
  objective?: string;
  inboundHandoff?: unknown;
}): FakeSpecialistSession {
  const now = new Date();
  const session: FakeSpecialistSession = {
    id: randomUUID(),
    userId: overrides.userId,
    objective: overrides.objective ?? 'Build a safe half-marathon week',
    manifestId: overrides.manifestId ?? 'running-coach',
    manifestVersion: '1.0.0',
    status: 'proposed',
    cardOccurrenceId: randomUUID(),
    inboundHandoff: overrides.inboundHandoff ?? {
      summary: 'Returning runner', relevantFacts: ['Ran 20km/week before a 3-month break'],
    },
    returnHandoff: null,
    failureReason: null,
    proposedAt: now,
    activatedAt: null,
    returnProposedAt: null,
    completedAt: null,
    declinedAt: null,
    failedAt: null,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    updatedAt: now,
  };
  sessionRows.set(session.id, session);
  return session;
}

function seedReturnProposedSession(overrides: {
  userId: string;
  manifestId?: string;
  returnHandoff: unknown;
}): FakeSpecialistSession {
  const session = seedProposedSession(overrides);
  session.status = 'return_proposed';
  session.activatedAt = session.proposedAt;
  session.returnProposedAt = session.proposedAt;
  session.returnHandoff = overrides.returnHandoff;
  sessionRows.set(session.id, session);
  return session;
}

function eventTypes(events: Array<{ type: string }>): string[] {
  return events.map((e) => e.type);
}

// Runs first, deliberately, before any later test flips SPECIALISTS_ENABLED —
// node:test runs a file's top-level tests sequentially by default, same
// assumption the rest of this codebase's mock.module tests already rely on.
test('plain user message behaves identically after the streamCoachTurn extraction (regression)', async () => {
  const { runCoach } = await coachPromise;
  insertedMessages = [];
  responseQueue = [{ text: 'Hi there — how can I help today?', stopReason: 'end_turn' }];
  const callsBefore = streamCalls.length;

  const events: Array<{ type: string; text?: string; messageId?: string }> = [];
  for await (const event of runCoach(randomUUID(), 'hello coach')) events.push(event);

  assert.deepEqual(eventTypes(events), ['text', 'done']);
  assert.equal(events[0].text, 'Hi there — how can I help today?');
  assert.equal(streamCalls.length, callsBefore + 1);

  assert.equal(insertedMessages.length, 2);
  assert.equal(insertedMessages[0].role, 'user');
  assert.equal(insertedMessages[0].content, 'hello coach');
  assert.equal(insertedMessages[1].role, 'assistant');
  assert.equal(insertedMessages[1].speaker, 'coach');
  assert.equal(insertedMessages[1].content, 'Hi there — how can I help today?');
  assert.equal(insertedMessages[1].specialist_session_id, null);
  assert.equal(events[1].messageId, `message-${nextMessageId - 1}`);
});

test('accepting a handoff continues straight into the specialist\'s streamed opening turn', async () => {
  process.env.SPECIALISTS_ENABLED = 'true';
  const { runSpecialistAction } = await coachPromise;
  const userId = randomUUID();
  const session = seedProposedSession({ userId });
  insertedMessages = [];
  responseQueue = [{
    text: 'Good to have that context — let\'s rebuild toward 20km/week safely.',
    stopReason: 'end_turn',
  }];
  const callsBefore = streamCalls.length;

  const events: Array<{ type: string; text?: string; messageId?: string }> = [];
  for await (const event of runSpecialistAction(userId, {
    sessionId: session.id, cardOccurrenceId: session.cardOccurrenceId,
    actionId: 'action-accept-1', action: 'accept_handoff',
  })) events.push(event);

  assert.deepEqual(eventTypes(events), ['handoff_card', 'persona_changed', 'text', 'done']);
  assert.equal(events[2].text, 'Good to have that context — let\'s rebuild toward 20km/week safely.');
  assert.equal(streamCalls.length, callsBefore + 1); // exactly one model call

  // No user message persisted for the opening turn — only the specialist's own.
  assert.equal(insertedMessages.length, 1);
  assert.equal(insertedMessages[0].role, 'assistant');
  assert.equal(insertedMessages[0].speaker, 'specialist');
  assert.equal(insertedMessages[0].specialist_session_id, session.id);
  assert.equal(insertedMessages[0].content, 'Good to have that context — let\'s rebuild toward 20km/week safely.');

  // done carries the persisted DB message id, not the actionId.
  assert.notEqual(events[3].messageId, 'action-accept-1');
  assert.equal(events[3].messageId, `message-${nextMessageId - 1}`);

  // The seed is a kickoff instruction, not a replayed user message.
  const sent = streamCalls[streamCalls.length - 1].messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  const sentText = sent[0].content.map((b) => b.text ?? '').join('\n');
  assert.match(sentText, /INTERNAL INSTRUCTION/);
  assert.match(sentText, /address the consultation objective directly/);
  assert.doesNotMatch(sentText, /\nUser: /);
});

test('replaying an already-applied accept_handoff makes no model call and keeps the legacy done', async () => {
  process.env.SPECIALISTS_ENABLED = 'true';
  const { runSpecialistAction } = await coachPromise;
  const userId = randomUUID();
  const session = seedProposedSession({ userId });
  responseQueue = [{ text: 'Opening line.', stopReason: 'end_turn' }];
  const input = {
    sessionId: session.id, cardOccurrenceId: session.cardOccurrenceId,
    actionId: 'action-replay-1', action: 'accept_handoff' as const,
  };

  const first: Array<{ type: string }> = [];
  for await (const event of runSpecialistAction(userId, input)) first.push(event);
  assert.deepEqual(eventTypes(first), ['handoff_card', 'persona_changed', 'text', 'done']);
  const callsAfterFirst = streamCalls.length;

  const second: Array<{ type: string; messageId?: string }> = [];
  for await (const event of runSpecialistAction(userId, input)) second.push(event);
  assert.deepEqual(eventTypes(second), ['handoff_card', 'persona_changed', 'done']);
  assert.equal(streamCalls.length, callsAfterFirst); // no new model call on replay
  assert.equal(second[2].messageId, 'action-replay-1');
});

test('declining a handoff stays a two-event stream with no model call', async () => {
  process.env.SPECIALISTS_ENABLED = 'true';
  const { runSpecialistAction } = await coachPromise;
  const userId = randomUUID();
  const session = seedProposedSession({ userId, manifestId: 'nutritionist' });
  const callsBefore = streamCalls.length;

  const events: Array<{ type: string; messageId?: string }> = [];
  for await (const event of runSpecialistAction(userId, {
    sessionId: session.id, cardOccurrenceId: session.cardOccurrenceId,
    actionId: 'action-decline-1', action: 'decline_handoff',
  })) events.push(event);

  assert.deepEqual(eventTypes(events), ['handoff_card', 'persona_changed', 'done']);
  assert.equal(streamCalls.length, callsBefore); // no model call at all
  assert.equal(events[2].messageId, 'action-decline-1');
});

test('accepting a return continues into a Vital-Coach-attributed turn, not the specialist', async () => {
  process.env.SPECIALISTS_ENABLED = 'true';
  const { runSpecialistAction } = await coachPromise;
  const userId = randomUUID();
  const session = seedReturnProposedSession({
    userId,
    returnHandoff: {
      outcomes: ['Agreed on a 4-week build back to 20km/week'],
      decisions: ['3 runs/week'],
      recommendations: ['Cap long runs at 8km for two weeks'],
      unresolvedRisks: [],
      nextSteps: ['Reassess after week 2'],
    },
  });
  insertedMessages = [];
  responseQueue = [{ text: 'Welcome back — sounds like a solid plan with the Running Coach.', stopReason: 'end_turn' }];

  const events: Array<{ type: string }> = [];
  for await (const event of runSpecialistAction(userId, {
    sessionId: session.id, cardOccurrenceId: session.cardOccurrenceId,
    actionId: 'action-return-1', action: 'accept_return',
  })) events.push(event);

  assert.deepEqual(eventTypes(events), ['handoff_card', 'persona_changed', 'text', 'done']);
  assert.equal(insertedMessages.length, 1);
  assert.equal(insertedMessages[0].speaker, 'coach');
  assert.equal(insertedMessages[0].specialist_session_id, null);

  const sent = streamCalls[streamCalls.length - 1].messages as Array<{ content: Array<{ type: string; text?: string }> }>;
  const sentText = sent[0].content.map((b) => b.text ?? '').join('\n');
  assert.match(sentText, /picking the conversation back up/);
  assert.match(sentText, /Agreed on a 4-week build back to 20km\/week/);
});

/**
 * The genuinely new risk this refactor introduces. On the send path a model
 * failure strands nothing — the session was never switched. On the ACTION
 * path apply() has already committed the transition to 'active' before the
 * turn starts, so a failure mid-opening-turn could leave the user parked on
 * a specialist persona that will never speak. This pins the actual contract
 * the iOS client receives in that case.
 */
test('a model failure during the opening turn rolls the client back to Vital and fails the session', async () => {
  process.env.SPECIALISTS_ENABLED = 'true';
  const { runSpecialistAction } = await coachPromise;
  const userId = randomUUID();
  const session = seedProposedSession({ userId });
  insertedMessages = [];
  // No text before the failure: the specialist never gets a word out.
  responseQueue = [{ text: '', failWith: new Error('provider 529 overloaded') }];

  const events: Array<{ type: string; persona?: { id: string } }> = [];
  let thrown: unknown = null;
  try {
    for await (const event of runSpecialistAction(userId, {
      sessionId: session.id, cardOccurrenceId: session.cardOccurrenceId,
      actionId: 'action-fail-1', action: 'accept_handoff',
    })) events.push(event);
  } catch (error) {
    thrown = error;
  }

  // The rollback event reaches the consumer BEFORE the generator throws — an
  // async generator delivers a yielded value and only throws on the next
  // pull — so the client is told to go back to Vital rather than being left
  // silently on the specialist.
  assert.deepEqual(eventTypes(events), ['handoff_card', 'persona_changed', 'persona_changed']);
  assert.equal(events[1].persona?.id, 'running-coach'); // forward switch, from apply()
  assert.equal(events[2].persona?.id, 'vital');         // rollback, from the catch

  // ...and the turn still terminates as an error, not a `done`. The client
  // gets no `done` on this path; httpHandlers turns this into an SSE
  // {type:'error'} after having already forwarded the persona_changed above.
  assert.ok(thrown instanceof Error);
  assert.match((thrown as Error).message, /temporarily unavailable/);
  assert.equal(eventTypes(events).includes('done'), false);

  // Server state agrees with what the client was just told.
  assert.equal(sessionRows.get(session.id)?.status, 'failed');
  assert.equal(sessionRows.get(session.id)?.failureReason, 'premium_model_unavailable');

  // Nothing half-written: the step-6 persist is never reached.
  assert.equal(insertedMessages.length, 0);
});
