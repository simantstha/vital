import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWeeklyReviewDue,
  runWeeklyReviewPass,
  weeklyReviewAlert,
  type WeeklyReviewPassDeps,
} from './weeklyReviewWorker';
import type { WeeklyReview } from './weeklyReview';

// 2026-10-05 is a Monday.
const MON_1300Z = new Date('2026-10-05T13:00:00Z');

function review(sufficient = true): WeeklyReview {
  return {
    weekStart: '2026-09-28', weekEnd: '2026-10-04', goal: 'weight_loss', verdict: 'on_track',
    headline: 'Down 0.6 kg, in budget 5 of 7 days', stats: [], win: null, slip: null, nextWeek: 'x',
    dataSufficiency: { daysWithData: sufficient ? 6 : 1, statCount: sufficient ? 3 : 0, sufficient },
  };
}

test('isWeeklyReviewDue: only on a local Monday at/after the morning time', () => {
  // 13:00Z Monday = 09:00 New York, 22:00 Tokyo, 06:00 Los Angeles.
  assert.equal(isWeeklyReviewDue(MON_1300Z, 'America/New_York', 450), true);
  assert.equal(isWeeklyReviewDue(MON_1300Z, 'America/Los_Angeles', 450), false); // 06:00 < 07:30
  assert.equal(isWeeklyReviewDue(MON_1300Z, 'Asia/Tokyo', 450), true);
  // Tuesday 13:00Z.
  assert.equal(isWeeklyReviewDue(new Date('2026-10-06T13:00:00Z'), 'America/New_York', 450), false);
  // Sunday 23:00 New York is already Monday in Tokyo but not in New York.
  assert.equal(isWeeklyReviewDue(new Date('2026-10-05T03:00:00Z'), 'America/New_York', 0), false);
  assert.equal(isWeeklyReviewDue(new Date('2026-10-05T03:00:00Z'), 'Asia/Tokyo', 0), true);
});

test('weeklyReviewAlert carries the headline', () => {
  assert.deepEqual(weeklyReviewAlert(review()), { title: 'Your week', body: 'Down 0.6 kg, in budget 5 of 7 days' });
});

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

test('runWeeklyReviewPass sends exactly one push, then never again for the same review', async () => {
  const sent: unknown[] = [];
  const claimed = new Set<string>();
  const d = deps({ sent, claimed });
  const first = await runWeeklyReviewPass(MON_1300Z, d);
  assert.deepEqual(first, [{ userId: 'u1', outcome: 'sent' }]);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as { route: unknown }).route, { type: 'weekly_review', id: 'r1', deepLink: 'vital://weekly-review/r1' });

  const second = await runWeeklyReviewPass(new Date(MON_1300Z.getTime() + 15_000), d);
  assert.deepEqual(second, [{ userId: 'u1', outcome: 'already_pushed' }]);
  assert.equal(sent.length, 1);
});

test('runWeeklyReviewPass skips users who are not due and never computes for them', async () => {
  let computed = 0;
  const out = await runWeeklyReviewPass(new Date('2026-10-06T13:00:00Z'), deps({ getOrCreate: async () => { computed++; return null; } }));
  assert.deepEqual(out, []);
  assert.equal(computed, 0);
});

test('runWeeklyReviewPass does not push an insufficient-data review but still claims it', async () => {
  const sent: unknown[] = [];
  const claimed = new Set<string>();
  const out = await runWeeklyReviewPass(MON_1300Z, deps({ sent, claimed, getOrCreate: async () => ({ id: 'r2', review: review(false) }) }));
  assert.deepEqual(out, [{ userId: 'u1', outcome: 'insufficient_data' }]);
  assert.equal(sent.length, 0);
  assert.ok(claimed.has('r2'));
});

test('runWeeklyReviewPass retires dead tokens and isolates per-user errors', async () => {
  const retired: string[] = [];
  const errors: string[] = [];
  const out = await runWeeklyReviewPass(MON_1300Z, deps({
    listCandidates: async () => [
      { userId: 'bad', timezone: 'America/New_York', morningMinutes: 0 },
      { userId: 'u1', timezone: 'America/New_York', morningMinutes: 0 },
    ],
    getOrCreate: async (userId) => { if (userId === 'bad') throw new Error('boom'); return { id: 'r1', review: review() }; },
    send: async () => ({ outcome: 'permanent', retireToken: true }),
    retireDevice: async (id) => { retired.push(id); },
    onError: (userId) => { errors.push(userId); },
  }));
  assert.deepEqual(errors, ['bad']);
  assert.deepEqual(retired, ['d1']);
  assert.deepEqual(out, [{ userId: 'u1', outcome: 'sent' }]);
});
