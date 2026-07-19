import assert from 'node:assert/strict';
import test from 'node:test';
import * as schema from '../../db/schema';
import { WhoopApiError, WhoopConnectionInactiveError } from './client';
import {
  createWhoopWorkerRepository,
  runWhoopWorkerPass,
  selectDueWhoopConnections,
  type WhoopConnectionForSync,
  type WhoopWorkerPassDeps,
} from './workerPass';

const HOUR_MS = 60 * 60_000;

function conn(overrides: Partial<WhoopConnectionForSync> = {}): WhoopConnectionForSync {
  return { id: 'conn-1', userId: 'user-1', timezone: 'UTC', status: 'active', lastSyncedAt: null, ...overrides };
}

// ─── selectDueWhoopConnections (pure) ────────────────────────────────────────

test('selectDueWhoopConnections includes a connection that has never synced', () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const due = selectDueWhoopConnections([conn({ lastSyncedAt: null })], now);
  assert.equal(due.length, 1);
});

test('selectDueWhoopConnections includes a connection last synced more than an hour ago', () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const due = selectDueWhoopConnections([conn({ lastSyncedAt: new Date(now.getTime() - HOUR_MS - 1) })], now);
  assert.equal(due.length, 1);
});

test('selectDueWhoopConnections excludes a connection synced less than an hour ago', () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const due = selectDueWhoopConnections([conn({ lastSyncedAt: new Date(now.getTime() - HOUR_MS + 1) })], now);
  assert.equal(due.length, 0);
});

test('selectDueWhoopConnections excludes a non-active connection regardless of last_synced_at', () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const due = selectDueWhoopConnections([conn({ status: 'error', lastSyncedAt: null })], now);
  assert.equal(due.length, 0);
});

test('selectDueWhoopConnections treats exactly one hour as due (>=)', () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const due = selectDueWhoopConnections([conn({ lastSyncedAt: new Date(now.getTime() - HOUR_MS) })], now);
  assert.equal(due.length, 1);
});

// ─── runWhoopWorkerPass (orchestration, injected deps) ───────────────────────

function makeDeps(connections: WhoopConnectionForSync[], runSyncImpl: WhoopWorkerPassDeps['runSync']): WhoopWorkerPassDeps & { markedSynced: Array<{ connectionId: string; syncedAt: Date }> } {
  const markedSynced: Array<{ connectionId: string; syncedAt: Date }> = [];
  return {
    listActiveConnections: async () => connections,
    runSync: runSyncImpl,
    markSynced: async (connectionId, syncedAt) => { markedSynced.push({ connectionId, syncedAt }); },
    markedSynced,
  };
}

test('runWhoopWorkerPass syncs every due connection one at a time and marks each synced', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2', lastSyncedAt: new Date(now.getTime() - 2 * HOUR_MS) })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => { syncCalls.push(target.connectionId); });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(result.synced.sort(), ['conn-1', 'conn-2']);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.aborted, false);
  assert.deepEqual(syncCalls.sort(), ['conn-1', 'conn-2']);
  assert.equal(deps.markedSynced.length, 2);
});

test('runWhoopWorkerPass passes a trailing 48h window ending at `now`', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  let seenWindow: { windowStart: Date; windowEnd: Date } | undefined;
  const deps = makeDeps([conn()], async (_target, windowStart, windowEnd) => { seenWindow = { windowStart, windowEnd }; });

  await runWhoopWorkerPass(now, deps);

  assert.ok(seenWindow);
  assert.equal(seenWindow!.windowEnd.getTime(), now.getTime());
  assert.equal(now.getTime() - seenWindow!.windowStart.getTime(), 48 * HOUR_MS);
});

test('runWhoopWorkerPass skips a WhoopConnectionInactiveError and continues to the next connection', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2' })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => {
    syncCalls.push(target.connectionId);
    if (target.connectionId === 'conn-1') throw new WhoopConnectionInactiveError('conn-1', 'error');
  });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(syncCalls, ['conn-1', 'conn-2']);
  assert.deepEqual(result.skipped, ['conn-1']);
  assert.deepEqual(result.synced, ['conn-2']);
  assert.equal(result.aborted, false);
});

test('runWhoopWorkerPass aborts the whole pass on a WhoopApiError (e.g. 429) and does not process later connections', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2' })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => {
    syncCalls.push(target.connectionId);
    if (target.connectionId === 'conn-1') throw new WhoopApiError('rate limited', 429);
  });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(syncCalls, ['conn-1']); // never reached conn-2
  assert.equal(result.aborted, true);
  assert.deepEqual(result.synced, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(deps.markedSynced.length, 0);
});

test('runWhoopWorkerPass aborts on an unexpected error too (not just WhoopApiError)', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const deps = makeDeps([conn()], async () => { throw new Error('db exploded'); });

  const result = await runWhoopWorkerPass(now, deps);

  assert.equal(result.aborted, true);
  assert.deepEqual(result.synced, []);
});

test('runWhoopWorkerPass is a no-op when nothing is due', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const deps = makeDeps([conn({ lastSyncedAt: now })], async () => { throw new Error('should not be called'); });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(result, { synced: [], skipped: [], aborted: false });
});

// ─── createWhoopWorkerRepository (Drizzle plumbing) ──────────────────────────

test('createWhoopWorkerRepository queries active connections due for sync via an inner join on users', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const row = { id: 'conn-1', user_id: 'user-1', timezone: 'America/Chicago', status: 'active', last_synced_at: null };

  let seenTable: unknown;
  let seenJoinTable: unknown;
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        seenTable = table;
        return {
          innerJoin: (joinTable: unknown) => {
            seenJoinTable = joinTable;
            return { where: async () => [row] };
          },
        };
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };

  const repo = createWhoopWorkerRepository(fakeDb, schema);
  const connections = await repo.listActiveConnections();

  assert.equal(seenTable, schema.whoop_connections);
  assert.equal(seenJoinTable, schema.users);
  assert.deepEqual(connections, [{ id: 'conn-1', userId: 'user-1', timezone: 'America/Chicago', status: 'active', lastSyncedAt: null }]);
  void now;
});

test('createWhoopWorkerRepository.markSynced updates last_synced_at for the given connection', async () => {
  const updateCalls: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const fakeDb = {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [] }) }) }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updateCalls.push({ table, set });
        return { where: async () => {} };
      },
    }),
  };

  const repo = createWhoopWorkerRepository(fakeDb, schema);
  const syncedAt = new Date('2026-07-19T12:00:00.000Z');
  await repo.markSynced('conn-1', syncedAt);

  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].table, schema.whoop_connections);
  assert.equal(updateCalls[0].set.last_synced_at, syncedAt);
});
