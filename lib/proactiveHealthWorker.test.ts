import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyApnsResponse,
  consumeMorningAnalysisProof,
  fallbackAnalysis,
  nextRetryAt,
  runClaimedAnalysis,
  shouldRunMorningBrief,
  type AnalysisContext,
  type AnalysisJob,
  type WorkerRepository,
} from './proactiveHealthWorker';
import {
  AnalysisContentError,
  consumeGroundedAnalysisProof,
  encodeProactiveAnalysisRequest,
  groundAnalysisText,
  modelPayload,
  type GroundedAnalysisProof,
  type ProactiveAnalysisSource,
} from './proactiveAnalysisGrounding';

const valid = {
  headline: 'A useful signal', shortInsight: 'Recovery held steady.',
  narrative: 'Your available data suggests a steady day.',
  observations: ['Sleep duration was recorded.'], nextSteps: ['Keep today comfortable.'],
};

function enabledContext(): AnalysisContext {
  return { enabled: true, timezone: 'UTC', baselines: {}, profile: {}, metrics: {} };
}

function sourceFor(value: AnalysisJob, context = enabledContext()): ProactiveAnalysisSource {
  return { kind: value.kind, date: value.localDate, input: value.input, availableContext: context };
}

function trustedProof(source: ProactiveAnalysisSource): GroundedAnalysisProof {
  const encoded = encodeProactiveAnalysisRequest(source);
  const [token] = JSON.stringify(modelPayload(encoded)).match(/⟦EVIDENCE_[A-Z]+⟧/g) ?? [];
  assert.ok(token);
  return groundAnalysisText(JSON.stringify({ ...valid, narrative: `Available data included ${token}.` }), encoded);
}

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
  await runClaimedAnalysis(job(), repo, async (value, context) => { calls.push('analyze'); return trustedProof(sourceFor(value, context)); }, async () => {
    calls.push('push'); return { outcome: 'sent', retireToken: false };
  }, new Date());
  assert.deepEqual(calls, ['suppress']);
});

test('one logical notification is sent despite a duplicate worker delivery', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  const analyze = async (value: AnalysisJob, context: AnalysisContext) => trustedProof(sourceFor(value, context));
  const push = async () => { calls.push('push'); return { outcome: 'sent' as const, retireToken: false }; };
  await runClaimedAnalysis(job(), repo, analyze, push, new Date());
  await runClaimedAnalysis(job(), repo, analyze, push, new Date());
  assert.equal(calls.filter((x) => x === 'push').length, 1);
});

test('a grounded proof is not stored after lease ownership is lost', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  let renewals = 0;
  repo.renewAnalysisLease = async () => ++renewals === 1;
  repo.storeReady = async () => { calls.push('store'); return true; };
  await runClaimedAnalysis(
    job(),
    repo,
    async (value, context) => trustedProof(sourceFor(value, context)),
    async () => ({ outcome: 'sent', retireToken: false }),
    new Date('2026-07-13T12:00:00Z'),
  );
  assert.equal(calls.includes('store'), false);
});

test('forged, copied, serialized, and reused proofs take the retry path before persistence or notification', async () => {
  const expectedSource = sourceFor(job());
  const consumed = trustedProof(expectedSource);
  consumeGroundedAnalysisProof(consumed, expectedSource);
  const fresh = trustedProof(expectedSource);
  const untrusted: GroundedAnalysisProof[] = [
    valid as unknown as GroundedAnalysisProof,
    {} as GroundedAnalysisProof,
    { ...fresh } as GroundedAnalysisProof,
    JSON.parse(JSON.stringify(fresh)) as GroundedAnalysisProof,
    consumed,
  ];

  for (const proof of untrusted) {
    const calls: string[] = [];
    const repo = fakeRepository(calls, true);
    repo.storeReady = async () => { calls.push('store'); return true; };
    repo.markRetry = async () => { calls.push('retry'); return true; };
    repo.claimNotification = async () => { calls.push('claim'); return 'notification-lease'; };
    await runClaimedAnalysis(
      job(),
      repo,
      async () => proof,
      async () => { calls.push('push'); return { outcome: 'sent', retireToken: false }; },
      new Date('2026-07-13T12:00:00Z'),
    );
    assert.deepEqual(calls.filter((call) => call === 'retry'), ['retry']);
    assert.equal(calls.includes('store'), false);
    assert.equal(calls.includes('claim'), false);
    assert.equal(calls.includes('push'), false);
  }
});

test('a fresh proof for another canonical request retries before queued persistence or notification', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  repo.storeReady = async () => { calls.push('store'); return true; };
  repo.markRetry = async () => { calls.push('retry'); return true; };
  repo.claimNotification = async () => { calls.push('claim'); return 'notification-lease'; };
  const expected = sourceFor(job());
  const wrong = { ...expected, date: '2026-07-11' };
  const proof = trustedProof(wrong);
  await runClaimedAnalysis(
    job(),
    repo,
    async () => proof,
    async () => { calls.push('push'); return { outcome: 'sent', retireToken: false }; },
    new Date('2026-07-13T12:00:00Z'),
  );
  assert.deepEqual(calls.filter((call) => call === 'retry'), ['retry']);
  assert.equal(calls.includes('store'), false);
  assert.equal(calls.includes('claim'), false);
  assert.equal(calls.includes('push'), false);
});

test('morning completion consumes only a fresh trusted proof immediately before owned completion', () => {
  const calls: string[] = [];
  const completeOwned = (analysis: unknown) => { assert.ok(analysis); calls.push('complete'); };
  const expectedSource = sourceFor(job());
  const proof = trustedProof(expectedSource);
  completeOwned(consumeMorningAnalysisProof(proof, expectedSource));
  assert.deepEqual(calls, ['complete']);

  const consumed = trustedProof(expectedSource);
  consumeMorningAnalysisProof(consumed, expectedSource);
  const fresh = trustedProof(expectedSource);
  const untrusted: GroundedAnalysisProof[] = [
    valid as unknown as GroundedAnalysisProof,
    { ...fresh } as GroundedAnalysisProof,
    JSON.parse(JSON.stringify(fresh)) as GroundedAnalysisProof,
    consumed,
  ];
  for (const candidate of untrusted) {
    assert.throws(() => completeOwned(consumeMorningAnalysisProof(candidate, expectedSource)), /invalid grounded analysis proof/i);
  }
  assert.deepEqual(calls, ['complete']);
});

test('morning proof consumption rejects a fresh proof bound to another request without burning it', () => {
  const expected = sourceFor(job());
  const wrong = { ...expected, date: '2026-07-11' };
  const proof = trustedProof(wrong);
  assert.throws(() => consumeMorningAnalysisProof(proof, expected), /invalid grounded analysis proof/i);
  assert.ok(consumeMorningAnalysisProof(proof, wrong));
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

test('a content-grounding failure still stores and delivers a fallback notification instead of retrying', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  let storedAnalysis: unknown;
  let pushedAnalysis: unknown;
  repo.storeReady = async (_job, analysis) => { calls.push('store'); storedAnalysis = analysis; return true; };
  repo.claimNotification = async () => { calls.push('claim'); return 'notification-lease'; };
  repo.markRetry = async () => { calls.push('retry'); return true; };
  repo.markFailed = async () => { calls.push('failed'); return true; };
  const currentJob = { ...job(), input: { type: 'Run' } };
  await runClaimedAnalysis(
    currentJob,
    repo,
    async () => { throw new AnalysisContentError('grounding_failure'); },
    async (_device, analysis) => { calls.push('push'); pushedAnalysis = analysis; return { outcome: 'sent', retireToken: false }; },
    new Date('2026-07-13T12:00:00Z'),
  );
  assert.deepEqual(calls, ['store', 'claim', 'push']);
  const expected = fallbackAnalysis('workout', currentJob.input);
  assert.deepEqual(storedAnalysis, expected);
  assert.deepEqual(pushedAnalysis, expected);
  assert.doesNotMatch(JSON.stringify(storedAnalysis), /EVIDENCE/);
});

test('a non-content error still retries instead of falling back', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  repo.storeReady = async () => { calls.push('store'); return true; };
  repo.claimNotification = async () => { calls.push('claim'); return 'notification-lease'; };
  repo.markRetry = async () => { calls.push('retry'); return true; };
  repo.markFailed = async () => { calls.push('failed'); return true; };
  await runClaimedAnalysis(
    job(),
    repo,
    async () => { throw new Error('transient upstream failure'); },
    async () => { calls.push('push'); return { outcome: 'sent', retireToken: false }; },
    new Date('2026-07-13T12:00:00Z'),
  );
  assert.deepEqual(calls, ['retry']);
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
    async getContext() { return { ...enabledContext(), enabled }; },
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
