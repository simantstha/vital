import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./proactiveHealthWorkerRepository.ts', import.meta.url), 'utf8');

test('claims eligible and expired leases atomically while respecting sleep analyze_after', () => {
  assert.match(source, /for update skip locked/g);
  assert.match(source, /status = 'processing' and lease_expires_at <=/);
  assert.match(source, /analyze_after <=/);
  assert.match(source, /set status='processing', lease_expires_at=/);
});

test('sleep and brief race through the unique morning slot and late sleep is suppressed', () => {
  assert.match(source, /claimed_by: 'sleep'/);
  assert.match(source, /claimed_by: 'brief'/);
  assert.match(source, /onConflictDoNothing\(\)/g);
  assert.match(source, /minutes >= .*morning_brief_time_minutes/);
  assert.match(source, /this\.suppress\(job\)/);
});
