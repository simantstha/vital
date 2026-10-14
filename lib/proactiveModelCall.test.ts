import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { AnalysisContentError } from './proactiveAnalysisGrounding';
import {
  ANALYSIS_MAX_TOKENS,
  NUDGE_MAX_TOKENS,
  buildAnalysisRequest,
  buildNudgeRequest,
  textFromResponse,
} from './proactiveModelCall';

const request = { system: 'system prompt', content: '{"kind":"workout"}' };

function response(stopReason: Anthropic.StopReason | null, content: Array<Record<string, unknown>>): Anthropic.Message {
  return { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: stopReason, stop_sequence: null, content } as unknown as Anthropic.Message;
}
const text = (value: string) => ({ type: 'text', text: value, citations: null });
const thinking = { type: 'thinking', thinking: 'hmm', signature: 'sig' };

function assertAnalysisError(fn: () => unknown, detail: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AnalysisContentError, 'expected an AnalysisContentError');
    assert.equal(error.category, 'parse_failure');
    assert.equal(error.detail, detail);
    return true;
  });
}

test('analysis request disables adaptive thinking and carries the prompt through', () => {
  const params = buildAnalysisRequest('claude-sonnet-5', request);
  assert.deepEqual(params.thinking, { type: 'disabled' });
  assert.equal(params.model, 'claude-sonnet-5');
  assert.equal(params.max_tokens, ANALYSIS_MAX_TOKENS);
  assert.equal(params.system, request.system);
  assert.deepEqual(params.messages, [{ role: 'user', content: request.content }]);
});

test('nudge request disables adaptive thinking and carries the prompt through', () => {
  const params = buildNudgeRequest('custom-model', request);
  assert.deepEqual(params.thinking, { type: 'disabled' });
  assert.equal(params.model, 'custom-model');
  assert.equal(params.max_tokens, NUDGE_MAX_TOKENS);
  assert.equal(params.system, request.system);
  assert.deepEqual(params.messages, [{ role: 'user', content: request.content }]);
});

test('a normal text response returns its text', () => {
  assert.equal(textFromResponse(response('end_turn', [text('{"ok":true}')]), 'analysis'), '{"ok":true}');
  assert.equal(textFromResponse(response('end_turn', [text('keep going')]), 'insight nudge'), 'keep going');
});

test('stop_reason max_tokens on an analysis is a repairable parse_failure that names the cause', () => {
  // The production failure: the JSON was cut off at max_tokens, so the text
  // block is present but unparseable. The reason must surface before parsing.
  assertAnalysisError(() => textFromResponse(response('max_tokens', [text('{"headline":"Run lo')]), 'analysis'), 'truncated at max_tokens');
  assertAnalysisError(() => textFromResponse(response('max_tokens', [thinking]), 'analysis'), 'truncated at max_tokens');
});

test('stop_reason max_tokens on a nudge is a plain Error that says truncated', () => {
  assert.throws(
    () => textFromResponse(response('max_tokens', [thinking]), 'insight nudge'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof AnalysisContentError));
      assert.match(error.message, /truncated/);
      assert.match(error.message, /insight nudge/);
      return true;
    },
  );
});

test('stop_reason refusal on an analysis is an AnalysisContentError with detail refusal', () => {
  assertAnalysisError(() => textFromResponse(response('refusal', [text("I can't help with that.")]), 'analysis'), 'refusal');
  assertAnalysisError(() => textFromResponse(response('refusal', []), 'analysis'), 'refusal');
});

test('stop_reason refusal on a nudge is a plain Error', () => {
  assert.throws(
    () => textFromResponse(response('refusal', []), 'insight nudge'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof AnalysisContentError));
      assert.match(error.message, /refused/);
      return true;
    },
  );
});

test('a response with no text block is an error for both call types', () => {
  assert.throws(() => textFromResponse(response('end_turn', []), 'analysis'), /analysis model returned no text/);
  assert.throws(() => textFromResponse(response('end_turn', [thinking]), 'analysis'), /analysis model returned no text/);
  assert.throws(() => textFromResponse(response('end_turn', []), 'insight nudge'), /insight nudge model returned no text/);
});

test('more than one text block is still an error', () => {
  assert.throws(() => textFromResponse(response('end_turn', [text('a'), text('b')]), 'analysis'), /returned no text/);
});

test('a non-text block next to a single text block is ignored', () => {
  assert.equal(textFromResponse(response('end_turn', [thinking, text('{"ok":true}')]), 'analysis'), '{"ok":true}');
});
