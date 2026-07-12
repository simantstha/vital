import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcilePushDeviceRegistration,
  type PushDeviceRow,
  type PushDeviceTransaction,
} from './pushDeviceReconciliation';

class MemoryTransaction implements PushDeviceTransaction {
  constructor(public rows: PushDeviceRow[]) {}

  async findByInstallationId(installationId: string) {
    return this.rows.find((row) => row.installationId === installationId) ?? null;
  }

  async findByToken(token: string, environment: string) {
    return this.rows.find((row) => row.token === token && row.environment === environment) ?? null;
  }

  async retire(row: PushDeviceRow, retiredToken: string, now: Date) {
    Object.assign(row, { token: retiredToken, invalidatedAt: now });
  }

  async update(row: PushDeviceRow, token: string, environment: 'sandbox' | 'production', now: Date) {
    Object.assign(row, { token, environment, invalidatedAt: null, updatedAt: now });
  }

  async insert(userId: string, installationId: string, token: string, environment: 'sandbox' | 'production', now: Date) {
    this.rows.push({ id: `device-${this.rows.length + 1}`, userId, installationId, token, environment, invalidatedAt: null, updatedAt: now });
  }
}

const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
const now = new Date('2026-07-12T12:00:00Z');

function row(overrides: Partial<PushDeviceRow> = {}): PushDeviceRow {
  return {
    id: 'device-1', userId: 'user-a', installationId: '11111111-1111-4111-8111-111111111111',
    token: tokenA, environment: 'sandbox', invalidatedAt: null, updatedAt: new Date(0), ...overrides,
  };
}

test('cross-user installation registration is rejected without mutation', async () => {
  const original = row();
  const tx = new MemoryTransaction([original]);
  const before = structuredClone(tx.rows);
  const result = await reconcilePushDeviceRegistration(tx, 'user-b', {
    installationId: original.installationId, token: tokenB, environment: 'sandbox',
  }, now);
  assert.equal(result, 'conflict');
  assert.deepEqual(tx.rows, before);
});

test('cross-user token collision is rejected and preserves referenced device history', async () => {
  const referenced = row();
  const tx = new MemoryTransaction([referenced]);
  const before = structuredClone(tx.rows);
  const result = await reconcilePushDeviceRegistration(tx, 'user-b', {
    installationId: '22222222-2222-4222-8222-222222222222', token: tokenA, environment: 'sandbox',
  }, now);
  assert.equal(result, 'conflict');
  assert.deepEqual(tx.rows, before);
  assert.equal(tx.rows[0], referenced);
});

test('same-user token refresh retires the old row without deleting audit identity', async () => {
  const referenced = row();
  const tx = new MemoryTransaction([referenced]);
  const result = await reconcilePushDeviceRegistration(tx, 'user-a', {
    installationId: '22222222-2222-4222-8222-222222222222', token: tokenA, environment: 'sandbox',
  }, now);
  assert.equal(result, 'registered');
  assert.equal(tx.rows.length, 2);
  assert.equal(referenced.id, 'device-1');
  assert.equal(referenced.invalidatedAt, now);
  assert.match(referenced.token, /^retired:device-1:/);
  assert.equal(tx.rows[1].token, tokenA);
});

test('same-user installation refresh is idempotent and reactivates the row', async () => {
  const existing = row({ invalidatedAt: new Date(0) });
  const tx = new MemoryTransaction([existing]);
  const registration = { installationId: existing.installationId, token: tokenB, environment: 'production' as const };
  assert.equal(await reconcilePushDeviceRegistration(tx, 'user-a', registration, now), 'registered');
  assert.equal(await reconcilePushDeviceRegistration(tx, 'user-a', registration, now), 'registered');
  assert.equal(tx.rows.length, 1);
  assert.equal(existing.token, tokenB);
  assert.equal(existing.invalidatedAt, null);
});
