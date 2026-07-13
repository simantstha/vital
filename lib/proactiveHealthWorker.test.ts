import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyApnsResponse,
  nextRetryAt,
  runClaimedAnalysis,
  shouldRunMorningBrief,
  type AnalysisJob,
  type WorkerRepository,
} from './proactiveHealthWorker';

const valid = {
  headline: 'A useful signal', shortInsight: 'Recovery held steady.',
  narrative: 'Your available data suggests a steady day.',
  observations: ['Sleep duration was recorded.'], nextSteps: ['Keep today comfortable.'],
};

test('caps exponential retries', () => {
  const now = new Date('2026-07-12T12:00:00Z');
  assert.equal(nextRetryAt(now, 0).toISOString(), '2026-07-12T12:01:00.000Z');
  assert.equal(nextRetryAt(now, 20).toISOString(), '2026-07-12T18:00:00.000Z');
});

test('classifies APNs responses without retrying permanent errors', () => {
  assert.deepEqual(classifyApnsResponse(200), { outcome: 'sent', retireToken: false });
  assert.deepEqual(classifyApnsResponse(410, 'Unregistered'), { outcome: 'permanent', retireToken: true });
  assert.deepEqual(classifyApnsResponse(400, 'BadDeviceToken'), { outcome: 'permanent', retireToken: true });
  assert.deepEqual(classifyApnsResponse(429, 'TooManyRequests'), { outcome: 'transient', retireToken: false });
  assert.deepEqual(classifyApnsResponse(500), { outcome: 'transient', retireToken: false });
  assert.deepEqual(classifyApnsResponse(400, 'PayloadEmpty'), { outcome: 'permanent', retireToken: false });
});

test('timezone scheduling runs once at or after configured local minute', () => {
  assert.equal(shouldRunMorningBrief(new Date('2026-07-12T12:29:00Z'), 'America/Chicago', 450), false);
  assert.equal(shouldRunMorningBrief(new Date('2026-07-12T12:30:00Z'), 'America/Chicago', 450), true);
  assert.equal(shouldRunMorningBrief(new Date('2026-07-12T07:30:00Z'), 'Invalid/Zone', 450), true);
});

test('disabled notification preference suppresses analysis without model or push', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, false);
  await runClaimedAnalysis(job(), repo, async () => { calls.push('analyze'); return valid; }, async () => {
    calls.push('push'); return { outcome: 'sent', retireToken: false };
  }, new Date());
  assert.deepEqual(calls, ['suppress']);
});

test('one logical notification is sent despite a duplicate worker delivery', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  const analyze = async () => valid;
  const push = async () => { calls.push('push'); return { outcome: 'sent' as const, retireToken: false }; };
  await runClaimedAnalysis(job(), repo, analyze, push, new Date());
  await runClaimedAnalysis(job(), repo, analyze, push, new Date());
  assert.equal(calls.filter((x) => x === 'push').length, 1);
});

test('a repaired result is not stored after lease ownership is lost', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  let renewals = 0;
  repo.renewAnalysisLease = async () => ++renewals === 1;
  repo.storeReady = async () => { calls.push('store'); return true; };
  await runClaimedAnalysis(
    job(),
    repo,
    async () => valid,
    async () => ({ outcome: 'sent', retireToken: false }),
    new Date('2026-07-13T12:00:00Z'),
  );
  assert.equal(calls.includes('store'), false);
});

test('a first failed analysis is retried after one minute', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  const retryTimes: string[] = [];
  repo.markRetry = async (_job, nextAt) => { calls.push('retry'); retryTimes.push(nextAt.toISOString()); return true; };
  repo.markFailed = async () => { calls.push('failed'); return true; };
  await runClaimedAnalysis(
    job(),
    repo,
    async () => { throw new Error('analysis failed'); },
    async () => ({ outcome: 'sent', retireToken: false }),
    new Date('2026-07-13T12:00:00Z'),
  );
  assert.deepEqual(calls.filter((call) => call === 'retry'), ['retry']);
  assert.deepEqual(retryTimes, ['2026-07-13T12:01:00.000Z']);
  assert.equal(calls.includes('failed'), false);
});

test('an analysis at the retry limit is failed without another retry', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  repo.markRetry = async () => { calls.push('retry'); return true; };
  repo.markFailed = async () => { calls.push('failed'); return true; };
  await runClaimedAnalysis(
    { ...job(), retryCount: 5 },
    repo,
    async () => { throw new Error('analysis failed'); },
    async () => ({ outcome: 'sent', retireToken: false }),
    new Date('2026-07-13T12:00:00Z'),
  );
  assert.deepEqual(calls.filter((call) => call === 'failed'), ['failed']);
  assert.equal(calls.includes('retry'), false);
});

function job(): AnalysisJob {
  return { id: 'j1', kind: 'workout', userId: 'u1', localDate: '2026-07-12', input: {}, retryCount: 0, notificationRetryCount: 0, leaseToken: 'lease' };
}

function fakeRepository(calls: string[], enabled: boolean): WorkerRepository {
  let sent = false;
  return {
    async getContext() { return { enabled, timezone: 'UTC', baselines: {}, profile: {}, metrics: {} }; },
    async renewAnalysisLease() { return true; }, async storeReady() { return true; }, async markRetry() { return true; }, async markFailed() { return true; },
    async suppress() { calls.push('suppress'); return true; },
    async suppressNotification() { calls.push('suppress'); return true; },
    async claimNotification() { if (sent) return null; sent = true; return 'notification-lease'; },
    async renewNotificationLease() { return true; },
    async markNotificationRetry() {}, async markNotificationFailed() {},
    async listDevices() { return [{ id: 'd1', token: 'secret', environment: 'sandbox' }]; },
    async recordPushAttempt() {}, async retireDevice() {}, async markNotificationSent() {},
  };
}
