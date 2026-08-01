import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalysisContentError,
  PROACTIVE_ANALYSIS_REPAIR_PROMPT,
  PROACTIVE_ANALYSIS_SYSTEM_PROMPT,
  analysisFailureEvent,
  generateAnalysis,
  proactiveAnalysisModel,
  type AnalysisFailureCategory,
  type AnalysisFailureEvent,
  type AnalysisGenerationRequest,
} from './proactiveAnalysisGeneration';
import { type ProactiveAnalysisSource } from './proactiveAnalysisGrounding';
import { formatAnalysisSource } from './proactiveAnalysisFormatting';

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
  narrative: 'This session ran longer than usual and your heart rate stayed comfortably low.',
  observations: ['Duration was longer than your recent average.'],
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

const validResponse = (): string => JSON.stringify(valid);

test('defaults to Sonnet model and preserves the environment override', () => {
  assert.equal(proactiveAnalysisModel({} as NodeJS.ProcessEnv), 'claude-sonnet-5');
  assert.equal(proactiveAnalysisModel({ PROACTIVE_ANALYSIS_MODEL: 'custom-model' } as unknown as NodeJS.ProcessEnv), 'custom-model');
});

for (const [name, prompt] of [
  ['system', PROACTIVE_ANALYSIS_SYSTEM_PROMPT],
  ['repair', PROACTIVE_ANALYSIS_REPAIR_PROMPT],
] as const) {
  test(`${name} prompt states the schema and the no-numeral contract`, () => {
    assert.doesNotMatch(prompt, /\p{N}/u);
    assert.match(prompt, /headline, shortInsight, and narrative must each be a non-empty JSON string/i);
    assert.match(prompt, /observations and nextSteps must each be a JSON array of non-empty JSON strings/i);
    assert.match(prompt, /no additional keys/i);
    assert.match(prompt, /JSON only/i);
    assert.match(prompt, /observational/i);
    assert.match(prompt, /non-diagnostic/i);
    assert.match(prompt, /metrics card shown directly above this text/i);
    assert.match(prompt, /redundant/i);
    assert.match(prompt, /describe the session qualitatively/i);
    assert.match(prompt, /faster or slower/i);
    assert.match(prompt, /above or below baseline/i);
    assert.match(prompt, /never write a digit/i);
    assert.doesNotMatch(prompt, /evidence token/i);
    assert.doesNotMatch(prompt, /copy .*exactly/i);
  });

  test(`${name} prompt's content contract keeps the popup short and qualitative`, () => {
    assert.match(prompt, /names? the workout type or sleep in the headline/i);
    assert.match(prompt, /a few words/i);
    assert.match(prompt, /single most notable aspect/i);
    assert.match(prompt, /at most three sentences/i);
    assert.match(prompt, /this session only/i);
    assert.match(prompt, /two or three observations qualitatively/i);
    assert.match(prompt, /one or two next steps/i);
    assert.match(prompt, /mention profile or goal context only when it changes what the user should do next/i);
    assert.doesNotMatch(prompt, /cite the session's key metrics/i);
    assert.doesNotMatch(prompt, /anchor each observation to a supplied metric/i);
  });
}

test('the model receives a pre-formatted source', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  await generateAnalysis({
    source,
    generate: async (request) => { calls.push(request); return validResponse(); },
    report: () => {},
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(payloadOf(calls[0]), formatAnalysisSource(source) as unknown as Record<string, unknown>);
  // durationMin is a whitelisted workout key — it's rounded, unit-labeled, and renamed to `duration`,
  // so the raw key/value never reaches the model (see lib/proactiveAnalysisFormatting.ts).
  assert.doesNotMatch(calls[0].content, /"durationMin":38/);
  assert.match(calls[0].content, /"duration":"38 min"/);
  assert.doesNotMatch(calls[0].content, /EVIDENCE/);
});

test('both the initial and repair requests carry the same pre-formatted source', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  await generateAnalysis({
    source,
    generate: async (request) => {
      calls.push(request);
      return request.attempt === 'initial' ? '{' : validResponse();
    },
    report: () => {},
  });

  assert.deepEqual(calls.map((call) => call.attempt), ['initial', 'repair']);
  const formatted = formatAnalysisSource(source) as unknown as Record<string, unknown>;
  assert.deepEqual(payloadOf(calls[0]), formatted);
  assert.deepEqual(payloadOf(calls[1]), { category: 'parse_failure', request: formatted });
});

test('live response inspection accepts plain JSON and one complete JSON fence', () => {
  const payload = JSON.stringify(valid);
  assert.deepEqual(parseLiveResponse(payload), valid);
  assert.deepEqual(parseLiveResponse(`\`\`\`json\n${payload}\n\`\`\``), valid);
});

test('synthetic live proactive analysis returns typed digit-free output', {
  skip: process.env.RUN_PROACTIVE_ANALYSIS_LIVE_TEST !== 'true',
}, async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resolved = await generateAnalysis({
    source,
    generate: async (request) => {
      const response = await anthropic.messages.create({
        model: proactiveAnalysisModel(process.env),
        max_tokens: 700,
        system: request.system,
        messages: [{ role: 'user', content: request.content }],
      });
      const textBlocks = response.content.filter((item) => item.type === 'text');
      assert.equal(textBlocks.length, 1);
      return textBlocks[0].text;
    },
    report: () => {},
  });

  assert.deepEqual(Object.keys(resolved), ['headline', 'shortInsight', 'narrative', 'observations', 'nextSteps']);
  for (const key of ['headline', 'shortInsight', 'narrative'] as const) {
    assert.ok(typeof resolved[key] === 'string' && resolved[key].trim());
  }
  for (const key of ['observations', 'nextSteps'] as const) {
    assert.ok(Array.isArray(resolved[key]));
    assert.ok(resolved[key].every((item) => typeof item === 'string' && item.trim()));
  }
  assert.doesNotMatch(JSON.stringify(resolved), /\p{N}/u);
});

test('digit-free prose is returned after exactly one call with no failure events', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const events: AnalysisFailureEvent[] = [];
  const result = await generateAnalysis({
    source,
    generate: async (request) => { calls.push(request); return validResponse(); },
    report: (event) => events.push(event),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].attempt, 'initial');
  assert.deepEqual(events, []);
  assert.deepEqual(result, valid);
});

test('a numeral in the prose fails as a grounding failure and triggers one repair', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const events: AnalysisFailureEvent[] = [];
  const result = await generateAnalysis({
    source,
    generate: async (request) => {
      calls.push(request);
      return request.attempt === 'initial'
        ? JSON.stringify({ ...valid, narrative: 'You ran for 38 minutes.' })
        : validResponse();
    },
    report: (event) => events.push(event),
  });

  assert.deepEqual(calls.map((call) => call.attempt), ['initial', 'repair']);
  assert.deepEqual(events, [
    analysisFailureEvent('initial', 'grounding_failure', 'repair_started'),
    analysisFailureEvent('repair', 'grounding_failure', 'repair_succeeded'),
  ]);
  assert.deepEqual(result, valid);
});

test('screenshot-style meta-response repairs into digit-free prose', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const events: AnalysisFailureEvent[] = [];
  const screenshotResponse = JSON.stringify({
    ...valid,
    headline: 'Unable to process workout data',
    shortInsight: 'The workout record contains placeholder tokens.',
    narrative: 'Data integrity must be restored before analysis can continue.',
  });
  const result = await generateAnalysis({
    source,
    generate: async (request) => {
      calls.push(request);
      return request.attempt === 'initial' ? screenshotResponse : validResponse();
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
  assert.deepEqual(result, valid);
});

const initialFailures: Array<{ name: string; response: string; category: AnalysisFailureCategory }> = [
  { name: 'parse', response: '{private rejected text', category: 'parse_failure' },
  { name: 'schema', response: JSON.stringify({ headline: 'private rejected text' }), category: 'schema_failure' },
  { name: 'grounding', response: JSON.stringify({ ...valid, narrative: 'private rejected text 99' }), category: 'grounding_failure' },
];

for (const { name, response, category } of initialFailures) {
  test(`initial ${name} failure repairs once with the same payload and no rejected data`, async () => {
    const calls: AnalysisGenerationRequest[] = [];
    const events: AnalysisFailureEvent[] = [];
    const result = await generateAnalysis({
      source,
      generate: async (request) => {
        calls.push(request);
        return request.attempt === 'initial' ? response : validResponse();
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
    assert.deepEqual(result, valid);
  });
}

const repairFailures: Array<{ name: string; response: string; category: AnalysisFailureCategory }> = [
  { name: 'parse', response: '{', category: 'parse_failure' },
  { name: 'schema', response: JSON.stringify({ ...valid, nextSteps: 'rest' }), category: 'schema_failure' },
  { name: 'grounding', response: JSON.stringify({ ...valid, narrative: 'HRV was 46 ms.' }), category: 'grounding_failure' },
];

for (const { name, response, category } of repairFailures) {
  test(`repair ${name} failure is exhausted after exactly two calls`, async () => {
    const calls: AnalysisGenerationRequest[] = [];
    const events: AnalysisFailureEvent[] = [];
    await assert.rejects(generateAnalysis({
      source,
      generate: async (request) => {
        calls.push(request);
        return request.attempt === 'initial' ? '{' : response;
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
    await assert.rejects(generateAnalysis({
      source,
      generate: async () => { calls += 1; throw error; },
      report: (event) => events.push(event),
    }), error);
    assert.equal(calls, 1);
    assert.deepEqual(events, []);
  });
}

test('source objects remain unchanged and unfrozen', async () => {
  const mutableSource = structuredClone(source);
  const snapshot = structuredClone(mutableSource);
  await generateAnalysis({
    source: mutableSource,
    generate: async () => validResponse(),
    report: () => {},
  });
  assert.deepEqual(mutableSource, snapshot);
  assert.equal(Object.isFrozen(mutableSource), false);
  assert.equal(Object.isFrozen(mutableSource.availableContext), false);
});
