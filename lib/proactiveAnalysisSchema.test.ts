import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisContentError, parseAnalysisText } from './proactiveAnalysisGrounding';
import { parseCoachAnalysis } from './proactiveAnalysisSchema';

const valid = {
  headline: 'A useful signal',
  shortInsight: 'Recovery held steady.',
  narrative: 'Available data suggests a steady day.',
  observations: ['Sleep duration was recorded.'],
  nextSteps: ['Keep today comfortable.'],
};

test('accepts only the unchanged CoachAnalysis shape and limits', () => {
  assert.deepEqual(parseCoachAnalysis(valid), valid);
  assert.throws(() => parseCoachAnalysis({ ...valid, observations: [''] }), /observations/);
  assert.throws(() => parseCoachAnalysis({ ...valid, headline: 'x'.repeat(81) }), /headline/);
  assert.throws(() => parseCoachAnalysis({ ...valid, nextSteps: Array(3).fill('Rest') }), /nextSteps/);
});

test('routine sessions may return empty observations and nextSteps', () => {
  assert.deepEqual(parseCoachAnalysis({ ...valid, observations: [], nextSteps: [] }), { ...valid, observations: [], nextSteps: [] });
});

test('a missing observations key coerces to an empty array', () => {
  const { observations: _omit, ...withoutObservations } = valid;
  assert.deepEqual(parseCoachAnalysis(withoutObservations), { ...valid, observations: [] });
});

test('a null nextSteps value coerces to an empty array', () => {
  assert.deepEqual(parseCoachAnalysis({ ...valid, nextSteps: null }), { ...valid, nextSteps: [] });
});

test('a non-array observations value still throws, even when nullish coercion is allowed', () => {
  assert.throws(() => parseCoachAnalysis({ ...valid, observations: 'not an array' }), /observations/);
});

test('an unknown extra key is ignored and dropped from the returned object', () => {
  const result = parseCoachAnalysis({ ...valid, confidence: 0.9 });
  assert.deepEqual(result, valid);
  assert.ok(!('confidence' in result));
});

test('a schema failure surfaces a short detail string naming the offending field', () => {
  assert.throws(
    () => parseAnalysisText(JSON.stringify({ ...valid, headline: 'x'.repeat(81) })),
    (error: unknown) => error instanceof AnalysisContentError && error.category === 'schema_failure' && error.detail === 'invalid headline',
  );
});

test('classifies every invalid output shape as a schema failure before the digit check', () => {
  const invalidShapes: unknown[] = [
    { shortInsight: valid.shortInsight, narrative: valid.narrative, observations: valid.observations, nextSteps: valid.nextSteps },
    { ...valid, headline: 45 },
    { ...valid, shortInsight: { text: 'nested' } },
    { ...valid, observations: 'not an array' },
    { ...valid, observations: [['nested array']] },
    { ...valid, nextSteps: [{ value: 'nested object' }] },
  ];
  for (const value of invalidShapes) {
    assert.throws(
      () => parseAnalysisText(JSON.stringify(value)),
      (error: unknown) => error instanceof AnalysisContentError && error.category === 'schema_failure',
    );
  }
});
