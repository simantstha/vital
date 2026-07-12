import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./proactiveHealthWorkerRepository.ts', import.meta.url), 'utf8');
const fly = readFileSync(new URL('../fly.toml', import.meta.url), 'utf8');

test('claims eligible and expired leases atomically while respecting sleep analyze_after', () => {
  assert.match(source, /for update skip locked/g);
  assert.match(source, /status = 'processing' and lease_expires_at <=/);
  assert.match(source, /analyze_after <=/);
  assert.match(source, /set status='processing', lease_token=.*lease_expires_at=/);
  assert.match(source, /eq\(t\.lease_token, job\.leaseToken\)/);
});

test('Fly supervises the worker independently from HTTP auto-stop and app volume', () => {
  assert.match(fly, /worker = "node dist\/proactive-health-worker\.cjs"/);
  assert.match(fly, /processes = \["app"\]/);
  assert.doesNotMatch(fly, /VITAL_PROACTIVE_WORKER/);
});

test('sleep and brief race through the unique morning slot and late sleep is suppressed', () => {
  assert.match(source, /claimed_by: 'sleep'/);
  assert.match(source, /claimed_by: 'brief'/);
  assert.match(source, /onConflictDoNothing\(\)/g);
  assert.match(source, /minutes >= .*morning_brief_time_minutes/);
  assert.match(source, /this\.suppressNotification\(job, now\)/);
});

test('ready and sending notifications are independently recoverable with owner CAS', () => {
  assert.match(source, /status='ready'[\s\S]*notification_next_attempt_at/);
  assert.match(source, /notification_state='sending'[\s\S]*notification_lease_expires_at <=/);
  assert.match(source, /eq\(t\.notification_lease_token, token\)/);
});

test('due briefs are ordered by local overdue duration rather than user id', () => {
  assert.match(source, /at time zone p\.timezone/);
  assert.match(source, /morning_brief_time_minutes\) desc, p\.updated_at/);
  assert.doesNotMatch(source, /order by p\.user_id limit/);
});
