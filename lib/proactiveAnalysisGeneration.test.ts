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

const evidence = {
  input: { source: 'workout' },
  context: { enabled: true, timezone: 'UTC', baselines: {}, profile: {}, metrics: [{ metric: 'hrv_sdnn', value: 45 }] },
};
const promptInput = { kind: 'workout' as const, date: '2026-07-13', input: evidence.input, availableContext: evidence.context };
const valid = {
  headline: 'A useful signal',
  shortInsight: 'Recovery held steady.',
  narrative: 'Your HRV was 45 ms.',
  observations: ['HRV data was available.'],
  nextSteps: ['Keep today comfortable.'],
};

test('defaults to Sonnet 4.6 and preserves the environment override', () => {
  assert.equal(proactiveAnalysisModel({} as NodeJS.ProcessEnv), 'claude-sonnet-4-6');
  assert.equal(proactiveAnalysisModel({ PROACTIVE_ANALYSIS_MODEL: 'custom-model' } as unknown as NodeJS.ProcessEnv), 'custom-model');
});

test('initial and repair prompts forbid every derived-number class', () => {
  for (const phrase of ['arithmetic', 'ratios', 'percentages', 'differences', 'unit conversion', 'rounding', 'estimation', 'extrapolation', 'numeric list labels']) {
    assert.match(PROACTIVE_ANALYSIS_SYSTEM_PROMPT, new RegExp(phrase, 'i'));
    assert.match(PROACTIVE_ANALYSIS_REPAIR_PROMPT, new RegExp(phrase, 'i'));
  }
  for (const prompt of [PROACTIVE_ANALYSIS_SYSTEM_PROMPT, PROACTIVE_ANALYSIS_REPAIR_PROMPT]) {
    assert.match(prompt, /JSON only/i);
    assert.match(prompt, /observational/i);
    assert.match(prompt, /not diagnostic/i);
    assert.match(prompt, /exact supplied value/i);
    assert.match(prompt, /same unit as (?:that|the) source/i);
  }
});

test('valid initial output returns after one call', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const result = await generateGroundedAnalysis({
    promptInput,
    evidence,
    generate: async (request) => { calls.push(request); return JSON.stringify(valid); },
    report: () => {},
  });
  assert.deepEqual(result, valid);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { attempt: 'initial', system: PROACTIVE_ANALYSIS_SYSTEM_PROMPT, content: JSON.stringify(promptInput) });
});

const rejectedCases: Array<{ name: string; rejected: string; category: AnalysisFailureCategory }> = [
  { name: 'malformed JSON', rejected: '{"headline":', category: 'parse_failure' },
  { name: 'schema-invalid JSON', rejected: JSON.stringify({ headline: 'Incomplete' }), category: 'schema_failure' },
  { name: 'unsupported number', rejected: JSON.stringify({ ...valid, narrative: 'Your HRV was 99 ms.' }), category: 'grounding_failure' },
  { name: 'mismatched unit', rejected: JSON.stringify({ ...valid, narrative: 'Your HRV was 45 bpm.' }), category: 'grounding_failure' },
];

for (const { name, rejected, category } of rejectedCases) {
  test(`${name} is classified and repaired exactly once`, async () => {
    const calls: AnalysisGenerationRequest[] = [];
    const events: AnalysisFailureEvent[] = [];
    const result = await generateGroundedAnalysis({
      promptInput,
      evidence,
      generate: async (request) => {
        calls.push(request);
        return calls.length === 1 ? rejected : JSON.stringify(valid);
      },
      report: (event) => events.push(event),
    });

    assert.deepEqual(result, valid);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], {
      attempt: 'repair',
      system: PROACTIVE_ANALYSIS_REPAIR_PROMPT,
      content: JSON.stringify({ promptInput, rejectedText: rejected, category }),
    });
    assert.deepEqual(events, [
      analysisFailureEvent('initial', category, 'repair_started'),
      analysisFailureEvent('repair', category, 'repair_succeeded'),
    ]);
  });
}

const failedRepairs: Array<{ name: string; repair: string; category: AnalysisFailureCategory }> = [
  { name: 'parse', repair: 'not-json', category: 'parse_failure' },
  { name: 'schema', repair: JSON.stringify({ ...valid, nextSteps: 'rest' }), category: 'schema_failure' },
  { name: 'grounding', repair: JSON.stringify({ ...valid, narrative: 'Your HRV was 46 ms.' }), category: 'grounding_failure' },
];

for (const { name, repair, category } of failedRepairs) {
  test(`a ${name}-invalid repair is exhausted without another model call`, async () => {
    const calls: AnalysisGenerationRequest[] = [];
    const events: AnalysisFailureEvent[] = [];
    await assert.rejects(
      generateGroundedAnalysis({
        promptInput,
        evidence,
        generate: async (request) => {
          calls.push(request);
          return calls.length === 1 ? '{' : repair;
        },
        report: (event) => events.push(event),
      }),
      (error: unknown) => error instanceof AnalysisContentError && error.category === category,
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(events, [
      analysisFailureEvent('initial', 'parse_failure', 'repair_started'),
      analysisFailureEvent('repair', category, 'repair_exhausted'),
    ]);
  });
}

for (const { name, error } of [
  { name: 'transport', error: new Error('upstream token secret-token failed') },
  { name: 'no-text', error: new Error('analysis model returned no text') },
]) {
  test(`${name} errors reject after one call without content-repair events`, async () => {
    let calls = 0;
    const events: AnalysisFailureEvent[] = [];
    await assert.rejects(generateGroundedAnalysis({
      promptInput,
      evidence,
      generate: async () => { calls += 1; throw error; },
      report: (event) => events.push(event),
    }), error);
    assert.equal(calls, 1);
    assert.deepEqual(events, []);
  });
}

test('failure events serialize only their typed non-sensitive fields', async () => {
  const rejected = '{"response":"private-rejected-text","id":"job-123","uuid":"550e8400-e29b-41d4-a716-446655440000","token":"secret-token"}';
  const privateEvidence = {
    ...evidence,
    input: { source: 'sensitive-source', accountId: 'account-987' },
    exception: { message: 'private-exception', stack: 'private-stack', cause: 'private-cause' },
  };
  const events: AnalysisFailureEvent[] = [];
  await assert.rejects(generateGroundedAnalysis({
    promptInput,
    evidence: privateEvidence,
    generate: async (request) => request.attempt === 'initial' ? rejected : 'still-not-json',
    report: (event) => events.push(event),
  }), AnalysisContentError);

  const serialized = JSON.stringify(events);
  assert.deepEqual(JSON.parse(serialized), [
    analysisFailureEvent('initial', 'schema_failure', 'repair_started'),
    analysisFailureEvent('repair', 'parse_failure', 'repair_exhausted'),
  ]);
  for (const forbidden of [
    rejected,
    'private-rejected-text',
    'sensitive-source',
    'account-987',
    'private-exception',
    'job-123',
    '550e8400-e29b-41d4-a716-446655440000',
    'secret-token',
    PROACTIVE_ANALYSIS_SYSTEM_PROMPT,
    PROACTIVE_ANALYSIS_REPAIR_PROMPT,
    'private-stack',
    'private-cause',
  ]) assert.equal(serialized.includes(forbidden), false, `event leaked ${forbidden}`);
});
