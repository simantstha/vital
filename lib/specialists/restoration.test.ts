import assert from 'node:assert/strict';
import test from 'node:test';
import { SpecialistRegistry } from './registry';
import {
  compareRestoredMessages,
  loadCoachRestoration,
  type CoachHistoryRepository,
} from './restoration';
import {
  InMemorySpecialistSessionRepository,
  SpecialistSessionService,
} from './sessions';

const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '10000000-0000-4000-8000-000000000001';

test('restored messages use ID as a deterministic timestamp tiebreaker', () => {
  const timestamp = new Date('2026-07-11T12:00:00Z');
  const base = {
    role: 'assistant', speaker: 'coach', content: 'same time', timestamp,
    specialistSessionId: null, specialistMetadata: null,
  };
  const messages = [
    { ...base, id: '00000000-0000-4000-8000-000000000002' },
    { ...base, id: '00000000-0000-4000-8000-000000000001' },
  ].sort(compareRestoredMessages);
  assert.deepEqual(messages.map((message) => message.id), [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ]);
});

test('restoration requests latest 50 messages and returns active specialist identity', async () => {
  let requestedLimit = 0;
  const history: CoachHistoryRepository = {
    async latest(userId, limit) {
      assert.equal(userId, USER);
      requestedLimit = limit;
      return [{
        id: '20000000-0000-4000-8000-000000000001',
        role: 'assistant',
        speaker: 'specialist',
        content: 'Keep the first run easy.',
        timestamp: new Date('2026-07-11T12:05:00Z'),
        specialistSessionId: SESSION,
        specialistMetadata: {
          specialistId: 'running-coach', manifestVersion: '1.0.0', name: 'Running Coach',
          role: 'Vital Specialist', accentColor: '#4CC9F0', icon: 'figure.run',
        },
      }];
    },
  };
  const sessions = {
    async findOpen(userId: string) {
      assert.equal(userId, USER);
      return {
        id: SESSION, userId: USER, objective: 'Plan a safe week', manifestId: 'running-coach',
        manifestVersion: '1.0.0', status: 'active' as const, inboundHandoff: { summary: 'Runner' },
        cardOccurrenceId: '30000000-0000-4000-8000-000000000001',
        returnHandoff: null, failureReason: null,
        proposedAt: new Date(), activatedAt: new Date(), returnProposedAt: null,
        completedAt: null, declinedAt: null, failedAt: null, expiresAt: null, updatedAt: new Date(),
      };
    },
    async disableOpen() { return null; },
  };

  const restored = await loadCoachRestoration(USER, {
    history,
    sessions,
    manifests: new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' }),
  });
  assert.equal(requestedLimit, 50);
  assert.equal(restored.activePersona.id, 'running-coach');
  assert.equal(restored.activePersona.sessionId, SESSION);
  assert.equal(restored.pendingCard, null);
  assert.equal(restored.messages[0].specialistMetadata?.accentColor, '#4CC9F0');
});

test('restoration exposes a pending return card without switching back to Vital', async () => {
  const history: CoachHistoryRepository = { async latest() { return []; } };
  const sessions = {
    async findOpen() {
      return {
        id: SESSION, userId: USER, objective: 'Plan a safe week', manifestId: 'running-coach',
        manifestVersion: '1.0.0', status: 'return_proposed' as const,
        cardOccurrenceId: '30000000-0000-4000-8000-000000000001',
        inboundHandoff: { summary: 'Runner' },
        returnHandoff: { outcomes: ['Week planned'] }, failureReason: null,
        proposedAt: new Date(), activatedAt: new Date(), returnProposedAt: new Date(),
        completedAt: null, declinedAt: null, failedAt: null, expiresAt: new Date(), updatedAt: new Date(),
      };
    },
    async disableOpen() { return null; },
  };
  const restored = await loadCoachRestoration(USER, {
    history, sessions,
    manifests: new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' }),
  });
  assert.equal(restored.activePersona.id, 'running-coach');
  assert.equal(restored.pendingCard?.phase, 'return_proposed');
  assert.deepEqual(restored.pendingCard?.returnSummary, { outcomes: ['Week planned'] });
});

test('restoration reconciles an expired return proposal back to the specialist', async () => {
  const manifests = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' });
  const repository = new InMemorySpecialistSessionRepository();
  const sessions = new SpecialistSessionService(
    repository,
    () => new Date('2026-07-11T12:00:00Z'),
    manifests,
  );
  await repository.insert({
    id: SESSION,
    userId: USER,
    objective: 'Plan a safe week',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    status: 'return_proposed',
    cardOccurrenceId: '30000000-0000-4000-8000-000000000001',
    inboundHandoff: { summary: 'Runner' },
    returnHandoff: { outcomes: ['Week planned'] },
    failureReason: null,
    proposedAt: new Date('2026-07-11T11:00:00Z'),
    activatedAt: new Date('2026-07-11T11:01:00Z'),
    returnProposedAt: new Date('2026-07-11T11:30:00Z'),
    completedAt: null,
    declinedAt: null,
    failedAt: null,
    expiresAt: new Date('2026-07-11T11:45:00Z'),
    updatedAt: new Date('2026-07-11T11:30:00Z'),
  });

  const restored = await loadCoachRestoration(USER, {
    history: { async latest() { return []; } },
    sessions,
    manifests,
  });
  assert.equal(restored.activePersona.id, 'running-coach');
  assert.equal(restored.pendingCard, null);
  assert.equal((await sessions.get(USER, SESSION))?.status, 'active');
});

test('disabled restoration rolls an active specialist back to authoritative Vital', async () => {
  const manifests = new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' });
  const sessions = new SpecialistSessionService(
    new InMemorySpecialistSessionRepository(),
    () => new Date('2026-07-11T12:00:00Z'),
    manifests,
  );
  const proposed = await sessions.propose({
    userId: USER,
    objective: 'Plan',
    manifestId: 'running-coach',
    manifestVersion: '1.0.0',
    inboundHandoff: {},
    expiresAt: new Date('2026-07-11T12:15:00Z'),
  });
  await sessions.transition(USER, proposed.id, 'active');

  const restored = await loadCoachRestoration(USER, {
    history: { async latest() { return []; } },
    sessions,
    manifests,
  }, false);
  assert.equal(restored.activePersona.id, 'vital');
  assert.equal(restored.pendingCard, null);
  assert.equal((await sessions.get(USER, proposed.id))?.failureReason, 'specialists_disabled');
});
