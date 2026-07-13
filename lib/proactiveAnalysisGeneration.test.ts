import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalysisContentError,
  PROACTIVE_ANALYSIS_REPAIR_PROMPT,
  PROACTIVE_ANALYSIS_SYSTEM_PROMPT,
  analysisFailureEvent,
  generateGroundedAnalysis,
  proactiveAnalysisModel,
  type AnalysisFailureCategory,
  type AnalysisFailureEvent,
  type AnalysisGenerationRequest,
} from './proactiveAnalysisGeneration';
import { consumeGroundedAnalysisProof, type ProactiveAnalysisSource } from './proactiveAnalysisGrounding';

const source: ProactiveAnalysisSource = {
  kind: 'workout',
  date: '2026-07-13',
  input: { workoutId: 'session-314', durationMin: 38 },
  availableContext: {
    enabled: true,
    timezone: 'UTC-05:00',
    profile: { age: 42 },
    metrics: [{ metric: 'hrv_sdnn', value: 45 }],
  },
};

const valid = {
  headline: 'A useful signal',
  shortInsight: 'Recovery held steady.',
  narrative: 'HRV was available.',
  observations: ['HRV data was available.'],
  nextSteps: ['Keep today comfortable.'],
};

function payloadOf(request: AnalysisGenerationRequest): Record<string, any> {
  return JSON.parse(request.content) as Record<string, any>;
}

function hrvToken(request: AnalysisGenerationRequest): string {
  const payload = request.attempt === 'initial' ? payloadOf(request) : payloadOf(request).request;
  return payload.availableContext.metrics[0].value as string;
}

function tokenResponse(request: AnalysisGenerationRequest): string {
  return JSON.stringify({ ...valid, narrative: `HRV was ${hrvToken(request)}.` });
}

function assertGuarded(request: AnalysisGenerationRequest): void {
  assert.doesNotMatch(request.system + request.content, /\p{N}/u);
}

test('defaults to Sonnet model and preserves the environment override', () => {
  assert.equal(proactiveAnalysisModel({} as NodeJS.ProcessEnv), 'claude-sonnet-4-6');
  assert.equal(proactiveAnalysisModel({ PROACTIVE_ANALYSIS_MODEL: 'custom-model' } as unknown as NodeJS.ProcessEnv), 'custom-model');
});

test('prompts express the closed token contract without numeric code points', () => {
  for (const prompt of [PROACTIVE_ANALYSIS_SYSTEM_PROMPT, PROACTIVE_ANALYSIS_REPAIR_PROMPT]) {
    assert.doesNotMatch(prompt, /\p{N}/u);
    assert.match(prompt, /JSON only/i);
    assert.match(prompt, /observational/i);
    assert.match(prompt, /non-diagnostic/i);
    assert.match(prompt, /copy only supplied evidence tokens exactly/i);
    assert.match(prompt, /five schema string locations/i);
    assert.match(prompt, /at most once/i);
    for (const rule of ['alter', 'split', 'concatenate', 'nest', 'enumerate', 'manufacture', 'raw number', 'numeric symbol sequence', 'qualitative language']) {
      assert.match(prompt, new RegExp(rule, 'i'));
    }
  }
});

test('valid token output returns a consumable proof after one guarded call', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const proof = await generateGroundedAnalysis({
    source,
    generate: async (request) => {
      calls.push(request);
      assertGuarded(request);
      return tokenResponse(request);
    },
    report: () => {},
  });

  assert.equal(calls.length, 1);
  assert.match(consumeGroundedAnalysisProof(proof).narrative, /45 ms/);
});

const initialFailures: Array<{ name: string; response: (request: AnalysisGenerationRequest) => string; category: AnalysisFailureCategory }> = [
  { name: 'parse', response: () => '{private rejected text', category: 'parse_failure' },
  { name: 'schema', response: () => JSON.stringify({ headline: 'private rejected text' }), category: 'schema_failure' },
  { name: 'grounding', response: () => JSON.stringify({ ...valid, narrative: 'private rejected text 99' }), category: 'grounding_failure' },
];

for (const { name, response, category } of initialFailures) {
  test(`initial ${name} failure repairs once with the same encoded payload and no rejected data`, async () => {
    const calls: AnalysisGenerationRequest[] = [];
    const events: AnalysisFailureEvent[] = [];
    const proof = await generateGroundedAnalysis({
      source,
      generate: async (request) => {
        calls.push(request);
        assertGuarded(request);
        return request.attempt === 'initial' ? response(request) : tokenResponse(request);
      },
      report: (event) => events.push(event),
    });

    assert.equal(calls.length, 2);
    const initialPayload = payloadOf(calls[0]);
    assert.deepEqual(payloadOf(calls[1]), { category, request: initialPayload });
    assert.equal(calls[1].content.includes('private rejected text'), false);
    assert.equal(calls[1].content.includes('Proactive analysis content validation failed'), false);
    assert.deepEqual(events, [
      analysisFailureEvent('initial', category, 'repair_started'),
      analysisFailureEvent('repair', category, 'repair_succeeded'),
    ]);
    assert.match(consumeGroundedAnalysisProof(proof).narrative, /45 ms/);
  });
}

const repairFailures: Array<{ name: string; response: (request: AnalysisGenerationRequest) => string; category: AnalysisFailureCategory }> = [
  { name: 'parse', response: () => '{', category: 'parse_failure' },
  { name: 'schema', response: () => JSON.stringify({ ...valid, nextSteps: 'rest' }), category: 'schema_failure' },
  { name: 'grounding', response: () => JSON.stringify({ ...valid, narrative: 'HRV was 46 ms.' }), category: 'grounding_failure' },
];

for (const { name, response, category } of repairFailures) {
  test(`repair ${name} failure is exhausted after exactly two calls`, async () => {
    const calls: AnalysisGenerationRequest[] = [];
    const events: AnalysisFailureEvent[] = [];
    await assert.rejects(generateGroundedAnalysis({
      source,
      generate: async (request) => {
        calls.push(request);
        assertGuarded(request);
        return request.attempt === 'initial' ? '{' : response(request);
      },
      report: (event) => events.push(event),
    }), (error: unknown) => error instanceof AnalysisContentError && error.category === category);

    assert.equal(calls.length, 2);
    assert.deepEqual(events, [
      analysisFailureEvent('initial', 'parse_failure', 'repair_started'),
      analysisFailureEvent('repair', category, 'repair_exhausted'),
    ]);
  });
}

for (const { name, error } of [
  { name: 'transport', error: new Error('transport private detail') },
  { name: 'authentication', error: new Error('authentication private detail') },
  { name: 'timeout', error: new Error('timeout private detail') },
  { name: 'no-text', error: new Error('no text private detail') },
]) {
  test(`${name} errors reject after one call without repair or content events`, async () => {
    let calls = 0;
    const events: AnalysisFailureEvent[] = [];
    await assert.rejects(generateGroundedAnalysis({
      source,
      generate: async (request) => { calls += 1; assertGuarded(request); throw error; },
      report: (event) => events.push(event),
    }), error);
    assert.equal(calls, 1);
    assert.deepEqual(events, []);
  });
}

test('source objects remain unchanged', async () => {
  const mutableSource = structuredClone(source);
  const snapshot = structuredClone(mutableSource);
  const proof = await generateGroundedAnalysis({
    source: mutableSource,
    generate: async (request) => tokenResponse(request),
    report: () => {},
  });
  consumeGroundedAnalysisProof(proof);
  assert.deepEqual(mutableSource, snapshot);
  assert.equal(Object.isFrozen(mutableSource), false);
  assert.equal(Object.isFrozen(mutableSource.availableContext), false);
});

test('source is encoded once per generation invocation', async () => {
  const reads = { kind: 0, date: 0, input: 0, availableContext: 0 };
  const countedSource = {} as ProactiveAnalysisSource;
  for (const key of Object.keys(reads) as Array<keyof typeof reads>) {
    Object.defineProperty(countedSource, key, {
      enumerable: true,
      get() {
        reads[key] += 1;
        return source[key];
      },
    });
  }
  const proof = await generateGroundedAnalysis({
    source: countedSource,
    generate: async (request) => request.attempt === 'initial' ? '{' : tokenResponse(request),
    report: () => {},
  });
  consumeGroundedAnalysisProof(proof);
  assert.deepEqual(reads, { kind: 1, date: 1, input: 1, availableContext: 1 });
});
