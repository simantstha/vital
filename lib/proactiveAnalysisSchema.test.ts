import assert from 'node:assert/strict';
import test from 'node:test';
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
