import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SpecialistMessageRepository,
  type SpecialistMessagePersistence,
} from './messageRepository';

test('specialist message repository round-trips through Drizzle row keys', async () => {
  let stored: Record<string, unknown> | null = null;
  const persistence: SpecialistMessagePersistence = {
    async insert(values) {
      stored = { id: '20000000-0000-4000-8000-000000000001', ...values };
      return stored as never;
    },
    async findByUserAndId(userId, id) {
      return stored?.user_id === userId && stored?.id === id ? stored as never : null;
    },
  };
  const repository = new SpecialistMessageRepository(persistence);
  const timestamp = new Date('2026-07-11T12:00:00.000Z');

  const saved = await repository.insert({
    userId: '00000000-0000-4000-8000-000000000001',
    timestamp,
    content: 'Your recovery trend supports an easy run today.',
    attribution: {
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
    },
  });

  assert.ok(stored);
  const rawRow = stored as unknown as Record<string, unknown>;
  assert.equal(rawRow.user_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(rawRow.specialist_session_id, '10000000-0000-4000-8000-000000000001');
  assert.equal(rawRow.specialistSessionId, undefined);
  assert.deepEqual(
    await repository.findByUserAndId(saved.userId, saved.id),
    saved,
  );
  assert.equal(saved.attribution.specialist_metadata.accentColor, '#4CC9F0');
});
