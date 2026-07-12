import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpecialistActionResult } from './orchestration';
import {
  SpecialistActionRepository,
  type SpecialistActionPersistence,
} from './actionRepository';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const SESSION = '10000000-0000-4000-8000-000000000001';

function result(): SpecialistActionResult {
  return {
    session: {
      id: SESSION, userId: USER, objective: 'Build a running week',
      manifestId: 'running-coach', manifestVersion: '1.0.0', status: 'active',
      inboundHandoff: { summary: 'Runner' }, returnHandoff: null, failureReason: null,
      proposedAt: new Date('2026-07-11T12:00:00Z'),
      activatedAt: new Date('2026-07-11T12:01:00Z'), returnProposedAt: null,
      completedAt: null, declinedAt: null, failedAt: null, expiresAt: null,
      updatedAt: new Date('2026-07-11T12:01:00Z'),
    },
    events: [
      {
        type: 'handoff_card', phase: 'dismissed', sessionId: SESSION,
        specialist: {
          id: 'running-coach', title: 'Running Coach', subtitle: 'Vital Specialist',
          accent: '#4CC9F0', icon: 'figure.run', sessionId: SESSION,
        },
        objective: 'Build a running week',
      },
      {
        type: 'persona_changed',
        persona: {
          id: 'running-coach', title: 'Running Coach', subtitle: 'Vital Specialist',
          accent: '#4CC9F0', icon: 'figure.run', sessionId: SESSION,
        },
      },
    ],
  };
}

function persistence(): SpecialistActionPersistence {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (userId: string, actionId: string) => `${userId}:${actionId}`;
  return {
    async find(userId, actionId) {
      return (rows.get(key(userId, actionId)) ?? null) as never;
    },
    async insertClaim(values) {
      const rowKey = key(values.user_id, values.action_id);
      const existing = rows.get(rowKey);
      if (existing) return existing as never;
      const row = {
        id: '20000000-0000-4000-8000-000000000001',
        created_at: new Date(), completed_at: null, ...values,
      };
      rows.set(rowKey, row);
      return row as never;
    },
    async complete(userId, actionId, completedResult) {
      const rowKey = key(userId, actionId);
      const row = rows.get(rowKey);
      if (!row) throw new Error('missing claim');
      if (row.result === null) {
        row.result = completedResult;
        row.completed_at = new Date();
      }
      return row as never;
    },
  };
}

test('action repository claims before transition and later replays the completed result', async () => {
  const repository = new SpecialistActionRepository(persistence());
  assert.deepEqual(await repository.claim(USER, 'accept-1', SESSION, 'accept_handoff'), {
    sessionId: SESSION,
    action: 'accept_handoff',
    result: null,
  });
  const expected = result();
  assert.deepEqual(await repository.complete(USER, 'accept-1', expected), expected);
  assert.deepEqual(await repository.claim(USER, 'accept-1', SESSION, 'accept_handoff'), {
    sessionId: SESSION,
    action: 'accept_handoff',
    result: expected,
  });
});

test('action claims are scoped by user and retain the original request identity', async () => {
  const repository = new SpecialistActionRepository(persistence());
  await repository.claim(USER, 'shared-id', SESSION, 'accept_handoff');
  const other = await repository.claim(OTHER_USER, 'shared-id', SESSION, 'decline_handoff');
  assert.deepEqual(other, {
    sessionId: SESSION,
    action: 'decline_handoff',
    result: null,
  });
  const original = await repository.claim(USER, 'shared-id', 'different-session', 'accept_return');
  assert.equal(original.sessionId, SESSION);
  assert.equal(original.action, 'accept_handoff');
});
