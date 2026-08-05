import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';
import { type CoachAnalysis } from './proactiveAnalysisSchema';
import { type MorningBriefClaim } from './proactiveHealthWorkerRepository';

/**
 * `completeMorningBrief` must persist the generated brief before any push
 * leaves the process — a client can tap the notification within milliseconds
 * of delivery, so the row has to be readable before the send loop starts.
 * This drives the real implementation against a fake `@/db`, in the same
 * style as `proactiveHealthWorkerRepository.test.ts` (own file: `@/db` must
 * be mocked before the module is first imported in this process, and
 * node:test runs each test file in its own subprocess).
 */
test('completeMorningBrief writes the result before the first send, and a lost lease returns without sending', async () => {
  const events: string[] = [];
  let resultWriteRows: Array<{ id: string }> = [{ id: 'slot-1' }];

  const fakeDb = {
    select: () => ({
      from: () => ({
        where: async () => [{ id: 'device-1', device_token: 'token-1', environment: 'sandbox' }],
      }),
    }),
    update: (_table: unknown) => ({
      set: (assigned: Record<string, unknown>) => ({
        where: () => {
          if ('result' in assigned) {
            events.push('result-write');
            return { returning: async () => resultWriteRows };
          }
          if ('lease_expires_at' in assigned && Object.keys(assigned).length === 1) {
            events.push('lease-renew');
            return { returning: async () => [{ id: 'slot-1' }] };
          }
          events.push('final-update');
          return { returning: async () => [] };
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: () => ({
        onConflictDoNothing: async () => { events.push('insert-push-attempt'); },
      }),
    }),
  };

  mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
  const { completeMorningBrief } = await import('./proactiveHealthWorkerRepository');

  const claim: MorningBriefClaim = {
    slotId: 'slot-1', userId: 'user-1', localDate: '2026-08-05',
    timezone: 'UTC', idempotencyKey: 'brief:user-1:2026-08-05', leaseToken: 'lease-1', retryCount: 0,
  };
  const result: CoachAnalysis = {
    headline: 'Good sleep', shortInsight: 'Recovery is up',
    narrative: 'You slept well.', observations: [], nextSteps: [],
  };
  const send = async () => { events.push('send'); return { outcome: 'sent' as const, retireToken: false }; };

  // Lease held: result is written, THEN the lease is renewed, THEN the send
  // fires — the persistence write happens strictly before any push attempt.
  await completeMorningBrief(claim, result, send, new Date('2026-08-05T12:00:00Z'));
  assert.deepEqual(events, ['result-write', 'lease-renew', 'send', 'insert-push-attempt', 'final-update']);

  // Lease lost on the result CAS: return immediately, no devices listed, no send.
  events.length = 0;
  resultWriteRows = [];
  await completeMorningBrief(claim, result, send, new Date('2026-08-05T12:00:00Z'));
  assert.deepEqual(events, ['result-write']);
});
