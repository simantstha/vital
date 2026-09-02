import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as realSchema from '../../db/schema';

/**
 * Proves the prompt-caching breakpoints actually land. A green suite does NOT
 * prove this: a misplaced breakpoint produces zero cache hits silently — no
 * error, just `cache_creation_input_tokens: 0` forever. So the fake client
 * here does not return canned usage numbers; it *simulates the API's
 * prefix-match caching* against the request coach.ts really sends:
 *
 *   - renders `tools` -> `system` -> `messages` (the API's documented order)
 *   - hashes the cumulative prefix at every `cache_control` block
 *   - reports a read for the longest prefix already seen, a write for the
 *     remainder up to the last breakpoint, and `input_tokens` for whatever
 *     follows it
 *   - enforces the 4-breakpoint cap and the 2048-token minimum prefix
 *     (claude-sonnet-4-6) — both of which silently degrade in production
 *
 * That makes the assertions load-bearing: move a breakpoint, stop rolling it,
 * or shrink the prefix below the minimum, and these numbers change.
 *
 * Lives in its own file (not coach.test.ts) because it needs a realistically
 * large BRAIN_TOOLS to clear the minimum cacheable prefix, and node:test runs
 * each file in its own subprocess so the mocks can't collide.
 */

process.env.SPECIALIST_MODEL ??= 'claude-test-specialist';
process.env.SPECIALISTS_ENABLED = 'false';

/** claude-sonnet-4-6's minimum cacheable prefix. Below this the API caches nothing. */
const CACHE_MIN_TOKENS = 2048;
/** The API's hard cap on cache_control breakpoints in one request. */
const MAX_BREAKPOINTS = 4;

const approxTokens = (text: string): number => Math.ceil(text.length / 4);

interface RoundUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  breakpoints: number;
}

/** Prefixes the simulated API has cached: exact bytes -> token count. */
const cachedPrefixes = new Map<string, number>();
const roundUsage: RoundUsage[] = [];

// Capture the structured logs coach.ts emits. The production cache signal IS
// a log line, so the log itself needs a test — nothing else would catch its
// removal, and a missing cache signal is exactly as silent as a missing cache.
const logEntries: Array<{ channel: string; payload: Record<string, unknown> }> = [];
console.info = ((channel: unknown, payload?: unknown) => {
  logEntries.push({
    channel: String(channel),
    payload: (payload ?? {}) as Record<string, unknown>,
  });
}) as typeof console.info;

interface StreamParams {
  system: Array<{ text: string; cache_control?: unknown }>;
  tools: unknown[];
  messages: Array<{ role: string; content: unknown }>;
}

function simulateCaching(params: StreamParams): RoundUsage {
  // Flatten the request into render order. Tools lead, so a breakpoint on the
  // last system block covers them — that's the whole point of the placement.
  const segments: Array<{ text: string; breakpoint: boolean }> = [
    { text: JSON.stringify(params.tools), breakpoint: false },
  ];
  for (const block of params.system) {
    segments.push({ text: JSON.stringify(block.text), breakpoint: block.cache_control != null });
  }
  for (const message of params.messages) {
    const blocks = Array.isArray(message.content)
      ? message.content as Array<Record<string, unknown>>
      : [{ type: 'text', text: message.content }];
    for (const block of blocks) {
      const { cache_control, ...rest } = block;
      segments.push({ text: JSON.stringify(rest), breakpoint: cache_control != null });
    }
  }

  const breakpoints = segments.filter((segment) => segment.breakpoint).length;
  if (breakpoints > MAX_BREAKPOINTS) {
    throw new Error(`request carries ${breakpoints} cache_control breakpoints (max ${MAX_BREAKPOINTS})`);
  }

  let prefix = '';
  let cumulative = 0;
  let lastBreakpoint = 0;
  let lastBreakpointPrefix = '';
  const toStore: Array<[string, number]> = [];
  for (const segment of segments) {
    prefix += segment.text;
    cumulative += approxTokens(segment.text);
    // A breakpoint under the minimum prefix is silently inert in the real API.
    if (!segment.breakpoint || cumulative < CACHE_MIN_TOKENS) continue;
    toStore.push([prefix, cumulative]);
    lastBreakpoint = cumulative;
    lastBreakpointPrefix = prefix;
  }

  // A breakpoint does not need a prior breakpoint at the SAME position to hit.
  // The API walks backward from it to find any earlier cached prefix (up to a
  // 20-block lookback). So the read is the longest cached entry that is still
  // a prefix of this request — which is how a rolling breakpoint accrues the
  // conversation incrementally instead of re-writing it every round.
  let readTokens = 0;
  for (const [entry, entryTokens] of cachedPrefixes) {
    if (entryTokens > readTokens && lastBreakpointPrefix.startsWith(entry)) readTokens = entryTokens;
  }
  for (const [entry, entryTokens] of toStore) cachedPrefixes.set(entry, entryTokens);

  const usage: RoundUsage = {
    // Everything after the final breakpoint is reprocessed at full price.
    input_tokens: cumulative - lastBreakpoint,
    cache_creation_input_tokens: Math.max(0, lastBreakpoint - readTokens),
    cache_read_input_tokens: readTokens,
    output_tokens: 5,
    breakpoints,
  };
  roundUsage.push(usage);
  return usage;
}

type FakeResponse = { text: string; toolName?: string };
let responseQueue: FakeResponse[] = [];

const fakeAnthropicClient = {
  messages: {
    stream: (params: StreamParams) => {
      const usage = simulateCaching(params);
      const response = responseQueue.shift() ?? { text: 'done' };
      const content = response.toolName
        ? [{ type: 'tool_use', id: `toolu-${roundUsage.length}`, name: response.toolName, input: {} }]
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
          usage,
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

// Roughly the bulk of the real lib/brain/tools.ts (~1665 lines of schema).
// Sized deliberately: the tools+system prefix must clear CACHE_MIN_TOKENS or
// the real API would cache nothing and this test would be measuring a no-op.
const BIG_FAKE_TOOLS = Array.from({ length: 24 }, (_, index) => ({
  name: `fake_tool_${index}`,
  description: `Fake tool ${index}. `.repeat(20),
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 6 }, (_, p) => [`param_${p}`, { type: 'string', description: `Parameter ${p}. `.repeat(6) }]),
    ),
  },
}));

mock.module('./context', {
  namedExports: {
    assembleContext: async () => ({
      hardConstraints: [],
      calibration: { status: 'ready', metrics: {} },
      unitSystem: 'metric',
      recentMessages: [],
      // Volatile per-request content. Lives in the user message, i.e. AFTER
      // the system breakpoint — round 1's uncached remainder.
      promptText: 'APPLICATION CONTEXT. '.repeat(40),
    }),
  },
});
mock.module('./tools', {
  namedExports: {
    BRAIN_TOOLS: BIG_FAKE_TOOLS,
    executeToolCall: async () => JSON.stringify({ ok: true, rows: 'result payload '.repeat(10) }),
    toolCallLabel: () => 'checking your data',
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

test('a multi-round turn writes the tools+system prefix once, then reads it back on every later round', async () => {
  const { runCoach } = await coachPromise;
  // Three rounds: two tool calls, then a final text answer.
  responseQueue = [
    { text: '', toolName: 'fake_tool_0' },
    { text: '', toolName: 'fake_tool_1' },
    { text: 'Here is your answer.' },
  ];

  for await (const _event of runCoach(randomUUID(), 'how did I sleep?')) { /* drain */ }

  assert.equal(roundUsage.length, 3, 'expected a three-round turn');
  const [first, second, third] = roundUsage;

  // Round 1 seeds the cache: it writes the tools+system prefix and reads nothing.
  assert.equal(first.cache_read_input_tokens, 0);
  assert.ok(
    first.cache_creation_input_tokens > 0,
    'round 1 must write a cache entry — zero here means the prefix never cleared the minimum',
  );

  // Rounds 2+ are the payoff: the prefix is read back instead of reprocessed.
  assert.ok(
    second.cache_read_input_tokens > 0,
    'round 2 read nothing from cache — the system breakpoint is misplaced',
  );
  assert.ok(
    third.cache_read_input_tokens > second.cache_read_input_tokens,
    'cache reads must GROW each round — if they plateau at the system prefix, ' +
      'the rolling message breakpoint is not landing on the appended turn',
  );

  // The uncached remainder collapses: round 1 pays full price for the context
  // block and user message, later rounds pay for almost nothing.
  assert.ok(
    first.input_tokens > 0,
    'round 1 should have an uncached remainder (context + user message)',
  );
  assert.ok(
    second.input_tokens < first.input_tokens / 4,
    `round 2 input_tokens (${second.input_tokens}) should be far below round 1 (${first.input_tokens})`,
  );
  assert.ok(third.input_tokens < first.input_tokens / 4);

  // Total prompt size is conserved — the win is repricing, not shrinkage.
  const total = (u: RoundUsage) =>
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  assert.ok(total(third) >= total(first), 'later rounds carry MORE prompt, just cheaper');
});

test('the coach path logs the cache split, so a silent cache regression is visible in production', () => {
  // One grep across both surfaces is the contract: specialist turns emit
  // `specialist_model_usage`, coach turns `coach_model_usage`.
  const usageLogs = logEntries.filter(
    (entry) => String(entry.payload.event ?? '').includes('model_usage'),
  );
  assert.equal(usageLogs.length, 1, 'expected exactly one usage log for the turn');

  const { payload } = usageLogs[0];
  assert.equal(payload.event, 'coach_model_usage');
  assert.equal(payload.speaker, 'coach');
  assert.equal(payload.sessionId, null, 'no specialist session on a plain coach turn');

  // The numbers that answer "are we getting cache hits in production", and
  // they must be the real per-round figures — not zeros from an unaccumulated
  // modelUsage, which is what the coach path reported before.
  const sum = (pick: (usage: RoundUsage) => number) => roundUsage.reduce((a, u) => a + pick(u), 0);
  assert.equal(payload.cacheReadInputTokens, sum((u) => u.cache_read_input_tokens));
  assert.equal(payload.cacheCreationInputTokens, sum((u) => u.cache_creation_input_tokens));
  assert.ok(
    (payload.cacheReadInputTokens as number) > 0,
    'a multi-round coach turn reporting zero cache reads means the cache is not landing',
  );
  assert.equal(payload.inputTokens, sum((u) => u.input_tokens) + sum((u) => u.cache_creation_input_tokens) + sum((u) => u.cache_read_input_tokens));
});

test('breakpoints never accumulate past the cap as rounds grow', () => {
  // One on system for the first request; the rolling message breakpoint adds
  // exactly one more and then MOVES. If it were appended per round instead of
  // rolled, a 10-round turn would carry 11 and the API would reject it.
  assert.deepEqual(roundUsage.map((usage) => usage.breakpoints), [1, 2, 2]);
  assert.ok(roundUsage.every((usage) => usage.breakpoints <= MAX_BREAKPOINTS));
});
