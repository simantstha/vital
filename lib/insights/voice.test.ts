import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVoiceRequest, parseNudge } from './voice';
import type { CertifiedFinding } from './types';

const finding: CertifiedFinding = {
  kind: 'cadence_break', signature: 'cadence_break:exercise_min', metrics: ['exercise_min'],
  effect: 4, effectLabel: '4 days since the last session', n: 28, pValue: null,
  detail: { daysSinceLast: 4, sessionsPerWeek: 5.5 }, confirmedOnRuns: 2,
};

const context = { goal: 'endurance', facts: ['Prefers Nepali food'], recentlySaid: [] };

test('the request carries the finding but never a raw series', () => {
  const request = buildVoiceRequest([finding], context);
  assert.ok(request.content.includes('cadence_break:exercise_min'));
  assert.ok(request.content.includes('4 days since the last session'));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(request.content), 'daily datapoints must not reach the model');
});

test('the system prompt tells the model to select, not to discover', () => {
  const request = buildVoiceRequest([finding], context);
  assert.match(request.system, /select/i);
  assert.match(request.system, /do not|never/i);
});

test('parses a well-formed response', () => {
  const nudge = parseNudge(JSON.stringify({
    signature: 'cadence_break:exercise_min',
    title: 'Four days off',
    body: "You've been steady at five a week. What happened?",
    openingMessage: "You've been training about five times a week, and it's been four days. What's going on?",
  }), ['cadence_break:exercise_min']);
  assert.ok(nudge);
  assert.equal(nudge.signature, 'cadence_break:exercise_min');
});

test('rejects a signature we never offered', () => {
  // The model inventing its own finding is the failure this guards.
  const nudge = parseNudge(JSON.stringify({
    signature: 'cross_lag:invented:whoop_recovery:1:down',
    title: 'x', body: 'y', openingMessage: 'z',
  }), ['cadence_break:exercise_min']);
  assert.equal(nudge, null);
});

test('rejects malformed JSON rather than throwing', () => {
  assert.equal(parseNudge('not json at all', ['cadence_break:exercise_min']), null);
});

test('rejects a response missing required fields', () => {
  assert.equal(
    parseNudge(JSON.stringify({ signature: 'cadence_break:exercise_min', title: 'x' }), ['cadence_break:exercise_min']),
    null,
  );
});

test('rejects empty or whitespace-only copy', () => {
  assert.equal(
    parseNudge(JSON.stringify({
      signature: 'cadence_break:exercise_min', title: '  ', body: 'y', openingMessage: 'z',
    }), ['cadence_break:exercise_min']),
    null,
  );
});

test('parses a response the model wrapped in a markdown fence', () => {
  // Models fence their output even when told not to. Without fence-stripping
  // this is indistinguishable from malformed JSON and the feature silently
  // delivers nothing — see stripCompleteJsonFence in proactiveAnalysisGrounding.
  const body = JSON.stringify({
    signature: 'cadence_break:exercise_min',
    title: 'Four days off',
    body: "You've been steady at five a week. What happened?",
    openingMessage: "You've been training about five times a week, and it's been four days. What's going on?",
  });
  const nudge = parseNudge('```json\n' + body + '\n```', ['cadence_break:exercise_min']);
  assert.ok(nudge);
  assert.equal(nudge.signature, 'cadence_break:exercise_min');
  assert.equal(nudge.title, 'Four days off');
});
