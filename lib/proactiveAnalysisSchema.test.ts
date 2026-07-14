import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalysisContentError,
  encodeProactiveAnalysisRequest,
  groundAnalysisText,
} from './proactiveAnalysisGrounding';
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

test('classifies every invalid output shape as a schema failure before grounding', () => {
  const encoded = encodeProactiveAnalysisRequest({ kind: 'sleep', date: 'date', input: { value: 45 }, availableContext: {} });
  const invalidShapes: unknown[] = [
    { shortInsight: valid.shortInsight, narrative: valid.narrative, observations: valid.observations, nextSteps: valid.nextSteps },
    { ...valid, extra: 'field' },
    { ...valid, headline: 45 },
    { ...valid, shortInsight: { text: '{{EVIDENCE_A}}' } },
    { ...valid, observations: '{{EVIDENCE_A}}' },
    { ...valid, observations: [['{{EVIDENCE_A}}']] },
    { ...valid, nextSteps: [{ value: '{{EVIDENCE_A}}' }] },
    { ...valid, '{{EVIDENCE_A}}': 'token in key' },
    { ...valid, extra: '{{EVIDENCE_A}}' },
  ];
  for (const value of invalidShapes) {
    assert.throws(
      () => groundAnalysisText(JSON.stringify(value), encoded),
      (error: unknown) => error instanceof AnalysisContentError && error.category === 'schema_failure',
    );
  }
});
