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
  assert.throws(() => parseCoachAnalysis({ ...valid, invented: true }), /unexpected field/);
  assert.throws(() => parseCoachAnalysis({ ...valid, observations: [''] }), /observations/);
  assert.throws(() => parseCoachAnalysis({ ...valid, headline: 'x'.repeat(121) }), /headline/);
  assert.throws(() => parseCoachAnalysis({ ...valid, nextSteps: Array(6).fill('Rest') }), /nextSteps/);
});

test('classifies every invalid output shape as a schema failure before the digit check', () => {
  const invalidShapes: unknown[] = [
    { shortInsight: valid.shortInsight, narrative: valid.narrative, observations: valid.observations, nextSteps: valid.nextSteps },
    { ...valid, extra: 'field' },
    { ...valid, headline: 45 },
    { ...valid, shortInsight: { text: 'nested' } },
    { ...valid, observations: 'not an array' },
    { ...valid, observations: [['nested array']] },
    { ...valid, nextSteps: [{ value: 'nested object' }] },
    { ...valid, unexpectedKey: 'extra key' },
  ];
  for (const value of invalidShapes) {
    assert.throws(
      () => parseAnalysisText(JSON.stringify(value)),
      (error: unknown) => error instanceof AnalysisContentError && error.category === 'schema_failure',
    );
  }
});
