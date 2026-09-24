import assert from 'node:assert/strict';
import test from 'node:test';
import { SpecialistRegistry } from './registry';
import {
  attachMealReceipts,
  compareRestoredMessages,
  loadCoachRestoration,
  type CoachHistoryRepository,
  type MealLoggedEventRow,
  type RestoredCoachMessage,
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

// ── attachMealReceipts: turn-window derivation ─────────────────────────────

function restoredMessage(opts: { role: string; timestamp: Date }): RestoredCoachMessage {
  return {
    id: `msg-${opts.timestamp.toISOString()}`,
    role: opts.role,
    speaker: opts.role === 'user' ? 'user' : 'coach',
    content: 'hi',
    timestamp: opts.timestamp,
    specialistSessionId: null,
    specialistMetadata: null,
  };
}

function mealEvent(id: string, timestamp: Date, name = 'Meal'): MealLoggedEventRow {
  return { id, timestamp, payload: { name, kcal: 300, p: 20, c: 30, f: 10 } };
}

test('attachMealReceipts assigns a meal to the assistant message whose turn it was logged in', () => {
  const messages: RestoredCoachMessage[] = [
    restoredMessage({ role: 'user', timestamp: new Date('2026-07-11T12:00:00Z') }),
    restoredMessage({ role: 'assistant', timestamp: new Date('2026-07-11T12:00:05Z') }),
    restoredMessage({ role: 'user', timestamp: new Date('2026-07-11T12:01:00Z') }),
    restoredMessage({ role: 'assistant', timestamp: new Date('2026-07-11T12:01:05Z') }),
  ];
  // Logged between the second user message and the second assistant reply —
  // must attach to the SECOND assistant message, not the first.
  const events = [mealEvent('evt-1', new Date('2026-07-11T12:01:02Z'), 'Oats')];

  const result = attachMealReceipts(messages, events);

  assert.equal(result[1].mealReceipts, undefined);
  assert.deepEqual(result[3].mealReceipts, [{ id: 'evt-1', name: 'Oats', kcal: 300, p: 20, c: 30, f: 10 }]);
});

test('attachMealReceipts attaches nothing when no event falls inside any turn window', () => {
  const messages: RestoredCoachMessage[] = [
    restoredMessage({ role: 'user', timestamp: new Date('2026-07-11T12:00:00Z') }),
    restoredMessage({ role: 'assistant', timestamp: new Date('2026-07-11T12:00:05Z') }),
  ];
  const result = attachMealReceipts(messages, []);
  assert.equal(result[1].mealReceipts, undefined);
  // Additive: an untouched message is returned as the SAME object (no
  // mealReceipts key added) when there are no events to attach.
  assert.equal(result[1], messages[1]);
});

test('attachMealReceipts drops a meal_logged event for a deleted meal (simply absent from `events`)', () => {
  // A hard-deleted meal never appears in the `events` query result passed
  // in, so it produces no receipt at all — "no card", the simpler of the
  // two honest options the brief allows.
  const messages: RestoredCoachMessage[] = [
    restoredMessage({ role: 'user', timestamp: new Date('2026-07-11T12:00:00Z') }),
    restoredMessage({ role: 'assistant', timestamp: new Date('2026-07-11T12:00:05Z') }),
  ];
  const result = attachMealReceipts(messages, []);
  assert.equal(result[1].mealReceipts, undefined);
});

test('attachMealReceipts can attach multiple meals logged in the same turn', () => {
  const messages: RestoredCoachMessage[] = [
    restoredMessage({ role: 'user', timestamp: new Date('2026-07-11T12:00:00Z') }),
    restoredMessage({ role: 'assistant', timestamp: new Date('2026-07-11T12:00:10Z') }),
  ];
  const events = [
    mealEvent('evt-1', new Date('2026-07-11T12:00:02Z'), 'Eggs'),
    mealEvent('evt-2', new Date('2026-07-11T12:00:04Z'), 'Toast'),
  ];
  const result = attachMealReceipts(messages, events);
  assert.deepEqual(result[1].mealReceipts?.map((r) => r.id), ['evt-1', 'evt-2']);
});
