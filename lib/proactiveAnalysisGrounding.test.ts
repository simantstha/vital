import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalysisContentError,
  assertNoRawNumbers,
  encodeProactiveAnalysisRequest,
  modelPayload,
} from './proactiveAnalysisGrounding';

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
    assert.deepEqual(payload.input, { arabic: '{{EVIDENCE_A}}', ascii: '{{EVIDENCE_B}}' });
  });
  assert.deepEqual(displays, ['٫٥', '.5']);
});
