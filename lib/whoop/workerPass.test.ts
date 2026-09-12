import assert from 'node:assert/strict';
import test from 'node:test';
import * as schema from '../../db/schema';
import { WhoopApiError, WhoopConnectionInactiveError, WhoopTokenError } from './client';
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

function makeDeps(connections: WhoopConnectionForSync[], runSyncImpl: WhoopWorkerPassDeps['runSync']): WhoopWorkerPassDeps {
  return {
    listActiveConnections: async () => connections,
    runSync: runSyncImpl,
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
  assert.equal(result.failed.length, 0);
  assert.equal(result.backpressure, false);
  assert.deepEqual(syncCalls.sort(), ['conn-1', 'conn-2']);
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
  assert.deepEqual(result.failed, []); // inactive lands in skipped, never in failed
  assert.equal(result.backpressure, false);
});

// Global backpressure: a 429 is a signal about our WHOOP quota, not about
// conn-1 specifically, so the pass must stop rather than burn the same
// exhausted quota on everyone still queued behind it.
test('runWhoopWorkerPass stops the pass on a 429 and does NOT attempt the remaining connections', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2' }), conn({ id: 'conn-3' })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => {
    syncCalls.push(target.connectionId);
    if (target.connectionId === 'conn-1') throw new WhoopApiError('rate limited', 429);
  });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(syncCalls, ['conn-1']); // never raced ahead into more 429s
  assert.equal(result.backpressure, true);
  assert.deepEqual(result.synced, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []); // a pass-level outcome, not a connection failure
});

test('runWhoopWorkerPass stops the pass on a WHOOP 5xx the same way it does on a 429', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2' }), conn({ id: 'conn-3' })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => {
    syncCalls.push(target.connectionId);
    if (target.connectionId === 'conn-1') throw new WhoopApiError('whoop is down', 503);
  });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(syncCalls, ['conn-1']);
  assert.equal(result.backpressure, true);
  assert.deepEqual(result.synced, []);
  assert.deepEqual(result.failed, []);
});

test('runWhoopWorkerPass treats a 429 surfaced from a token refresh as backpressure too', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2' })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => {
    syncCalls.push(target.connectionId);
    if (target.connectionId === 'conn-1') throw new WhoopTokenError('WHOOP token request failed (429)', 429);
  });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(syncCalls, ['conn-1']);
  assert.equal(result.backpressure, true);
});

// Regression test for the production incident this fix addresses: one WHOOP
// connection with a revoked grant (surfacing as a generic, non-inactive
// error since the revocation hadn't been marked status='error' yet) must not
// starve every other user's sync. The first of three connections throws;
// the other two must still be attempted and sync successfully.
test('runWhoopWorkerPass attempts and syncs the remaining connections after the first one throws a generic error', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2' }), conn({ id: 'conn-3' })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => {
    syncCalls.push(target.connectionId);
    if (target.connectionId === 'conn-1') throw new Error('WHOOP token request failed (400)');
  });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(syncCalls, ['conn-1', 'conn-2', 'conn-3']);
  assert.deepEqual(result.failed, ['conn-1']);
  assert.deepEqual(result.synced.sort(), ['conn-2', 'conn-3']);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.backpressure, false);
});

// The exact production shape: a dead grant surfacing as a 400 WhoopTokenError.
// A 4xx is about this connection's credentials, so it must isolate — proving
// the backpressure predicate keys on 429/5xx and not merely on the error class.
test('runWhoopWorkerPass isolates a 400 WhoopTokenError rather than treating it as backpressure', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const connections = [conn({ id: 'conn-1' }), conn({ id: 'conn-2' }), conn({ id: 'conn-3' })];
  const syncCalls: string[] = [];
  const deps = makeDeps(connections, async (target) => {
    syncCalls.push(target.connectionId);
    if (target.connectionId === 'conn-1') throw new WhoopTokenError('WHOOP token request failed (400)', 400);
  });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(syncCalls, ['conn-1', 'conn-2', 'conn-3']);
  assert.deepEqual(result.failed, ['conn-1']);
  assert.deepEqual(result.synced.sort(), ['conn-2', 'conn-3']);
  assert.equal(result.backpressure, false);
});

test('runWhoopWorkerPass is a no-op when nothing is due', async () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const deps = makeDeps([conn({ lastSyncedAt: now })], async () => { throw new Error('should not be called'); });

  const result = await runWhoopWorkerPass(now, deps);

  assert.deepEqual(result, { synced: [], skipped: [], failed: [], backpressure: false });
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
  };

  const repo = createWhoopWorkerRepository(fakeDb, schema);
  const connections = await repo.listActiveConnections();

  assert.equal(seenTable, schema.whoop_connections);
  assert.equal(seenJoinTable, schema.users);
  assert.deepEqual(connections, [{ id: 'conn-1', userId: 'user-1', timezone: 'America/Chicago', status: 'active', lastSyncedAt: null }]);
  void now;
});
