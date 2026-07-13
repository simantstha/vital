import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRecoveryCounts,
  parseRecoveryIds,
  recoverProactiveAnalysisJobs,
  type RecoveryKind,
  type RecoveryRow,
  type RecoveryStore,
  type RecoveryTransaction,
} from './proactiveAnalysisRecovery';

const ids = Array.from(
  { length: 9 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);
const argv = (values: string[]): string[] => values.flatMap((id) => ['--id', id]);
const now = new Date('2026-07-13T12:00:00.000Z');

interface FakeRow extends RecoveryRow {
  retryCount: number;
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
  notificationState: string;
  notificationRetryCount: number;
  notificationNextAttemptAt: Date;
  notificationLeaseToken: string | null;
  notificationLeaseExpiresAt: Date | null;
  notificationSentAt: Date | null;
  updatedAt: Date;
  inputPayload: unknown;
  userId: string;
  localDate: string;
  sourceId: string;
  deletedAt: Date | null;
}

const makeRows = (): FakeRow[] => ids.map((id, index) => ({
  id,
  kind: index % 2 === 0 ? 'workout' : 'sleep',
  status: 'failed',
  retryCount: index + 1,
  nextAttemptAt: new Date(`2026-07-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`),
  leaseToken: null,
  leaseExpiresAt: null,
  result: null,
  notificationState: `notification-${index}`,
  notificationRetryCount: 20 + index,
  notificationNextAttemptAt: new Date(`2026-08-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`),
  notificationLeaseToken: `notification-lease-${index}`,
  notificationLeaseExpiresAt: new Date(`2026-09-${String(index + 1).padStart(2, '0')}T03:00:00.000Z`),
  notificationSentAt: new Date(`2026-10-${String(index + 1).padStart(2, '0')}T04:00:00.000Z`),
  updatedAt: new Date(`2026-11-${String(index + 1).padStart(2, '0')}T05:00:00.000Z`),
  inputPayload: { source: `payload-${index}`, nested: { value: index } },
  userId: `user-${index}`,
  localDate: `2026-12-${String(index + 1).padStart(2, '0')}`,
  sourceId: `source-${index}`,
  deletedAt: null,
}));

class FakeRecoveryStore implements RecoveryStore {
  rows: FakeRow[];
  opened = 0;
  commits = 0;
  recoverCalls: Array<{ kind: RecoveryKind; ids: string[]; now: Date }> = [];
  casMissId: string | null = null;

  constructor(rows = makeRows()) {
    this.rows = structuredClone(rows);
  }

  async transaction<T>(operation: (tx: RecoveryTransaction) => Promise<T>): Promise<T> {
    this.opened += 1;
    const snapshot = structuredClone(this.rows);
    const tx: RecoveryTransaction = {
      lockRows: async (requestedIds) => this.rows
        .filter((row) => requestedIds.includes(row.id))
        .map(({ id, kind, status, retryCount, leaseToken, result }) => ({ id, kind, status, retryCount, leaseToken, result })),
      recover: async (kind, requestedIds, recoveryNow) => {
        this.recoverCalls.push({ kind, ids: [...requestedIds], now: recoveryNow });
        const recovered: string[] = [];
        for (const row of this.rows) {
          if (row.kind !== kind || !requestedIds.includes(row.id) || row.id === this.casMissId) continue;
          if (row.status !== 'failed' || row.leaseToken !== null || row.result !== null) continue;
          row.status = 'pending';
          row.retryCount = 0;
          row.nextAttemptAt = recoveryNow;
          row.leaseToken = null;
          row.leaseExpiresAt = null;
          recovered.push(row.id);
        }
        return recovered;
      },
    };
    try {
      const result = await operation(tx);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }
}

const invalidArgv: Array<{ name: string; args: string[] }> = [
  ...Array.from({ length: 9 }, (_, count) => ({ name: `${count} IDs`, args: argv(ids.slice(0, count)) })),
  { name: 'ten IDs', args: argv([...ids, '00000000-0000-4000-8000-000000000010']) },
  { name: 'duplicate IDs', args: argv([...ids.slice(0, 8), ids[0]]) },
  { name: 'uppercase UUID', args: argv(['A0000000-0000-4000-8000-000000000001', ...ids.slice(1)]) },
  { name: 'noncanonical UUID', args: argv([ids[0].replace('-4000-', '-9000-'), ...ids.slice(1)]) },
  { name: 'malformed UUID', args: argv(['not-a-uuid', ...ids.slice(1)]) },
  { name: 'positional value', args: [...argv(ids.slice(0, 8)), ids[8], '--id'] },
  { name: 'missing flag value', args: [...argv(ids.slice(0, 8)), '--id'] },
  { name: 'unknown flag', args: ['--job', ids[0], ...argv(ids.slice(1))] },
];

for (const invalid of invalidArgv) {
  test(`parser rejects ${invalid.name} before opening a store`, () => {
    const store = new FakeRecoveryStore();
    assert.throws(
      () => parseRecoveryIds(invalid.args),
      (error: unknown) => error instanceof Error && error.message === 'Invalid proactive analysis recovery arguments.',
    );
    assert.equal(store.opened, 0);
  });
}

test('parser returns exactly nine canonical UUIDs in input order', () => {
  assert.deepEqual(parseRecoveryIds(argv(ids)), ids);
});

test('atomically recovers a mixed workout and sleep set while preserving every other field', async () => {
  const store = new FakeRecoveryStore();
  const before = structuredClone(store.rows);
  const counts = await recoverProactiveAnalysisJobs(store, ids, now);

  assert.equal(counts.requestedCount, 9);
  assert.equal(counts.matchedCount, 9);
  assert.equal(counts.eligibleCount, 9);
  assert.equal(counts.workoutUpdatedCount + counts.sleepUpdatedCount, 9);
  assert.equal(counts.totalUpdatedCount, 9);
  assert.equal(store.opened, 1);
  assert.equal(store.commits, 1);

  for (let index = 0; index < store.rows.length; index += 1) {
    const expected = structuredClone(before[index]);
    expected.status = 'pending';
    expected.retryCount = 0;
    expected.nextAttemptAt = now;
    expected.leaseToken = null;
    expected.leaseExpiresAt = null;
    assert.deepEqual(store.rows[index], expected);
    assert.equal(store.rows[index].result, null);
  }
});

const rollbackCases: Array<{ name: string; mutate: (store: FakeRecoveryStore) => void }> = [
  { name: 'absent UUID', mutate: (store) => { store.rows.pop(); } },
  ...['pending', 'processing', 'ready', 'deleted'].map((status) => ({
    name: `${status} status`,
    mutate: (store: FakeRecoveryStore) => { store.rows[0].status = status; },
  })),
  { name: 'non-null lease', mutate: (store) => { store.rows[0].leaseToken = 'active-lease'; } },
  { name: 'non-null result', mutate: (store) => { store.rows[0].result = { headline: 'existing' }; } },
  { name: 'concurrent compare-and-set miss', mutate: (store) => { store.casMissId = ids[0]; } },
];

for (const rollbackCase of rollbackCases) {
  test(`${rollbackCase.name} rolls the whole transaction back`, async () => {
    const store = new FakeRecoveryStore();
    rollbackCase.mutate(store);
    const before = structuredClone(store.rows);
    await assert.rejects(recoverProactiveAnalysisJobs(store, ids, now));
    assert.deepEqual(store.rows, before);
    assert.equal(store.opened, 1);
    assert.equal(store.commits, 0);
  });
}

test('a second recovery rolls back and preserves the first committed state', async () => {
  const store = new FakeRecoveryStore();
  await recoverProactiveAnalysisJobs(store, ids, now);
  const committed = structuredClone(store.rows);
  await assert.rejects(recoverProactiveAnalysisJobs(store, ids, new Date('2026-07-14T12:00:00.000Z')));
  assert.deepEqual(store.rows, committed);
  assert.equal(store.opened, 2);
  assert.equal(store.commits, 1);
});

test('count formatting is fixed, numeric-only, and free of recovery details', () => {
  const counts = {
    requestedCount: 9,
    matchedCount: 9,
    eligibleCount: 9,
    workoutUpdatedCount: 5,
    sleepUpdatedCount: 4,
    totalUpdatedCount: 9,
  };
  for (const [success, expectedLastLine] of [[true, 'success_count=1'], [false, 'failure_count=1']] as const) {
    const output = formatRecoveryCounts(counts, success);
    const lines = output.split('\n').filter(Boolean);
    assert.equal(lines.at(-1), expectedLastLine);
    for (const line of lines) assert.match(line, /^[a-z_]+=[0-9]+$/);
    for (const forbidden of [
      ...ids,
      'status',
      'retryCount',
      'leaseToken',
      'private failure text',
      'select * from',
      'postgres://user:password@host/database',
    ]) assert.equal(output.includes(forbidden), false, `output leaked ${forbidden}`);
  }
});
