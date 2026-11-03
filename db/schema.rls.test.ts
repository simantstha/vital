import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema';

const tables = Object.entries(schema).filter(([, value]) => is(value, PgTable)) as [
  string,
  PgTable,
][];

test('every public table has row level security enabled', () => {
  assert.ok(tables.length >= 28, `expected at least 28 tables, found ${tables.length}`);
  for (const [exportName, table] of tables) {
    const config = getTableConfig(table);
    assert.equal(
      config.enableRLS,
      true,
      `table "${config.name}" (export ${exportName}) is missing .enableRLS()`,
    );
  }
});

test('RLS migration enables RLS without policies or FORCE, and guards the role revokes', () => {
  const sql = readFileSync(join(__dirname, 'migrations', '0039_absent_stick.sql'), 'utf8');

  assert.ok(!/FORCE ROW LEVEL SECURITY/i.test(sql), 'must not FORCE row level security');
  assert.ok(!/CREATE POLICY/i.test(sql), 'must not create policies');
  assert.ok(
    sql.includes("EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')") &&
      sql.includes("EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')"),
    'role-existence guard is missing',
  );
  assert.ok(sql.includes('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;'));
});
