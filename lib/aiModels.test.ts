import assert from 'node:assert/strict';
import test from 'node:test';
import { thinkingOffFor } from './aiModels';

test('thinkingOffFor uses between_tools on Sonnet 5.5, which rejects disabled', () => {
  assert.deepEqual(thinkingOffFor('claude-sonnet-5-5'), { type: 'between_tools' });
});

test('thinkingOffFor uses disabled on Sonnet 5', () => {
  assert.deepEqual(thinkingOffFor('claude-sonnet-5'), { type: 'disabled' });
});

test('thinkingOffFor uses disabled on Sonnet 4.6', () => {
  assert.deepEqual(thinkingOffFor('claude-sonnet-4-6'), { type: 'disabled' });
});
