import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  USER_SCOPED_TABLES_IN_DELETE_ORDER,
  deleteUserData,
  removeLegacyMemoryDir,
} from './accountDeletion';

function isPgTable(v: unknown): v is PgTable {
  try { getTableConfig(v as PgTable); return true; } catch { return false; }
}

function referencesUsers(table: PgTable): boolean {
  const cfg = getTableConfig(table);
  if (cfg.columns.some((c) => c.name === 'user_id')) return true;
  return cfg.foreignKeys.some((fk) => fk.reference().foreignTable === schema.users);
}

test('every user-scoped table in the schema is covered by account deletion', () => {
  const expected = Object.values(schema)
    .filter(isPgTable)
    .filter((t) => t !== schema.users && referencesUsers(t))
    .map((t) => getTableName(t))
    .sort();
  const covered = USER_SCOPED_TABLES_IN_DELETE_ORDER.map((t) => getTableName(t)).sort();
  assert.deepEqual(covered, expected);
});

test('delete order respects foreign keys (children before parents)', () => {
  const order: string[] = USER_SCOPED_TABLES_IN_DELETE_ORDER.map((t) => getTableName(t));
  for (const table of USER_SCOPED_TABLES_IN_DELETE_ORDER) {
    const cfg = getTableConfig(table);
    for (const fk of cfg.foreignKeys) {
      const parent = getTableName(fk.reference().foreignTable);
      if (parent === cfg.name || parent === 'users') continue;
      const parentIdx = order.indexOf(parent);
      if (parentIdx === -1) continue;
      assert.ok(order.indexOf(cfg.name) < parentIdx, `${cfg.name} must be deleted before ${parent}`);
    }
  }
});

test('deleteUserData deletes every table then users inside one transaction', async () => {
  const deleted: unknown[] = [];
  let txCount = 0;
  const fake = {
    transaction: async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
      txCount++;
      const tx = { delete: (t: unknown) => ({ where: async () => { deleted.push(t); } }) };
      return fn(tx as never);
    },
  };
  await deleteUserData(fake as never, '00000000-0000-0000-0000-000000000001');
  assert.equal(txCount, 1);
  assert.equal(deleted.length, USER_SCOPED_TABLES_IN_DELETE_ORDER.length + 1);
  assert.equal(deleted[deleted.length - 1], schema.users);
});

test('removeLegacyMemoryDir removes the dir and ignores a missing one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vital-del-'));
  const id = '00000000-0000-0000-0000-000000000002';
  const dir = path.join(root, '.vital-memory', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'x.md'), 'x');
  removeLegacyMemoryDir(id, root);
  assert.equal(fs.existsSync(dir), false);
  removeLegacyMemoryDir(id, root); // no throw
  fs.rmSync(root, { recursive: true, force: true });
});
