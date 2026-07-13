import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyApnsResponse,
  nextRetryAt,
  parseCoachAnalysis,
  validateGroundedAnalysis,
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

test('strictly validates structured coach output', () => {
  assert.deepEqual(parseCoachAnalysis(valid), valid);
  assert.throws(() => parseCoachAnalysis({ ...valid, invented: true }), /unexpected field/);
  assert.throws(() => parseCoachAnalysis({ ...valid, observations: [''] }), /observations/);
  assert.throws(() => parseCoachAnalysis({ ...valid, headline: 'x'.repeat(121) }), /headline/);
});

test('rejects fabricated numeric health claims and accepts grounded metric units', () => {
  assert.throws(() => validateGroundedAnalysis({ ...valid, narrative: 'Your HRV was 99 ms.' }, { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }), /unsupported numeric claim/);
  assert.doesNotThrow(() => validateGroundedAnalysis({ ...valid, narrative: 'Your HRV was 45 ms.' }, { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }));
  assert.doesNotThrow(() => validateGroundedAnalysis(valid, {}));
});

test('grounding requires an exact supplied value with the same source unit', () => {
  const analysis = (narrative: string) => ({ ...valid, narrative });

  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your HRV was 45 ms.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your HRV was 45 milliseconds.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your score was 45.'), { score: 45 }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your walk lasted 2 hrs.'), { summary: 'Duration: 2 hours.' }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Energy was 300 calories.'), { summary: 'Energy: 300 kcal.' }));

  assert.throws(() => validateGroundedAnalysis(analysis('Your HRV was 45.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }), /unit/);
  assert.throws(() => validateGroundedAnalysis(analysis('Your score was 45 ms.'), { score: 45 }), /unit/);
  assert.throws(() => validateGroundedAnalysis(analysis('Your HRV was 45 bpm.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }), /unit/);
  assert.throws(() => validateGroundedAnalysis(analysis('Your HRV was 45 seconds.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }), /unit/);
  assert.throws(() => validateGroundedAnalysis(analysis('Your HRV was 45 bananas.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }), /unit/);
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your HRV was 45-ms.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your HRV was 45_ms.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your HRV was 45/ms.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }));
});

test('grounding distinguishes ordinary prose from complete signed, decimal, and symbol-unit claims', () => {
  const analysis = (narrative: string) => ({ ...valid, narrative });
  const unitlessEvidence = { score: 45 };

  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your score was 45 today.'), unitlessEvidence));
  assert.throws(() => validateGroundedAnalysis(analysis('Your score was -45.'), unitlessEvidence), /unsupported numeric claim: -45/);
  assert.throws(() => validateGroundedAnalysis(analysis('Your score was +45.'), unitlessEvidence), /unsupported numeric claim: \+45/);
  assert.throws(() => validateGroundedAnalysis(analysis('Your score was .5.'), unitlessEvidence), /unsupported numeric claim: \.5/);
  assert.throws(() => validateGroundedAnalysis(analysis('Your temperature was 45°C.'), unitlessEvidence), /unsupported unit claim: 45 °c/);
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Your temperature was 45 ℃.'), { summary: 'Temperature: 45°C.' }));
});

test('grounding canonicalizes repository health units and rejects ambiguous numeric syntax', () => {
  const analysis = (narrative: string) => ({ ...valid, narrative });
  const distanceEvidence = { metrics: [{ metric: 'distance_m', value: 45 }] };
  const vo2Evidence = { metrics: [{ metric: 'vo2_max', value: 45 }] };

  for (const claim of ['45 m', '45 meters', '45 metres', '45-meters']) {
    assert.doesNotThrow(() => validateGroundedAnalysis(analysis(`Distance was ${claim}.`), distanceEvidence));
  }
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Pressure was 45 mmHg.'), { summary: 'Pressure: 45 MMHG.' }));
  for (const claim of ['45 ml/kg/min', '45 mL/kg*min', '45 ml/kg·min']) {
    assert.doesNotThrow(() => validateGroundedAnalysis(analysis(`VO2 max was ${claim}.`), vo2Evidence));
  }

  assert.throws(() => validateGroundedAnalysis(analysis('HRV was 45 meters.'), { metrics: [{ metric: 'hrv_sdnn', value: 45 }] }), /unit/);
  assert.throws(() => validateGroundedAnalysis(analysis('Score was 45widgets.'), { score: 45 }), /unsupported unit claim: 45 widgets/);
  assert.throws(() => validateGroundedAnalysis(analysis('Score was 45µg.'), { score: 45 }), /unsupported unit claim: 45 µg/);
  assert.throws(() => validateGroundedAnalysis(analysis('Score was 45-widgets.'), { score: 45 }), /unsupported unit claim: 45 -widgets/);
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Score was 45 today.'), { score: 45 }));
  assert.throws(() => validateGroundedAnalysis(analysis('Score was 1e3.'), { score: 1 }), /unsupported numeric claim: 1e3/);
  assert.throws(() => validateGroundedAnalysis(analysis('Score was 1,000.'), { score: 1 }), /unsupported numeric claim: 1,000/);

  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Average HR was 45 bpm.'), { metrics: [{ metric: 'hr_avg', value: 45 }] }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Average HR was 45 bpm.'), { workout: { avgHr: 45 } }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Pace was 5 min/km.'), { workout: { paceMinPerKm: 5 } }));
  assert.doesNotThrow(() => validateGroundedAnalysis(analysis('Sleep was 45 min.'), { sleep: { minutes: 45 } }));
});

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
