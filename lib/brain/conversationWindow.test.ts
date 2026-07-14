import assert from 'node:assert/strict';
import test from 'node:test';
import { CONVERSATION_GAP_MS, computeConversationStart } from './conversationWindow';

const NOW = new Date('2026-07-13T18:00:00.000Z');

function hoursBefore(reference: Date, hours: number): Date {
  return new Date(reference.getTime() - hours * 60 * 60 * 1000);
}

test('no messages and no reset yields no boundary', () => {
  assert.equal(computeConversationStart([], null, NOW), null);
});

test('recent active conversation (all gaps under 4h) yields no boundary', () => {
  const t0 = hoursBefore(NOW, 1);
  const t1 = hoursBefore(NOW, 2);
  const t2 = hoursBefore(NOW, 3);
  assert.equal(computeConversationStart([t0, t1, t2], null, NOW), null);
});

test('latest message more than 4h old starts the conversation at now (all history excluded)', () => {
  const t0 = hoursBefore(NOW, 5);
  const t1 = hoursBefore(NOW, 6);
  const start = computeConversationStart([t0, t1], null, NOW);
  assert.equal(start?.getTime(), NOW.getTime());
  assert.ok(t0.getTime() < start!.getTime(), 'previous messages must be strictly before the boundary');
});

test('a message sent after a 5h gap becomes the boundary (included; older messages excluded)', () => {
  const recent = hoursBefore(NOW, 0.1); // sent just now
  const old = hoursBefore(NOW, 5.1); // 5h before "recent" -> gap exceeds CONVERSATION_GAP_MS
  const start = computeConversationStart([recent, old], null, NOW);
  assert.equal(start?.getTime(), recent.getTime());
  // Inclusive filtering (timestamp >= start) keeps `recent`, drops `old`.
  assert.ok(recent.getTime() >= start!.getTime());
  assert.ok(old.getTime() < start!.getTime());
});

test('a manual reset newer than the gap boundary wins', () => {
  const recent = hoursBefore(NOW, 0.1); // gap boundary would be `recent`
  const old = hoursBefore(NOW, 5.1);
  const resetAt = hoursBefore(NOW, 0.05); // newer than `recent`, still before NOW
  const start = computeConversationStart([recent, old], resetAt, NOW);
  assert.equal(start?.getTime(), resetAt.getTime());
});

test('a manual reset older than the gap boundary loses', () => {
  const recent = hoursBefore(NOW, 0.1);
  const old = hoursBefore(NOW, 5.1);
  const resetAt = hoursBefore(NOW, 10); // older than the gap boundary (`recent`)
  const start = computeConversationStart([recent, old], resetAt, NOW);
  assert.equal(start?.getTime(), recent.getTime());
});

test('a manual reset applies even with no gap boundary present', () => {
  const t0 = hoursBefore(NOW, 1);
  const resetAt = hoursBefore(NOW, 0.5);
  const start = computeConversationStart([t0], resetAt, NOW);
  assert.equal(start?.getTime(), resetAt.getTime());
});

test('gap exactly at the threshold does not trigger a boundary (only strictly greater than)', () => {
  const t0 = hoursBefore(NOW, 1);
  const t1 = new Date(t0.getTime() - CONVERSATION_GAP_MS);
  assert.equal(computeConversationStart([t0, t1], null, NOW), null);
});
