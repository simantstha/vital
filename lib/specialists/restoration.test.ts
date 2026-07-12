import assert from 'node:assert/strict';
import test from 'node:test';
import { SpecialistRegistry } from './registry';
import {
  loadCoachRestoration,
  type CoachHistoryRepository,
} from './restoration';
import type { SpecialistSessionRepository } from './sessions';

const USER = '00000000-0000-4000-8000-000000000001';
const SESSION = '10000000-0000-4000-8000-000000000001';

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
  const sessions: SpecialistSessionRepository = {
    async findOpenByUser(userId) {
      assert.equal(userId, USER);
      return {
        id: SESSION, userId: USER, objective: 'Plan a safe week', manifestId: 'running-coach',
        manifestVersion: '1.0.0', status: 'active', inboundHandoff: { summary: 'Runner' },
        returnHandoff: null, failureReason: null,
        proposedAt: new Date(), activatedAt: new Date(), returnProposedAt: null,
        completedAt: null, declinedAt: null, failedAt: null, expiresAt: null, updatedAt: new Date(),
      };
    },
    async findByUserAndId() { return null; },
    async insert() { throw new Error('not used'); },
    async update() { throw new Error('not used'); },
    async findExpiredPending() { return []; },
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
    async findOpenByUser() {
      return {
        id: SESSION, userId: USER, objective: 'Plan a safe week', manifestId: 'running-coach',
        manifestVersion: '1.0.0', status: 'return_proposed' as const,
        inboundHandoff: { summary: 'Runner' },
        returnHandoff: { outcomes: ['Week planned'] }, failureReason: null,
        proposedAt: new Date(), activatedAt: new Date(), returnProposedAt: new Date(),
        completedAt: null, declinedAt: null, failedAt: null, expiresAt: new Date(), updatedAt: new Date(),
      };
    },
  } as unknown as SpecialistSessionRepository;
  const restored = await loadCoachRestoration(USER, {
    history, sessions,
    manifests: new SpecialistRegistry({ SPECIALIST_MODEL: 'claude-opus-test' }),
  });
  assert.equal(restored.activePersona.id, 'running-coach');
  assert.equal(restored.pendingCard?.phase, 'return_proposed');
  assert.deepEqual(restored.pendingCard?.returnSummary, { outcomes: ['Week planned'] });
});
