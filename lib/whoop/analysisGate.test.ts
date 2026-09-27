import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldCreateWhoopAnalysis, WHOOP_ANALYSIS_MAX_AGE_MS } from './analysisGate';

const now = new Date('2026-08-02T12:00:00.000Z');

test('allows a session that ended just now, not the first sync', () => {
  assert.ok(shouldCreateWhoopAnalysis({ endedAt: now, now, isFirstSync: false }));
});

test('allows a session right at the 24h boundary', () => {
  const endedAt = new Date(now.getTime() - WHOOP_ANALYSIS_MAX_AGE_MS);
  assert.ok(shouldCreateWhoopAnalysis({ endedAt, now, isFirstSync: false }));
});

test('rejects a session that ended just over 24h ago', () => {
  const endedAt = new Date(now.getTime() - WHOOP_ANALYSIS_MAX_AGE_MS - 1);
  assert.ok(!shouldCreateWhoopAnalysis({ endedAt, now, isFirstSync: false }));
});

test('rejects a session ending in the future (clock skew) rather than treating it as fresh', () => {
  const endedAt = new Date(now.getTime() + 60_000);
  assert.ok(!shouldCreateWhoopAnalysis({ endedAt, now, isFirstSync: false }));
});

test('rejects on the connection\'s first sync, no matter how recent', () => {
  assert.ok(!shouldCreateWhoopAnalysis({ endedAt: now, now, isFirstSync: true }));
});
