import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWeeklyReviewPassState,
  runWeeklyReviewPass,
  type WeeklyReviewPassDeps,
} from './weeklyReviewWorker';
import type { WeeklyReview } from './weeklyReview';

// 2026-10-05 is a Monday; 13:00Z = 09:00 in New York.
const MON_1300Z = new Date('2026-10-05T13:00:00Z');

function review(): WeeklyReview {
  return {
    weekStart: '2026-09-28', weekEnd: '2026-10-04', goal: 'weight_loss', verdict: 'on_track',
    headline: 'Down 0.6 kg', stats: [], win: null, slip: null, nextWeek: 'x',
    dataSufficiency: { daysWithData: 6, statCount: 3, sufficient: true },
  };
}

function deps(over: Partial<WeeklyReviewPassDeps> & { sent?: unknown[]; claimed?: Set<string> } = {}): WeeklyReviewPassDeps {
  const sent = over.sent ?? [];
  const claimed = over.claimed ?? new Set<string>();
  return {
    listCandidates: async () => [{ userId: 'u1', timezone: 'America/New_York', morningMinutes: 450 }],
    getOrCreate: async () => ({ id: 'r1', review: review() }),
    claimPush: async (id) => { if (claimed.has(id)) return false; claimed.add(id); return true; },
    listDevices: async () => [{ id: 'd1', token: 't', environment: 'sandbox' as const }],
    send: async (device, alert, route) => { sent.push({ device: device.id, alert, route }); return { outcome: 'sent', retireToken: false }; },
    retireDevice: async () => {},
    ...over,
  };
}

test('done set: a finished user costs zero deps calls on later ticks', async () => {
  const state = createWeeklyReviewPassState();
  let getOrCreates = 0;
  const d = deps({ getOrCreate: async () => { getOrCreates++; return { id: 'r1', review: review() }; } });
  await runWeeklyReviewPass(MON_1300Z, d, state);
  await runWeeklyReviewPass(new Date(MON_1300Z.getTime() + 15_000), d, state);
  await runWeeklyReviewPass(new Date(MON_1300Z.getTime() + 30_000), d, state);
  assert.equal(getOrCreates, 1);
  // Next Monday is a new reviewed week, so the user is processed again.
  await runWeeklyReviewPass(new Date('2026-10-12T13:00:00Z'), d, state);
  assert.equal(getOrCreates, 2);
});

test('bounds computations per tick and picks the rest up on the next tick', async () => {
  const state = createWeeklyReviewPassState();
  const users = Array.from({ length: 7 }, (_, i) => ({ userId: `u${i}`, timezone: 'America/New_York', morningMinutes: 450 }));
  const computedFor: string[] = [];
  const d = deps({
    listCandidates: async () => users,
    getOrCreate: async (userId) => { computedFor.push(userId); return { id: `r-${userId}`, review: review() }; },
  });
  const first = await runWeeklyReviewPass(MON_1300Z, d, state, { maxPerTick: 3 });
  assert.equal(first.length, 3);
  const second = await runWeeklyReviewPass(MON_1300Z, d, state, { maxPerTick: 3 });
  assert.deepEqual(second.map(r => r.userId), ['u3', 'u4', 'u5']);
  await runWeeklyReviewPass(MON_1300Z, d, state, { maxPerTick: 3 });
  assert.deepEqual(computedFor, users.map(u => u.userId));
});

test('no devices releases the claim so the review can still go later that day', async () => {
  const claimed = new Set<string>();
  const sent: unknown[] = [];
  let devices: Array<{ id: string; token: string; environment: 'sandbox' }> = [];
  const d = deps({
    claimed, sent,
    listDevices: async () => devices,
    releaseClaim: async (id) => { claimed.delete(id); },
  });
  const state = createWeeklyReviewPassState();
  assert.deepEqual(await runWeeklyReviewPass(MON_1300Z, d, state), [{ userId: 'u1', outcome: 'no_devices' }]);
  assert.equal(claimed.has('r1'), false);
  devices = [{ id: 'd1', token: 't', environment: 'sandbox' }];
  assert.deepEqual(await runWeeklyReviewPass(new Date(MON_1300Z.getTime() + 15_000), d, state), [{ userId: 'u1', outcome: 'sent' }]);
  assert.equal(sent.length, 1);
});

test('send failure after claim is logged with context, not retried, and backed off', async () => {
  const errors: Error[] = [];
  const claimed = new Set<string>();
  let sends = 0;
  const d = deps({
    claimed,
    send: async () => { sends++; throw new Error('apns down'); },
    onError: (_u, e) => { errors.push(e as Error); },
  });
  const state = createWeeklyReviewPassState();
  await runWeeklyReviewPass(MON_1300Z, d, state);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /r1[\s\S]*send[\s\S]*u1[\s\S]*AFTER claim[\s\S]*apns down/);
  // Within the backoff window the user is not touched at all.
  await runWeeklyReviewPass(new Date(MON_1300Z.getTime() + 15_000), d, state);
  assert.equal(errors.length, 1);
  // After backoff the claim is already held, so nothing is re-sent.
  const out = await runWeeklyReviewPass(new Date(MON_1300Z.getTime() + 6 * 60_000), d, state);
  assert.deepEqual(out, [{ userId: 'u1', outcome: 'already_pushed' }]);
  assert.equal(sends, 1);
});
