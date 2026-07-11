import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  InMemorySpecialistSessionRepository,
  ConcurrentSpecialistSessionUpdateError,
  InvalidSpecialistSessionTransitionError,
  OpenSpecialistSessionExistsError,
  ProposalExpiryRequiredError,
  SpecialistSessionService,
  VALID_SPECIALIST_SESSION_TRANSITIONS,
  type SpecialistSessionStatus,
} from './sessions';

const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-07-11T12:00:00.000Z');

function service() {
  return new SpecialistSessionService(
    new InMemorySpecialistSessionRepository(),
    () => NOW,
    { get: (id: string) => {
      if (id !== 'running-coach') throw new Error(`Unknown specialist: ${id}`);
      return { version: '1.0.0' };
    } },
  );
}

async function seedSession(
  sessions: ReturnType<typeof service>,
  status: SpecialistSessionStatus,
  userId = USER_A,
) {
  return sessions.repository.insert({
    id: randomUUID(),
    userId,
    objective: 'Test objective',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    status,
    inboundHandoff: {},
    returnHandoff: null,
    failureReason: null,
    proposedAt: NOW,
    activatedAt: status === 'active' ? NOW : null,
    returnProposedAt: status === 'return_proposed' ? NOW : null,
    completedAt: status === 'completed' ? NOW : null,
    declinedAt: status === 'declined' ? NOW : null,
    failedAt: status === 'failed' ? NOW : null,
    expiresAt: status === 'proposed' || status === 'return_proposed'
      ? new Date('2026-07-11T12:15:00.000Z')
      : null,
    updatedAt: NOW,
  });
}

test('every documented lifecycle transition succeeds', async () => {
  for (const [from, destinations] of Object.entries(VALID_SPECIALIST_SESSION_TRANSITIONS)) {
    for (const to of destinations) {
      const sessions = service();
      const proposed = await sessions.propose({
        userId: USER_A,
        objective: 'Prepare safely for a 10K',
        manifestId: 'running-coach',
        manifestVersion: '1.0.0',
        inboundHandoff: { summary: 'User wants a training plan.' },
        expiresAt: new Date('2026-07-11T12:15:00.000Z'),
      });
      let current = proposed;
      if (from === 'active' || from === 'return_proposed') {
        current = await sessions.transition(USER_A, current.id, 'active');
      }
      if (from === 'return_proposed') {
        current = await sessions.transition(USER_A, current.id, 'return_proposed', {
          returnHandoff: { summary: 'Consultation is ready to return.' },
          expiresAt: new Date('2026-07-11T12:20:00.000Z'),
        });
      }

      const changed = await sessions.transition(
        USER_A,
        current.id,
        to,
        to === 'return_proposed'
          ? {
              returnHandoff: { summary: 'Consultation is ready to return.' },
              expiresAt: new Date('2026-07-11T12:20:00.000Z'),
            }
          : undefined,
      );
      assert.equal(changed.status, to);
    }
  }
});

test('all undocumented and terminal-state transitions are rejected', async () => {
  const allStatuses: SpecialistSessionStatus[] = [
    'proposed', 'active', 'return_proposed', 'completed', 'declined', 'failed',
  ];

  for (const from of allStatuses) {
    const valid = new Set<SpecialistSessionStatus>(VALID_SPECIALIST_SESSION_TRANSITIONS[from]);
    for (const to of allStatuses.filter((candidate) => !valid.has(candidate))) {
      const sessions = service();
      const row = await seedSession(sessions, from);

      await assert.rejects(
        sessions.transition(USER_A, row.id, to),
        InvalidSpecialistSessionTransitionError,
      );
    }
  }
});

test('only one open session is allowed per user while other users remain independent', async () => {
  const sessions = service();
  const input = {
    objective: 'Improve running recovery',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    inboundHandoff: { summary: 'Recovery has been inconsistent.' },
    expiresAt: new Date('2026-07-11T12:15:00.000Z'),
  };

  await sessions.propose({ ...input, userId: USER_A });
  await assert.rejects(
    sessions.propose({ ...input, userId: USER_A }),
    OpenSpecialistSessionExistsError,
  );
  const otherUser = await sessions.propose({ ...input, userId: USER_B });
  assert.equal(otherUser.userId, USER_B);
});

test('session reads and transitions are scoped to the owning user', async () => {
  const sessions = service();
  const proposed = await sessions.propose({
    userId: USER_A,
    objective: 'Build toward a 10K',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    inboundHandoff: { summary: 'User runs three times weekly.' },
    expiresAt: new Date('2026-07-11T12:15:00.000Z'),
  });

  assert.equal(await sessions.get(USER_B, proposed.id), null);
  await assert.rejects(sessions.transition(USER_B, proposed.id, 'active'), /not found/);
  assert.equal((await sessions.get(USER_A, proposed.id))?.id, proposed.id);
});

test('proposal expiry fails pending proposals but never expires active consultations', async () => {
  const sessions = service();
  const expired = await sessions.propose({
    userId: USER_A,
    objective: 'Review recent training',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    inboundHandoff: { summary: 'Review requested.' },
    expiresAt: new Date('2026-07-11T11:59:00.000Z'),
  });
  const active = await seedSession(sessions, 'active', USER_B);

  assert.equal((await sessions.expirePendingProposals()).length, 1);
  assert.equal((await sessions.get(USER_A, expired.id))?.status, 'failed');
  assert.equal((await sessions.get(USER_A, expired.id))?.failureReason, 'proposal_expired');
  assert.equal((await sessions.get(USER_B, active.id))?.status, 'active');
  assert.equal((await sessions.get(USER_B, active.id))?.expiresAt, null);
});

test('return proposals require a fresh future expiry', async () => {
  const sessions = service();
  const proposed = await sessions.propose({
    userId: USER_A,
    objective: 'Review recent training',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    inboundHandoff: {},
    expiresAt: new Date('2026-07-11T12:15:00.000Z'),
  });
  const active = await sessions.transition(USER_A, proposed.id, 'active');

  await assert.rejects(
    sessions.transition(USER_A, active.id, 'return_proposed', { returnHandoff: {} }),
    ProposalExpiryRequiredError,
  );
  await assert.rejects(
    sessions.transition(USER_A, active.id, 'return_proposed', {
      returnHandoff: {},
      expiresAt: NOW,
    }),
    ProposalExpiryRequiredError,
  );
  const expiresAt = new Date('2026-07-11T12:30:00.000Z');
  const returning = await sessions.transition(USER_A, active.id, 'return_proposed', {
    returnHandoff: {},
    expiresAt,
  });
  assert.deepEqual(returning.expiresAt, expiresAt);
});

test('repository updates compare the expected prior status to detect races', async () => {
  const sessions = service();
  const proposed = await seedSession(sessions, 'proposed');
  const failed = { ...proposed, status: 'failed' as const, expiresAt: null };
  await sessions.repository.update(failed, 'proposed');

  await assert.rejects(
    sessions.repository.update({ ...proposed, status: 'active', expiresAt: null }, 'proposed'),
    ConcurrentSpecialistSessionUpdateError,
  );
});

test('expiry scan cannot fail a proposal that concurrently became active', async () => {
  class ActivatingDuringExpiryRepository extends InMemorySpecialistSessionRepository {
    override async findExpiredPending(now: Date) {
      const expired = await super.findExpiredPending(now);
      const [proposal] = expired;
      if (proposal) {
        await super.update({
          ...proposal,
          status: 'active',
          activatedAt: NOW,
          expiresAt: null,
        }, 'proposed');
      }
      return expired;
    }
  }

  const sessions = new SpecialistSessionService(
    new ActivatingDuringExpiryRepository(),
    () => NOW,
    { get: () => ({ version: '1.0.0' }) },
  );
  const proposal = await sessions.propose({
    userId: USER_A,
    objective: 'Review recent training',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    inboundHandoff: {},
    expiresAt: new Date('2026-07-11T11:59:00.000Z'),
  });

  assert.deepEqual(await sessions.expirePendingProposals(), []);
  assert.equal((await sessions.get(USER_A, proposal.id))?.status, 'active');
});

test('specialist attribution maps directly to persisted message columns', () => {
  const attribution = service().messageAttribution({
    sessionId: '10000000-0000-4000-8000-000000000001',
    specialistId: 'running-coach',
    manifestVersion: '1.0.0',
    name: 'Running Coach',
    role: 'Vital Specialist',
    accentColor: '#4CC9F0',
    icon: 'figure.run',
  });

  assert.deepEqual(attribution, {
    speaker: 'specialist',
    specialist_session_id: '10000000-0000-4000-8000-000000000001',
    specialist_metadata: {
      specialistId: 'running-coach',
      manifestVersion: '1.0.0',
      name: 'Running Coach',
      role: 'Vital Specialist',
      accentColor: '#4CC9F0',
      icon: 'figure.run',
    },
  });
});

test('proposal creation rejects unknown or stale specialist manifests', async () => {
  const sessions = service();
  const input = {
    userId: USER_A,
    objective: 'Prepare for a 10K',
    inboundHandoff: {},
    expiresAt: new Date('2026-07-11T12:15:00.000Z'),
  };

  await assert.rejects(sessions.propose({
    ...input,
    manifestId: 'unknown-specialist',
    manifestVersion: '1.0.0',
  }), /Unknown specialist/);
  await assert.rejects(sessions.propose({
    ...input,
    manifestId: 'running-coach',
    manifestVersion: '0.9.0',
  }), /manifest version/);
});
