import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAppliedMigrationHead,
  validateDatabaseUrl,
  validateMigrationJournal,
} from './ci-migrate.mjs';

const journal = {
  version: '7',
  dialect: 'postgresql',
  entries: [
    {
      idx: 0,
      version: '7',
      when: 1710000000000,
      tag: '0000_initial_schema',
      breakpoints: true,
    },
    {
      idx: 1,
      version: '7',
      when: 1710000100000,
      tag: '0001_add_profiles',
      breakpoints: true,
    },
  ],
};

test('accepts a complete PostgreSQL DATABASE_URL', () => {
  const url = validateDatabaseUrl('postgresql://user:password@db.example.com:5432/vital?sslmode=require');

  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'db.example.com');
});

test('rejects missing, malformed, and non-Postgres DATABASE_URL values', () => {
  for (const value of [
    undefined,
    '',
    'not a url',
    'postgresql:///vital',
    'postgresql://db.example.com',
    'mysql://db.example.com/vital',
  ]) {
    assert.throws(() => validateDatabaseUrl(value), /DATABASE_URL/);
  }
});

test('uses the last ordered committed journal entry as the migration head', () => {
  const head = validateMigrationJournal(journal);

  assert.deepEqual(head, {
    tag: '0001_add_profiles',
    createdAt: 1710000100000,
  });
});

test('rejects malformed migration journals before opening a database connection', () => {
  assert.throws(
    () => validateMigrationJournal({ ...journal, dialect: 'sqlite' }),
    /PostgreSQL migration journal/,
  );
  assert.throws(
    () => validateMigrationJournal({ ...journal, entries: [{ ...journal.entries[0], idx: 2 }] }),
    /ordered entries/,
  );
  assert.throws(
    () => validateMigrationJournal({ ...journal, version: undefined }),
    /format version/,
  );
  assert.throws(
    () => validateMigrationJournal({ ...journal, entries: [] }),
    /at least one entry/,
  );
});

test('requires the applied migration table head to match the committed journal head and hash', () => {
  const expectedHead = {
    tag: '0001_add_profiles',
    createdAt: 1710000100000,
    hash: 'committed-sha256',
  };

  assert.doesNotThrow(() =>
    assertAppliedMigrationHead(
      { createdAt: 1710000100000, hash: 'committed-sha256' },
      expectedHead,
    ),
  );
  assert.throws(
    () => assertAppliedMigrationHead({ createdAt: 1710000100000, hash: 'wrong-hash' }, expectedHead),
    /does not match the committed journal head/,
  );
  assert.throws(
    () => assertAppliedMigrationHead({ createdAt: 1710000000000, hash: 'committed-sha256' }, expectedHead),
    /does not match the committed journal head/,
  );
});
