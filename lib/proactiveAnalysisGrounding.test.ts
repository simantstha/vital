import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnalysisContentError,
  assertNoRawNumbers,
  parseAnalysisText,
  stripCompleteJsonFence,
} from './proactiveAnalysisGrounding';

const validAnalysis = {
  headline: 'A useful signal',
  shortInsight: 'Recovery held steady.',
  narrative: 'Available data suggests a steady day.',
  observations: ['Sleep duration was recorded.'],
  nextSteps: ['Keep today comfortable.'],
};

function assertCategory(category: AnalysisContentError['category'], run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof AnalysisContentError && error.category === category);
}

test('the digit guard rejects every Unicode numeric code point', () => {
  for (const content of ['raw 45', 'raw ٤٥', 'raw Ⅻ', 'raw ²']) {
    assertCategory('grounding_failure', () => assertNoRawNumbers(content));
  }
  assert.doesNotThrow(() => assertNoRawNumbers('Noticeably faster than your recent sessions.'));
});

test('strips one complete JSON code fence and leaves other text untouched', () => {
  assert.equal(stripCompleteJsonFence('```json\n{"a":true}\n```'), '{"a":true}');
  assert.equal(stripCompleteJsonFence('{"a":true}'), '{"a":true}');
  assert.equal(stripCompleteJsonFence('```json\n{"a":true}\n``` trailing'), '```json\n{"a":true}\n``` trailing');
});

test('accepts digit-free qualitative prose as the analysis', () => {
  assert.deepEqual(parseAnalysisText(JSON.stringify(validAnalysis)), validAnalysis);
});

test('accepts one optional complete JSON code fence', () => {
  assert.deepEqual(parseAnalysisText(`\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\``), validAnalysis);
});

test('accepts qualitative comparison language in every authored field', () => {
  const qualitative = {
    headline: 'Evening run',
    shortInsight: 'You held a noticeably faster pace than usual.',
    narrative: 'This run went longer than your recent sessions and your heart rate stayed well below its usual ceiling.',
    observations: ['Pace was quicker than your recent average.', 'Duration was longer than usual.'],
    nextSteps: ['Keep tomorrow easy.', 'Prioritise sleep tonight.'],
  };
  assert.deepEqual(parseAnalysisText(JSON.stringify(qualitative)), qualitative);
});

test('classifies malformed and fenced-invalid JSON as parse failures', () => {
  for (const text of [
    '{',
    'not JSON',
    '```json\n{"headline":\n```',
    `\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\` trailing`,
    `\`\`\`typescript\n${JSON.stringify(validAnalysis)}\n\`\`\``,
    `\`\`\`json\n\`\`\`json\n${JSON.stringify(validAnalysis)}\n\`\`\`\n\`\`\``,
  ]) assertCategory('parse_failure', () => parseAnalysisText(text));
});

test('rejects any numeral the model writes into its prose as a grounding failure', () => {
  for (const narrative of [
    'You ran 45 minutes.', 'You ran ٤٥ minutes.', 'Pace improved by -45 seconds.',
    'Pace improved by +45 seconds.', 'You averaged 1.5 km.', 'Efficiency was .5 of the target.',
    'Load was 1e2 units.', 'You burned 1,000 calories.', 'Efficiency hit 45%.',
    'It was 37°C outside.', '1. Rest tomorrow.',
  ]) {
    assertCategory('grounding_failure', () => parseAnalysisText(JSON.stringify({ ...validAnalysis, narrative })));
  }
});

test('rejects a numeral in any authored field, not just the narrative', () => {
  for (const override of [
    { headline: 'Run for 45 minutes' },
    { shortInsight: 'You slept 8 hours.' },
    { observations: ['Heart rate averaged 150 bpm.'] },
    { nextSteps: ['Rest for 2 days.'] },
  ]) {
    assertCategory('grounding_failure', () => parseAnalysisText(JSON.stringify({ ...validAnalysis, ...override })));
  }
});

test('rejects placeholder-style meta-responses', () => {
  for (const phrase of [
    'Unable to process workout data',
    'The record contains placeholder tokens',
    'The record contains a template variable',
    'The record contains unresolved tokens',
    'Data integrity must be restored',
  ]) {
    assertCategory('grounding_failure', () => parseAnalysisText(JSON.stringify({
      ...validAnalysis,
      narrative: `${phrase}. Nothing further could be said.`,
    })));
  }
});
