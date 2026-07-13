import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatRecoveryCounts,
  parseRecoveryIds,
  recoverProactiveAnalysisJobs,
  RECOVERY_JOB_COUNT,
  RECOVERY_SLEEP_COUNT,
  RECOVERY_WORKOUT_COUNT,
  type RecoveryKind,
  type RecoveryRow,
  type RecoveryStore,
  type RecoveryTransaction,
} from './proactiveAnalysisRecovery';

const ids = Array.from(
  { length: 14 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);
const argv = (values: string[]): string[] => values.flatMap((id) => ['--id', id]);
const now = new Date('2026-07-13T12:00:00.000Z');
const foreignId = '00000000-0000-4000-8000-000000000099';

interface FakeRow extends RecoveryRow {
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
  notificationRetryCount: number;
  notificationNextAttemptAt: Date;
  notificationLeaseToken: string | null;
  notificationLeaseExpiresAt: Date | null;
  updatedAt: Date;
  inputPayload: unknown;
  userId: string;
  localDate: string;
  sourceId: string;
  deletedAt: Date | null;
}

const makeRows = (): FakeRow[] => ids.map((id, index) => ({
  id,
  kind: index < 8 ? 'workout' : 'sleep',
  status: 'failed',
  retryCount: index + 1,
  nextAttemptAt: new Date(`2026-06-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`),
  leaseToken: null,
  leaseExpiresAt: null,
  result: null,
  notificationState: 'failed',
  notificationRetryCount: 20 + index,
  notificationNextAttemptAt: new Date(`2026-08-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`),
  notificationLeaseToken: `notification-lease-${index}`,
  notificationLeaseExpiresAt: new Date(`2026-09-${String(index + 1).padStart(2, '0')}T03:00:00.000Z`),
  notificationSentAt: null,
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
  lockRowsTransform: (rows: RecoveryRow[]) => RecoveryRow[] = (rows) => rows;
  beforeFirstRecover: (() => void) | null = null;
  returnIdsTransform: (kind: RecoveryKind, ids: string[]) => string[] = (_kind, returnedIds) => returnedIds;
  private ranBeforeRecover = false;

  constructor(rows = makeRows()) {
    this.rows = structuredClone(rows);
  }

  async transaction<T>(operation: (tx: RecoveryTransaction) => Promise<T>): Promise<T> {
    this.opened += 1;
    const snapshot = structuredClone(this.rows);
    const tx: RecoveryTransaction = {
      lockRows: async (requestedIds) => {
        const locked = this.rows
          .filter((row) => requestedIds.includes(row.id))
          .map(({
            id,
            kind,
            status,
            retryCount,
            leaseToken,
            result,
            notificationState,
            notificationSentAt,
          }) => ({
            id,
            kind,
            status,
            retryCount,
            leaseToken,
            result,
            notificationState,
            notificationSentAt,
          }));
        return this.lockRowsTransform(locked);
      },
      recover: async (kind, requestedIds, recoveryNow) => {
        if (!this.ranBeforeRecover) {
          this.ranBeforeRecover = true;
          this.beforeFirstRecover?.();
        }
        this.recoverCalls.push({ kind, ids: [...requestedIds], now: recoveryNow });
        const recovered: string[] = [];
        for (const row of this.rows) {
          if (row.kind !== kind || !requestedIds.includes(row.id)) continue;
          if (
            row.status !== 'failed'
            || row.leaseToken !== null
            || row.result !== null
            || row.notificationState !== 'failed'
            || row.notificationSentAt !== null
          ) continue;

          row.status = 'pending';
          row.retryCount = 0;
          row.nextAttemptAt = recoveryNow;
          row.leaseToken = null;
          row.leaseExpiresAt = null;
          row.notificationState = 'pending';
          recovered.push(row.id);
        }
        return this.returnIdsTransform(kind, recovered);
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

const fifteenthId = '00000000-0000-4000-8000-000000000015';
const invalidArgv: Array<{ name: string; args: string[] }> = [
  ...Array.from({ length: 14 }, (_, count) => ({ name: `${count} IDs`, args: argv(ids.slice(0, count)) })),
  { name: '15 IDs', args: argv([...ids, fifteenthId]) },
  { name: 'duplicate IDs', args: argv([...ids.slice(0, 13), ids[0]]) },
  { name: 'uppercase UUID', args: argv(['A0000000-0000-4000-8000-000000000001', ...ids.slice(1)]) },
  { name: 'noncanonical UUID', args: argv([ids[0].replace('-4000-', '-9000-'), ...ids.slice(1)]) },
  { name: 'malformed UUID', args: argv(['not-a-uuid', ...ids.slice(1)]) },
  { name: 'positional value', args: [...argv(ids.slice(0, 13)), ids[13], '--id'] },
  { name: 'missing flag value', args: [...argv(ids.slice(0, 13)), '--id'] },
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

test('exports the exact recovery population constants', () => {
  assert.equal(RECOVERY_JOB_COUNT, 14);
  assert.equal(RECOVERY_WORKOUT_COUNT, 8);
  assert.equal(RECOVERY_SLEEP_COUNT, 6);
});

test('parser returns exactly fourteen canonical UUIDs in input order', () => {
  assert.deepEqual(parseRecoveryIds(argv(ids)), ids);
});

test('atomically recovers the exact workout and sleep population while preserving every other field', async () => {
  const store = new FakeRecoveryStore();
  const before = structuredClone(store.rows);
  const counts = await recoverProactiveAnalysisJobs(store, ids, now);

  assert.deepEqual(counts, {
    requestedCount: 14,
    matchedCount: 14,
    eligibleCount: 14,
    workoutUpdatedCount: 8,
    sleepUpdatedCount: 6,
    totalUpdatedCount: 14,
  });
  assert.equal(store.opened, 1);
  assert.equal(store.commits, 1);

  for (let index = 0; index < store.rows.length; index += 1) {
    const expected = structuredClone(before[index]);
    expected.status = 'pending';
    expected.retryCount = 0;
    expected.nextAttemptAt = now;
    expected.leaseToken = null;
    expected.leaseExpiresAt = null;
    expected.notificationState = 'pending';
    assert.deepEqual(store.rows[index], expected);
  }
});

const eligibilityCases: Array<{ name: string; mutate: (row: FakeRow) => void }> = [
  { name: 'pending analysis status', mutate: (row) => { row.status = 'pending'; } },
  { name: 'active analysis lease', mutate: (row) => { row.leaseToken = 'active-lease'; } },
  { name: 'existing analysis result', mutate: (row) => { row.result = { headline: 'existing' }; } },
  { name: 'pending notification state', mutate: (row) => { row.notificationState = 'pending'; } },
  { name: 'suppressed notification state', mutate: (row) => { row.notificationState = 'suppressed'; } },
  { name: 'sending notification state', mutate: (row) => { row.notificationState = 'sending'; } },
  { name: 'sent notification state', mutate: (row) => { row.notificationState = 'sent'; } },
  { name: 'sent notification timestamp', mutate: (row) => { row.notificationSentAt = now; } },
];

for (const eligibilityCase of eligibilityCases) {
  test(`${eligibilityCase.name} in the locked rows rolls the whole transaction back`, async () => {
    const store = new FakeRecoveryStore();
    eligibilityCase.mutate(store.rows[0]);
    const before = structuredClone(store.rows);
    await assert.rejects(recoverProactiveAnalysisJobs(store, ids, now));
    assert.deepEqual(store.rows, before);
    assert.equal(store.opened, 1);
    assert.equal(store.commits, 0);
    assert.equal(store.recoverCalls.length, 0);
  });
}

const lockedSetCases: Array<{
  name: string;
  transform: (rows: RecoveryRow[]) => RecoveryRow[];
}> = [
  { name: 'missing locked row', transform: (rows) => rows.slice(0, -1) },
  { name: 'duplicate locked ID', transform: (rows) => [...rows.slice(0, -1), rows[0]] },
  { name: 'extra foreign locked ID', transform: (rows) => [...rows, { ...rows[0], id: foreignId }] },
  { name: 'changed locked ID', transform: (rows) => [{ ...rows[0], id: foreignId }, ...rows.slice(1)] },
  { name: '9-workout/5-sleep distribution', transform: (rows) => rows.map((row, index) => index === 8 ? { ...row, kind: 'workout' } : row) },
  { name: '7-workout/7-sleep distribution', transform: (rows) => rows.map((row, index) => index === 7 ? { ...row, kind: 'sleep' } : row) },
];

for (const lockedSetCase of lockedSetCases) {
  test(`${lockedSetCase.name} rolls back before recovery`, async () => {
    const store = new FakeRecoveryStore();
    store.lockRowsTransform = lockedSetCase.transform;
    const before = structuredClone(store.rows);
    await assert.rejects(recoverProactiveAnalysisJobs(store, ids, now));
    assert.deepEqual(store.rows, before);
    assert.equal(store.opened, 1);
    assert.equal(store.commits, 0);
    assert.equal(store.recoverCalls.length, 0);
  });
}

const casMissCases: Array<{ name: string; mutate: (row: FakeRow) => void }> = [
  { name: 'analysis status', mutate: (row) => { row.status = 'pending'; } },
  { name: 'analysis lease', mutate: (row) => { row.leaseToken = 'active-lease'; } },
  { name: 'analysis result', mutate: (row) => { row.result = { headline: 'existing' }; } },
  { name: 'notification state', mutate: (row) => { row.notificationState = 'sending'; } },
  { name: 'notification sent timestamp', mutate: (row) => { row.notificationSentAt = now; } },
];

for (const casMissCase of casMissCases) {
  test(`CAS miss caused by ${casMissCase.name} rolls the whole transaction back`, async () => {
    const store = new FakeRecoveryStore();
    store.beforeFirstRecover = () => { casMissCase.mutate(store.rows[0]); };
    const before = structuredClone(store.rows);
    await assert.rejects(recoverProactiveAnalysisJobs(store, ids, now));
    assert.deepEqual(store.rows, before);
    assert.equal(store.opened, 1);
    assert.equal(store.commits, 0);
  });
}

const returnedSetCases: Array<{
  name: string;
  transform: (kind: RecoveryKind, returnedIds: string[]) => string[];
}> = [
  { name: 'duplicate returned ID', transform: (_kind, returnedIds) => [...returnedIds.slice(0, -1), returnedIds[0]] },
  { name: 'foreign returned ID', transform: (_kind, returnedIds) => [...returnedIds.slice(0, -1), foreignId] },
  { name: 'workout ID returned by sleep update', transform: (kind, returnedIds) => kind === 'sleep' ? [...returnedIds.slice(0, -1), ids[0]] : returnedIds },
  { name: 'sleep ID returned by workout update', transform: (kind, returnedIds) => kind === 'workout' ? [...returnedIds.slice(0, -1), ids[8]] : returnedIds },
  { name: 'omitted returned ID', transform: (_kind, returnedIds) => returnedIds.slice(0, -1) },
];

for (const returnedSetCase of returnedSetCases) {
  test(`${returnedSetCase.name} rolls the whole transaction back`, async () => {
    const store = new FakeRecoveryStore();
    store.returnIdsTransform = returnedSetCase.transform;
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
    requestedCount: 14,
    matchedCount: 14,
    eligibleCount: 14,
    workoutUpdatedCount: 8,
    sleepUpdatedCount: 6,
    totalUpdatedCount: 14,
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
      'notificationState',
      'notificationSentAt',
      'private failure text',
      'select * from',
      'postgres://user:password@host/database',
    ]) assert.equal(output.includes(forbidden), false, `output leaked ${forbidden}`);
  }
});
