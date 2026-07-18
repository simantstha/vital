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

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
}

function parseLiveResponse(text: string): unknown {
  const fence = text.match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return JSON.parse(fence ? fence[1] : text);
}

function payloadOf(request: AnalysisGenerationRequest): Record<string, unknown> {
  const payload: unknown = JSON.parse(request.content);
  assertRecord(payload);
  return payload;
}

function durationToken(request: AnalysisGenerationRequest): string {
  const payload = request.attempt === 'initial' ? payloadOf(request) : payloadOf(request).request;
  assertRecord(payload);
  const input = payload.input;
  assertRecord(input);
  const duration = input.durationMin;
  assert.ok(typeof duration === 'string');
  return duration;
}

function tokenResponse(request: AnalysisGenerationRequest): string {
  return JSON.stringify({ ...valid, narrative: `Workout duration was ${durationToken(request)}.` });
}

function assertGuarded(request: AnalysisGenerationRequest): void {
  assert.doesNotMatch(request.system + request.content, /\p{N}/u);
}

test('defaults to Haiku model and preserves the environment override', () => {
  assert.equal(proactiveAnalysisModel({} as NodeJS.ProcessEnv), 'claude-haiku-4-5');
  assert.equal(proactiveAnalysisModel({ PROACTIVE_ANALYSIS_MODEL: 'custom-model' } as unknown as NodeJS.ProcessEnv), 'custom-model');
});

for (const [name, prompt] of [
  ['system', PROACTIVE_ANALYSIS_SYSTEM_PROMPT],
  ['repair', PROACTIVE_ANALYSIS_REPAIR_PROMPT],
] as const) {
  test(`${name} prompt expresses the closed token contract without numeric code points`, () => {
    assert.doesNotMatch(prompt, /\p{N}/u);
    assert.match(prompt, /headline, shortInsight, and narrative must each be a non-empty JSON string/i);
    assert.match(prompt, /observations and nextSteps must each be a JSON array of non-empty JSON strings/i);
    assert.match(prompt, /no additional keys/i);
    assert.match(prompt, /JSON only/i);
    assert.match(prompt, /observational/i);
    assert.match(prompt, /non-diagnostic/i);
    assert.match(prompt, /copy only supplied evidence tokens exactly/i);
    assert.match(prompt, /cite the session's key metrics/i);
    assert.match(prompt, /duration, distance, pace, and average heart rate/i);
    assert.match(prompt, /duration and efficiency/i);
    assert.match(prompt, /verified recorded value/i);
    assert.match(prompt, /already includes its display unit/i);
    assert.match(prompt, /treat evidence tokens as real measurements/i);
    assert.match(prompt, /not placeholders or missing data/i);
    assert.match(prompt, /never describe the request as containing placeholders/i);
    assert.match(prompt, /template variables/i);
    assert.match(prompt, /unresolved tokens/i);
    assert.match(prompt, /data integrity problem/i);
    assert.match(prompt, /never repeat an evidence token anywhere in the response/i);
    assert.match(prompt, /final content of (?:its|the) clause or string/i);
    assert.match(prompt, /immediately before (?:a )?terminal punctuation mark/i);
    for (const prohibitedAfterToken of ['unit', 'qualifier', 'parenthetical', 'symbol', 'prose']) {
      assert.match(prompt, new RegExp(prohibitedAfterToken, 'i'));
    }
    assert.match(prompt, /no content after the token in that clause/i);
    assert.match(prompt, /scalar string or (?:an )?individual array-item string/i);
    assert.doesNotMatch(prompt, /five schema string locations/i);
    for (const rule of ['alter', 'split', 'concatenate', 'nest', 'enumerate', 'manufacture', 'raw number', 'numeric symbol sequence', 'unit', 'sign', 'symbol']) {
      assert.match(prompt, new RegExp(rule, 'i'));
    }
  });

  test(`${name} prompt's content contract keeps the popup short and metric-anchored`, () => {
    assert.doesNotMatch(prompt, /\p{N}/u);
    assert.match(prompt, /names? the workout type or sleep in the headline/i);
    assert.match(prompt, /a few words/i);
    assert.match(prompt, /single most notable metric/i);
    assert.match(prompt, /at most three sentences/i);
    assert.match(prompt, /this session only/i);
    assert.match(prompt, /anchor each observation to a supplied metric/i);
    assert.match(prompt, /two or three observations/i);
    assert.match(prompt, /one or two next steps/i);
    assert.match(prompt, /never repeat the same fact or profile detail in more than one field/i);
  });
}

test('live response inspection accepts plain JSON and one complete JSON fence', () => {
  const payload = JSON.stringify(valid);
  assert.deepEqual(parseLiveResponse(payload), valid);
  assert.deepEqual(parseLiveResponse(`\`\`\`json\n${payload}\n\`\`\``), valid);
});

test('synthetic live proactive analysis returns typed grounded output', {
  skip: process.env.RUN_PROACTIVE_ANALYSIS_LIVE_TEST !== 'true',
}, async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const liveSource: ProactiveAnalysisSource = {
    ...source,
    input: { request: 'Mention the supplied synthetic HRV evidence value in an observation.' },
  };
  const proof = await generateGroundedAnalysis({
    source: liveSource,
    generate: async (request) => {
      const response = await anthropic.messages.create({
        model: proactiveAnalysisModel(process.env),
        max_tokens: 700,
        system: request.system,
        messages: [{ role: 'user', content: request.content }],
      });
      const textBlocks = response.content.filter((item) => item.type === 'text');
      assert.equal(textBlocks.length, 1);
      const raw = parseLiveResponse(textBlocks[0].text);
      assertRecord(raw);
      const rawObservations = raw.observations;
      const rawNextSteps = raw.nextSteps;
      assert.ok(Array.isArray(rawObservations));
      assert.ok(rawObservations.every((item) => typeof item === 'string' && item.trim()));
      assert.ok(rawObservations.some((item) => /⟦EVIDENCE_[A-Z]+⟧/.test(item)));
      assert.ok(Array.isArray(rawNextSteps));
      assert.ok(rawNextSteps.every((item) => typeof item === 'string' && item.trim()));
      return textBlocks[0].text;
    },
    report: () => {},
  });

  const resolved = consumeGroundedAnalysisProof(proof, liveSource);
  assert.deepEqual(Object.keys(resolved), ['headline', 'shortInsight', 'narrative', 'observations', 'nextSteps']);
  for (const key of ['headline', 'shortInsight', 'narrative'] as const) {
    assert.ok(typeof resolved[key] === 'string' && resolved[key].trim());
  }
  for (const key of ['observations', 'nextSteps'] as const) {
    assert.ok(Array.isArray(resolved[key]));
    assert.ok(resolved[key].every((item) => typeof item === 'string' && item.trim()));
  }
  assert.ok(resolved.observations.some((item) => item.includes('45 ms')));
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
  assert.match(consumeGroundedAnalysisProof(proof, source).narrative, /38 minutes/);
});

test('screenshot-style token-free meta-response repairs with source-input evidence', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const events: AnalysisFailureEvent[] = [];
  const screenshotResponse = JSON.stringify({
    ...valid,
    headline: 'Unable to process workout data',
    shortInsight: 'The workout record contains placeholder tokens.',
    narrative: 'Data integrity must be restored before analysis can continue.',
  });
  const proof = await generateGroundedAnalysis({
    source,
    generate: async (request) => {
      calls.push(request);
      assertGuarded(request);
      return request.attempt === 'initial' ? screenshotResponse : tokenResponse(request);
    },
    report: (event) => events.push(event),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].content.includes('Unable to process workout data'), false);
  assert.equal(calls[1].content.includes('placeholder tokens'), false);
  assert.deepEqual(events, [
    analysisFailureEvent('initial', 'grounding_failure', 'repair_started'),
    analysisFailureEvent('repair', 'grounding_failure', 'repair_succeeded'),
  ]);
  assert.match(consumeGroundedAnalysisProof(proof, source).narrative, /38 minutes/);
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
    assert.match(consumeGroundedAnalysisProof(proof, source).narrative, /38 minutes/);
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
  consumeGroundedAnalysisProof(proof, mutableSource);
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
  consumeGroundedAnalysisProof(proof, source);
  assert.deepEqual(reads, { kind: 1, date: 1, input: 1, availableContext: 1 });
});
