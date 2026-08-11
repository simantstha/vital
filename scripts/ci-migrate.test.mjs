import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  assertAppliedMigrationHead,
  assertCommittedLedgerPrefix,
  assertLegacySchemaMatches,
  buildLegacyStampingPlan,
  classifyLegacyLedger,
  diffCanonicalSchemas,
  loadCommittedMigrationState,
  normalizeCatalogSchema,
  normalizeSnapshotSchema,
  normalizeSqlExpression,
  performLegacyAdoption,
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

const legacyArtifacts = Array.from({ length: 19 }, (_, idx) => ({
  idx,
  tag: idx === 16 ? '0016_famous_sleepwalker' : `${String(idx).padStart(4, '0')}_migration`,
  createdAt: 1710000000000 + idx,
  hash: `hash-${idx}`,
}));

function ledgerThrough(index) {
  return legacyArtifacts.slice(0, index + 1).map((artifact) => ({
    createdAt: artifact.createdAt,
    hash: artifact.hash,
  }));
}

const legacySnapshot = {
  dialect: 'postgresql',
  tables: {
    'public.users': {
      name: 'users',
      schema: '',
      columns: {
        id: {
          name: 'id',
          type: 'uuid',
          primaryKey: true,
          notNull: true,
          default: 'gen_random_uuid()',
        },
        status: {
          name: 'status',
          type: 'text',
          primaryKey: false,
          notNull: true,
          default: "'active'",
        },
      },
      indexes: {
        users_status_idx: {
          name: 'users_status_idx',
          columns: [{ expression: 'status', isExpression: false, asc: true, nulls: 'last' }],
          isUnique: false,
          method: 'btree',
          where: '"users"."status" in (\'active\', \'paused\')',
        },
      },
      foreignKeys: {},
      compositePrimaryKeys: {},
      uniqueConstraints: {},
      checkConstraints: {
        users_status_check: {
          name: 'users_status_check',
          value: '"users"."status" in (\'active\', \'paused\')',
        },
      },
      policies: {},
      isRLSEnabled: false,
    },
  },
  schemas: {},
  enums: {},
  sequences: {},
  roles: {},
  policies: {},
  views: {},
};

const matchingCatalog = {
  tables: [{ table_name: 'users', rls_enabled: false }],
  columns: [
    {
      table_name: 'users',
      column_name: 'status',
      data_type: 'text',
      not_null: true,
      default_expr: "'active'::text",
    },
    {
      table_name: 'users',
      column_name: 'id',
      data_type: 'uuid',
      not_null: true,
      default_expr: 'gen_random_uuid()',
    },
  ],
  constraints: [
    {
      table_name: 'users',
      constraint_name: 'users_status_check',
      kind: 'check',
      columns: [],
      expression: "(status = ANY (ARRAY['active'::text, 'paused'::text]))",
    },
    {
      table_name: 'users',
      constraint_name: 'users_pkey',
      kind: 'primaryKey',
      columns: ['id'],
    },
  ],
  indexes: [
    {
      table_name: 'users',
      index_name: 'users_status_idx',
      unique: false,
      method: 'btree',
      columns: [{ expression: 'status', asc: true, nulls: 'last' }],
      predicate: "(status = ANY (ARRAY['active'::text, 'paused'::text]))",
    },
  ],
  policies: [],
  extra_objects: [],
  custom_types: [],
};

test('normalizes snapshot and catalog schemas to the same deterministic representation', () => {
  const expected = normalizeSnapshotSchema(legacySnapshot);
  const actual = normalizeCatalogSchema(matchingCatalog);

  assert.deepEqual(actual, expected);
  assert.deepEqual(diffCanonicalSchemas(expected, actual), []);
});

test('normalizes PostgreSQL check-expression rewrites without losing boolean grouping', () => {
  const snapshotExpression =
    '(("messages"."role" = \'user\' and "messages"."speaker" = \'user\') or ("messages"."role" = \'assistant\' and "messages"."speaker" in (\'coach\', \'specialist\')))';
  const catalogExpression =
    "(((role = 'user'::text) AND (speaker = 'user'::text)) OR ((role = 'assistant'::text) AND (speaker = ANY (ARRAY['coach'::text, 'specialist'::text]))))";

  assert.equal(normalizeSqlExpression(catalogExpression), normalizeSqlExpression(snapshotExpression));
});

test('normalizes PostgreSQL BETWEEN check rewrites', () => {
  assert.equal(
    normalizeSqlExpression('"notification_preferences"."morning_brief_time_minutes" between 0 and 1439'),
    normalizeSqlExpression('(morning_brief_time_minutes >= 0) AND (morning_brief_time_minutes <= 1439)'),
  );
});

test('normalization preserves case inside default string literals', () => {
  assert.notEqual(normalizeSqlExpression("'UTC'::text"), normalizeSqlExpression("'utc'::text"));
});

test('schema diff reports missing, differing, and unsafe extra app objects', () => {
  const expected = normalizeSnapshotSchema(legacySnapshot);
  const actual = normalizeCatalogSchema({
    ...matchingCatalog,
    columns: matchingCatalog.columns.filter((column) => column.column_name !== 'status'),
    extra_objects: [{ name: 'legacy_view', kind: 'view' }],
  });

  const differences = diffCanonicalSchemas(expected, actual);
  assert.ok(differences.some((difference) => difference.includes('status')));
  assert.ok(differences.some((difference) => difference.includes('legacy_view')));
  assert.throws(() => assertLegacySchemaMatches(expected, actual), /does not exactly match committed 0016 snapshot/);
});

test('schema diff rejects invalid indexes and unexpected included index columns', () => {
  const expected = normalizeSnapshotSchema(legacySnapshot);
  const actual = normalizeCatalogSchema({
    ...matchingCatalog,
    indexes: matchingCatalog.indexes.map((index) => ({
      ...index,
      valid: false,
      columns: [{ ...index.columns[0], included: true }],
    })),
  });

  const differences = diffCanonicalSchemas(expected, actual);
  assert.ok(differences.some((difference) => difference.includes('valid')));
  assert.ok(differences.some((difference) => difference.includes('included')));
});

test('only the exact known 0000 ledger is eligible for legacy adoption', () => {
  const exact0000 = ledgerThrough(0);

  assert.equal(classifyLegacyLedger([], legacyArtifacts), 'fresh');
  assert.equal(classifyLegacyLedger(exact0000, legacyArtifacts), 'adopt');
  assert.equal(classifyLegacyLedger(ledgerThrough(16), legacyArtifacts), 'current');
  assert.equal(classifyLegacyLedger(ledgerThrough(18), legacyArtifacts), 'current');
  assert.throws(
    () => classifyLegacyLedger(ledgerThrough(4), legacyArtifacts),
    /unexpected stale migration ledger/,
  );
});

test('ledger classification rejects every non-contiguous or mismatched state', () => {
  const missingFirst = ledgerThrough(16).slice(1);
  const missingInterior = ledgerThrough(16).filter((_, index) => index !== 8);
  const outOfOrder = ledgerThrough(16);
  [outOfOrder[7], outOfOrder[8]] = [outOfOrder[8], outOfOrder[7]];
  const duplicate = ledgerThrough(16);
  duplicate.splice(8, 0, { ...duplicate[7] });
  const unknown = ledgerThrough(16);
  unknown[9] = { createdAt: 123, hash: 'unknown' };
  const hashMismatch = ledgerThrough(16);
  hashMismatch[9] = { ...hashMismatch[9], hash: 'wrong-hash' };
  const single0016 = [{ createdAt: legacyArtifacts[16].createdAt, hash: legacyArtifacts[16].hash }];

  for (const ledger of [
    missingFirst,
    missingInterior,
    outOfOrder,
    duplicate,
    unknown,
    hashMismatch,
    single0016,
  ]) {
    assert.throws(() => classifyLegacyLedger(ledger, legacyArtifacts), /contiguous committed prefix/);
  }
});

test('full-ledger verification requires the exact committed journal prefix through its head', () => {
  assert.doesNotThrow(() => assertCommittedLedgerPrefix(ledgerThrough(18), legacyArtifacts, 18));
  assert.throws(
    () => assertCommittedLedgerPrefix(ledgerThrough(17), legacyArtifacts, 18),
    /contiguous committed prefix/,
  );
  assert.throws(
    () => assertCommittedLedgerPrefix(ledgerThrough(18).reverse(), legacyArtifacts, 18),
    /contiguous committed prefix/,
  );
});

test('legacy stamping plan is exactly committed migrations 0001 through 0016', () => {
  const exact0000 = [{ createdAt: legacyArtifacts[0].createdAt, hash: legacyArtifacts[0].hash }];
  const plan = buildLegacyStampingPlan(exact0000, legacyArtifacts);

  assert.deepEqual(plan, legacyArtifacts.slice(1, 17));
  assert.equal(plan[0].idx, 1);
  assert.equal(plan.at(-1).tag, '0016_famous_sleepwalker');
});

test('legacy stamping refuses a changed target or mismatched ledger', () => {
  const exact0000 = ledgerThrough(0);
  const wrongTarget = legacyArtifacts.map((artifact) => ({ ...artifact }));
  wrongTarget[16].tag = '0016_unexpected_target';

  assert.throws(() => buildLegacyStampingPlan(exact0000, wrongTarget), /legacy target/);
  assert.throws(
    () => buildLegacyStampingPlan(ledgerThrough(2), legacyArtifacts),
    /unexpected stale migration ledger/,
  );
});

test('legacy adoption locks, rechecks, stamps exactly the plan, and verifies the adopted head', async () => {
  const ledger = [{ createdAt: legacyArtifacts[0].createdAt, hash: legacyArtifacts[0].hash }];
  const stamped = [];
  const events = [];
  let ledgerReads = 0;

  const result = await performLegacyAdoption({
    artifacts: legacyArtifacts,
    expectedSchema: normalizeSnapshotSchema(legacySnapshot),
    withTransaction: async (callback) => {
      events.push('transaction');
      return callback({});
    },
    acquireLock: async () => events.push('lock'),
    readLedger: async () => {
      ledgerReads += 1;
      return ledger.map((row) => ({ ...row }));
    },
    readCatalog: async () => matchingCatalog,
    insertMigration: async (_transaction, migration) => {
      stamped.push(migration);
      ledger.push({ createdAt: migration.createdAt, hash: migration.hash });
    },
  });

  assert.equal(result, 'adopted');
  assert.deepEqual(events, ['transaction', 'lock']);
  assert.equal(ledgerReads, 3);
  assert.deepEqual(stamped, legacyArtifacts.slice(1, 17));
});

test('legacy adoption never stamps when the live schema differs', async () => {
  const ledger = [{ createdAt: legacyArtifacts[0].createdAt, hash: legacyArtifacts[0].hash }];
  let insertCount = 0;

  await assert.rejects(
    performLegacyAdoption({
      artifacts: legacyArtifacts,
      expectedSchema: normalizeSnapshotSchema(legacySnapshot),
      withTransaction: async (callback) => callback({}),
      acquireLock: async () => {},
      readLedger: async () => ledger,
      readCatalog: async () => ({ ...matchingCatalog, columns: [] }),
      insertMigration: async () => {
        insertCount += 1;
      },
    }),
    /does not exactly match committed 0016 snapshot/,
  );
  assert.equal(insertCount, 0);
});

test('loads the exact committed 0016 legacy snapshot and every migration SQL hash', async () => {
  const state = await loadCommittedMigrationState(path.resolve('db/migrations'));

  assert.equal(state.artifacts[16].tag, '0016_famous_sleepwalker');
  assert.match(state.artifacts[16].hash, /^[a-f0-9]{64}$/);
  assert.equal(state.expectedLegacySchema.tables.length, 21);
  assert.equal(state.expectedHead.tag, '0020_bent_radioactive_man');
});
