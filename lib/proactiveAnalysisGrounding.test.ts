import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalysisContentError,
  type GroundedAnalysisProof,
  assertNoRawNumbers,
  consumeGroundedAnalysisProof,
  encodeProactiveAnalysisRequest,
  groundAnalysisText,
  modelPayload,
  type ProactiveAnalysisSource,
} from './proactiveAnalysisGrounding';

const validAnalysis = {
  headline: 'A useful signal',
  shortInsight: 'Recovery held steady.',
  narrative: 'Available data suggests a steady day.',
  observations: ['Sleep duration was recorded.'],
  nextSteps: ['Keep today comfortable.'],
};

function evidenceTokens(encoded: ReturnType<typeof encodeProactiveAnalysisRequest>): string[] {
  return JSON.stringify(modelPayload(encoded)).match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
}

function tokenResponse(encoded: ReturnType<typeof encodeProactiveAnalysisRequest>): string {
  const tokens = evidenceTokens(encoded);
  return JSON.stringify({
    ...validAnalysis,
    narrative: tokens[0] ? `Available data included ${tokens[0]}.` : validAnalysis.narrative,
  });
}

function assertCategory(category: AnalysisContentError['category'], run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof AnalysisContentError && error.category === category);
}

const source = {
  kind: 'workout' as const,
  date: '2026-07-13',
  input: {
    nested: [{ metric: 'hrv_sdnn', value: 45 }, { distance_m: 5 }],
    summary: 'Duration: 2 hours; temperature 37.5°C; score 1,000.',
    duplicate: 45,
  },
  availableContext: { enabled: true, timezone: 'UTC-5', profile: {}, baselines: {}, metrics: [] },
};

function captureEvidenceDisplays(run: () => void): string[] {
  const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'set');
  assert.ok(descriptor);
  const original = Map.prototype.set;
  const displays: string[] = [];
  Object.defineProperty(Map.prototype, 'set', {
    ...descriptor,
    value(this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (typeof key === 'string' && /^\{\{EVIDENCE_[A-Z]+\}\}$/.test(key) && typeof value === 'string') displays.push(value);
      return original.call(this, key, value);
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(Map.prototype, 'set', descriptor);
  }
  return displays;
}

test('encodes every number in date input and context deterministically', () => {
  const left = modelPayload(encodeProactiveAnalysisRequest(source));
  const right = modelPayload(encodeProactiveAnalysisRequest(source));
  assert.deepEqual(left, right);
  const serialized = JSON.stringify(left);
  assert.doesNotMatch(serialized, /\p{N}/u);
  const tokens = serialized.match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
  assert.equal(tokens.length, new Set(tokens).size);
  assert.ok(tokens.length >= 10);
});

test('sorts object keys but preserves array order', () => {
  const encoded = modelPayload(encodeProactiveAnalysisRequest({
    kind: 'sleep', date: 'date', input: { z: 1, a: 2 }, availableContext: [{ value: 3 }, { value: 4 }],
  })) as Record<string, unknown>;
  assert.deepEqual(Object.keys(encoded), ['availableContext', 'date', 'input', 'kind']);
  assert.deepEqual(Object.keys(encoded.input as object), ['a', 'z']);
  assert.notEqual(JSON.stringify(encoded.availableContext).indexOf('EVIDENCE_C'), -1);
});

test('encodes numeric object keys and preserves __proto__ as null-prototype data', () => {
  const input = JSON.parse('{"__proto__":{"zone2":45},"vo2_max":7,"zone٤":8}') as Record<string, unknown>;
  const payload = modelPayload(encodeProactiveAnalysisRequest({
    kind: 'workout', date: 'date', input, availableContext: {},
  })) as { input: Record<string, unknown> };
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /\p{N}/u);
  assert.equal(Object.getPrototypeOf(payload.input), null);
  assert.equal(Object.hasOwn(payload.input, '__proto__'), true);
  assert.equal(Object.keys(payload.input).length, 3);
  const protoValue = payload.input.__proto__ as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(protoValue), null);
  assert.equal(Object.keys(protoValue).length, 1);
  assert.doesNotMatch(Object.keys(protoValue)[0], /\p{N}/u);
});

test('rejects non-JSON and non-finite input before transport', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const bigint = Function('return 1n')() as bigint;
  const sparse = Array(1);
  for (const input of [cycle, sparse, { value: Number.NaN }, { value: Infinity }, { value: bigint }, { value: undefined }, { value: () => 1 }]) {
    assert.throws(() => encodeProactiveAnalysisRequest({ kind: 'workout', date: 'date', input, availableContext: {} }));
  }
});

test('the outbound guard rejects every Unicode numeric code point', () => {
  for (const content of ['raw 45', 'raw ٤٥', 'raw Ⅻ', 'raw ²']) {
    assert.throws(
      () => assertNoRawNumbers(content),
      (error) => error instanceof AnalysisContentError && error.category === 'grounding_failure',
    );
  }
  assert.doesNotThrow(() => assertNoRawNumbers('Use {{EVIDENCE_ALPHA}} only.'));
});

test('allocates unique uppercase ASCII tokens for identical displays at different paths', () => {
  const payload = modelPayload(encodeProactiveAnalysisRequest({
    kind: 'workout', date: 'date', input: { a: 45, b: 45 }, availableContext: {},
  }));
  const tokens = JSON.stringify(payload).match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
  assert.equal(tokens.length, 2);
  assert.equal(new Set(tokens).size, 2);
  assert.ok(tokens.every((token) => /^\{\{EVIDENCE_[A-Z]+\}\}$/.test(token)));
});

test('does not mutate source objects', () => {
  const original = structuredClone(source);
  encodeProactiveAnalysisRequest(source);
  assert.deepEqual(source, original);
});

test('rejects reserved evidence-token namespace collisions in source strings', () => {
  for (const input of ['{{EVIDENCE_A}}', 'prefix {{EVIDENCE_', 'prefix EVIDENCE_A suffix']) {
    assert.throws(() => encodeProactiveAnalysisRequest({ kind: 'sleep', date: 'date', input, availableContext: {} }), /reserved/i);
  }
});

test('serializing the opaque handle exposes only payload and never private displays', () => {
  const encoded = encodeProactiveAnalysisRequest({
    kind: 'sleep', date: 'date', input: { metric: 'hrv_sdnn', value: 45 }, availableContext: {},
  });
  const serialized = JSON.stringify(encoded);
  assert.equal(serialized, JSON.stringify(modelPayload(encoded)));
  assert.doesNotMatch(serialized, /45 ms|"45"/);
  assert.doesNotMatch(serialized, /display|tokenMap|source/i);
});

test('captures complete numeric lexemes, adjacent units, and typed numeric field units', () => {
  const payload = modelPayload(encodeProactiveAnalysisRequest({
    kind: 'workout',
    date: 'date',
    input: {
      summary: 'Values: -2, +.5, 1.2e+3, 1,000, 45%, ٤٥٫٦٪, Ⅻ, and 37.5°C.',
      hrv_sdnn: 45,
      heart_rate: 60,
      score: 9,
      exact: { value: 7, unit: 'custom-unit' },
      described: { metric: 'distance_m', value: 5 },
    },
    availableContext: {},
  }));
  const serialized = JSON.stringify(payload);
  const tokens = serialized.match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
  assert.equal(tokens.length, 13);
  assert.doesNotMatch(serialized, /\p{N}/u);
  assert.doesNotMatch(serialized, /-2|\+\.5|1\.2e\+3|1,000|45%|37\.5°C/);
});

test('uses only the closed known-key allowlist for typed numeric displays', () => {
  const displays = captureEvidenceDisplays(() => {
    encodeProactiveAnalysisRequest({
      kind: 'workout',
      date: 'date',
      input: { activeEnergyKcal: 8, activity_energy_level: 6, distanceM: 5, energyLevel: 3, heart_rate: 60, items: 2, paceMinPerMi: 7, steps: 4 },
      availableContext: {},
    });
  });
  assert.deepEqual(displays, ['8 kcal', '6', '5 m', '3', '60 bpm', '2', '7 min/mi', '4 steps']);
});

test('captures unsigned leading decimal separators as complete exact displays', () => {
  const displays = captureEvidenceDisplays(() => {
    const payload = modelPayload(encodeProactiveAnalysisRequest({
      kind: 'sleep', date: 'date', input: { arabic: '٫٥', ascii: '.5' }, availableContext: {},
    })) as { input: Record<string, string> };
    assert.deepEqual({ ...payload.input }, { arabic: '{{EVIDENCE_A}}', ascii: '{{EVIDENCE_B}}' });
  });
  assert.deepEqual(displays, ['٫٥', '.5']);
});

test('preserves date and range separators while storing only lexically unary signs', () => {
  const displays = captureEvidenceDisplays(() => {
    const payload = modelPayload(encodeProactiveAnalysisRequest({
      kind: 'sleep', date: '2026-07-13', input: { range: '5-10', signed: 'change -2; then +3', spacedRange: '20 - 30', tightRange: '40 -50' }, availableContext: {},
    })) as { date: string; input: Record<string, string> };
    assert.match(payload.date, /^\{\{EVIDENCE_[A-Z]+\}\}-\{\{EVIDENCE_[A-Z]+\}\}-\{\{EVIDENCE_[A-Z]+\}\}$/);
    assert.match(payload.input.range, /^\{\{EVIDENCE_[A-Z]+\}\}-\{\{EVIDENCE_[A-Z]+\}\}$/);
    assert.match(payload.input.spacedRange, /^\{\{EVIDENCE_[A-Z]+\}\} - \{\{EVIDENCE_[A-Z]+\}\}$/);
    assert.match(payload.input.tightRange, /^\{\{EVIDENCE_[A-Z]+\}\} -\{\{EVIDENCE_[A-Z]+\}\}$/);
  });
  assert.deepEqual(displays, ['2026', '07', '13', '5', '10', '-2', '+3', '20', '30', '40', '50']);
});

test('preserves every supported Unicode sign exactly through encoding and resolution', () => {
  const signedDisplays = ['−45', '＋45', '﹢45', '﹣45', '－45'];
  const request: ProactiveAnalysisSource = { kind: 'workout', date: 'date', input: signedDisplays, availableContext: {} };
  const encoded = encodeProactiveAnalysisRequest(request);
  const payload = modelPayload(encoded) as { input: string[] };
  const tokens = evidenceTokens(encoded);
  assert.deepEqual(payload.input, tokens);
  assert.deepEqual(captureEvidenceDisplays(() => encodeProactiveAnalysisRequest(request)), signedDisplays);

  const proof = groundAnalysisText(JSON.stringify({
    headline: tokens[0],
    shortInsight: tokens[1],
    narrative: tokens[2],
    observations: [tokens[3]],
    nextSteps: [tokens[4]],
  }), encoded);
  assert.deepEqual(consumeGroundedAnalysisProof(proof, request), {
    headline: '−45',
    shortInsight: '＋45',
    narrative: '﹢45',
    observations: ['﹣45'],
    nextSteps: ['－45'],
  });
});

test('resolves exact private displays and consumes proof once', () => {
  const request: ProactiveAnalysisSource = {
    kind: 'workout', date: 'date',
    input: { metrics: [{ metric: 'hrv_sdnn', value: 45 }], summary: 'Duration was 2 hours.' },
    availableContext: {},
  };
  const encoded = encodeProactiveAnalysisRequest(request);
  const tokens = evidenceTokens(encoded);
  const proof = groundAnalysisText(JSON.stringify({
    headline: 'A useful signal',
    shortInsight: 'Recovery held steady.',
    narrative: `HRV was ${tokens[0]}.`,
    observations: [`Duration was ${tokens[1]}.`],
    nextSteps: ['Keep today comfortable.'],
  }), encoded);
  const resolved = consumeGroundedAnalysisProof(proof, request);
  assert.match(resolved.narrative, /45 ms/);
  assert.match(resolved.observations[0], /2 hours/);
  assert.doesNotMatch(JSON.stringify(resolved), /EVIDENCE/);
  assert.throws(() => consumeGroundedAnalysisProof(proof, request));
});

test('accepts one optional complete JSON code fence', () => {
  const request: ProactiveAnalysisSource = { kind: 'sleep', date: 'date', input: {}, availableContext: {} };
  const encoded = encodeProactiveAnalysisRequest(request);
  const proof = groundAnalysisText(`\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``, encoded);
  assert.deepEqual(consumeGroundedAnalysisProof(proof, request), validAnalysis);
});

test('classifies malformed and fenced-invalid JSON as parse failures', () => {
  const encoded = encodeProactiveAnalysisRequest({ kind: 'sleep', date: 'date', input: {}, availableContext: {} });
  for (const text of [
    '{',
    'not JSON',
    '```json\n{"headline":\n```',
    `\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\` trailing`,
    `\`\`\`typescript\n${JSON.stringify(validAnalysis)}\n\`\`\``,
    `\`\`\`json\n\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\`\n\`\`\``,
  ]) assertCategory('parse_failure', () => groundAnalysisText(text, encoded));
});

test('rejects raw numeric forms and invalid evidence-token forms as grounding failures', () => {
  const encoded = encodeProactiveAnalysisRequest({
    kind: 'workout', date: 'date', input: { first: 45, second: 46 }, availableContext: {},
  });
  const [first, second] = evidenceTokens(encoded);
  const authored = [
    '45', '٤٥', '-45', '+45', '1.5', '.5', '1e2', '1,000', '45%', '37°C', '1. Rest',
    '{{EVIDENCE_UNKNOWN}}', '{{EVIDENCE_AA', 'EVIDENCE_AA}}', '{{EVIDENCE_ AA}}',
    '{{EVIDENCE_a}}', '{{EVIDENCE_A1}}', '{{EVIDENCE_{{EVIDENCE_A}}}}',
    `${first}${second}`, `${first}EVIDENCE_A`, `{${first}}`,
  ];
  for (const narrative of authored) {
    assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({ ...validAnalysis, narrative }), encoded));
  }
  assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({ ...validAnalysis, narrative: `${first} then ${first}` }), encoded));
  assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({
    ...validAnalysis, narrative: '{{EVID', observations: ['ENCE_A}}'],
  }), encoded));
});

test('rejects composable token syntax and accepts clause-terminal token prose', () => {
  const request: ProactiveAnalysisSource = {
    kind: 'workout', date: 'date', input: { first: 45, second: 46 }, availableContext: {},
  };
  const encoded = encodeProactiveAnalysisRequest(request);
  const [first, second] = evidenceTokens(encoded);
  for (const narrative of [
    `-${first}`, `- ${first}`, `+${first}`, `+ ${first}`, `−${first}`, `− ${first}`, `＋${first}`,
    `~${first}`, `~ ${first}`, `≈${first}`, `≈ ${first}`, `<${first}`, `< ${first}`,
    `≤${first}`, `≤ ${first}`, `>${first}`, `> ${first}`, `≥${first}`, `≥ ${first}`,
    `=${first}`, `= ${first}`, `±${first}`, `± ${first}`,
    `%${first}`, `% ${first}`, `°${first}`, `° ${first}`,
    `${first}%`, `${first} %`, `${first}°`, `${first} °C`, `${first} kg`, `${first},`,
    `${first}.${second}`, `${first}. ${second}`, `${first} . ${second}`,
    `${first}/${second}`, `${first} / ${second}`, `${first}:${second}`, `${first} : ${second}`,
    `${first}${second}`, `${first} ${second}`, `${first}\u200b${second}`, `${first}\u2060 kg`,
  ]) {
    assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({ ...validAnalysis, narrative }), encoded));
  }

  for (const narrative of [
    `HRV was ${first}.`,
    `Recovery remained qualitatively near ${first}.`,
    `Recorded value: ${first}! More qualitative context followed.`,
    `First value was ${first}. Second value was ${second}?`,
  ]) {
    const fresh = encodeProactiveAnalysisRequest(request);
    const [freshFirst, freshSecond] = evidenceTokens(fresh);
    const freshNarrative = narrative.replaceAll(first, freshFirst).replaceAll(second, freshSecond);
    const proof = groundAnalysisText(JSON.stringify({ ...validAnalysis, narrative: freshNarrative }), fresh);
    assert.doesNotMatch(JSON.stringify(consumeGroundedAnalysisProof(proof, request)), /EVIDENCE/);
  }
});

test('rejects a valid token copied from another encoded request', () => {
  const encoded = encodeProactiveAnalysisRequest({ kind: 'sleep', date: 'date', input: {}, availableContext: {} });
  const other = encodeProactiveAnalysisRequest({ kind: 'sleep', date: 'date', input: { first: 45, second: 46 }, availableContext: {} });
  const [, copied] = evidenceTokens(other);
  assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({ ...validAnalysis, narrative: copied }), encoded));
});

test('revalidates schema limits after token expansion', () => {
  const encoded = encodeProactiveAnalysisRequest({ kind: 'sleep', date: 'date', input: { summary: '9'.repeat(241) }, availableContext: {} });
  const [token] = evidenceTokens(encoded);
  assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({ ...validAnalysis, shortInsight: token }), encoded));
});

test('proofs cannot be forged or copied', () => {
  const request: ProactiveAnalysisSource = { kind: 'sleep', date: 'date', input: {}, availableContext: {} };
  const encoded = encodeProactiveAnalysisRequest(request);
  const proof = groundAnalysisText(tokenResponse(encoded), encoded);
  for (const forged of [validAnalysis, { value: validAnalysis }, { ...proof }, JSON.parse(JSON.stringify(proof))]) {
    assert.throws(() => consumeGroundedAnalysisProof(forged as GroundedAnalysisProof, request), /invalid grounded analysis proof/i);
  }
  assert.deepEqual(consumeGroundedAnalysisProof(proof, request), validAnalysis);
});

test('proof consumption requires the exact canonical source binding without burning on mismatch', () => {
  const requestA: ProactiveAnalysisSource = { kind: 'workout', date: 'date', input: { value: 45 }, availableContext: {} };
  const requestB: ProactiveAnalysisSource = { kind: 'workout', date: 'date', input: { value: 46 }, availableContext: {} };
  const encoded = encodeProactiveAnalysisRequest(requestA);
  const proof = groundAnalysisText(tokenResponse(encoded), encoded);
  assert.throws(() => consumeGroundedAnalysisProof(proof, requestB), /invalid grounded analysis proof/i);
  assert.match(consumeGroundedAnalysisProof(proof, requestA).narrative, /45/);
});

test('identical source displays receive distinct one-use capabilities', () => {
  const request: ProactiveAnalysisSource = {
    kind: 'workout', date: 'date', input: { a: 45, b: 45 }, availableContext: {},
  };
  const encoded = encodeProactiveAnalysisRequest(request);
  const [first, second] = evidenceTokens(encoded);
  assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({
    ...validAnalysis, narrative: `${first} and ${first}`,
  }), encoded));
  const proof = groundAnalysisText(JSON.stringify({
    ...validAnalysis, narrative: `First ${first}.`, observations: [`Second ${second}.`],
  }), encoded);
  const resolved = consumeGroundedAnalysisProof(proof, request);
  assert.match(resolved.narrative, /First 45\./);
  assert.match(resolved.observations[0], /Second 45\./);
});
