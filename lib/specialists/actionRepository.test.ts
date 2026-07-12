import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpecialistActionResult } from './orchestration';
import {
  SpecialistActionRepository,
  type SpecialistActionPersistence,
} from './actionRepository';

const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '10000000-0000-4000-8000-000000000001';

function result(): SpecialistActionResult {
  return {
    session: {
      id: SESSION,
      userId: USER,
      objective: 'Build a running week',
      manifestId: 'running-coach',
      manifestVersion: '1.0.0',
      status: 'active',
      inboundHandoff: { summary: 'Runner' },
      returnHandoff: null,
      failureReason: null,
      proposedAt: new Date('2026-07-11T12:00:00Z'),
      activatedAt: new Date('2026-07-11T12:01:00Z'),
      returnProposedAt: null,
      completedAt: null,
      declinedAt: null,
      failedAt: null,
      expiresAt: null,
      updatedAt: new Date('2026-07-11T12:01:00Z'),
    },
    events: [
      {
        type: 'handoff_card',
        phase: 'dismissed',
        sessionId: SESSION,
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

test('action repository persists and retrieves idempotent result by user and action id', async () => {
  let row: Record<string, unknown> | null = null;
  const persistence: SpecialistActionPersistence = {
    async find(userId, actionId) {
      return row?.user_id === userId && row?.action_id === actionId ? row as never : null;
    },
    async insert(values) {
      if (row) return row as never;
      row = { id: '20000000-0000-4000-8000-000000000001', created_at: new Date(), ...values };
      return row as never;
    },
  };
  const repository = new SpecialistActionRepository(persistence);
  const expected = result();
  assert.equal(await repository.find(USER, 'accept-1'), null);
  assert.deepEqual(
    await repository.save(USER, 'accept-1', SESSION, 'accept_handoff', expected),
    expected,
  );
  assert.deepEqual(await repository.find(USER, 'accept-1'), expected);
  const rawRow = row as unknown as Record<string, unknown>;
  assert.equal(rawRow.session_id, SESSION);
  assert.equal(rawRow.action, 'accept_handoff');
});

test('action repository never returns another user action', async () => {
  const expected = result();
  const persistence: SpecialistActionPersistence = {
    async find() {
      return {
        id: '20000000-0000-4000-8000-000000000001',
        user_id: USER,
        action_id: 'shared-id',
        session_id: SESSION,
        action: 'accept_handoff',
        result: expected,
        created_at: new Date(),
      } as never;
    },
    async insert() { throw new Error('not used'); },
  };
  const repository = new SpecialistActionRepository(persistence);
  assert.equal(await repository.find('00000000-0000-4000-8000-000000000002', 'shared-id'), null);
});
