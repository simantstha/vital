import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { messages, specialist_sessions } from './schema';

test('message storage requires explicit, role-consistent speaker attribution', () => {
  const config = getTableConfig(messages);
  const speaker = config.columns.find((column) => column.name === 'speaker');

  assert.ok(speaker?.notNull);
  assert.equal(speaker.default, undefined);
  assert.ok(config.checks.some((check) => check.name === 'messages_role_speaker_check'));
  assert.ok(config.checks.some((check) => check.name === 'messages_specialist_metadata_check'));
});

test('session schema enforces lifecycle, proposal expiry, and one open session', () => {
  const config = getTableConfig(specialist_sessions);

  assert.ok(config.checks.some((check) => check.name === 'specialist_sessions_status_check'));
  assert.ok(config.checks.some((check) => check.name === 'specialist_sessions_expiry_check'));
  const openIndex = config.indexes.find(
    (index) => index.config.name === 'specialist_sessions_one_open_per_user_idx',
  );
  assert.ok(openIndex?.config.unique);
  assert.ok(openIndex.config.where);
});
