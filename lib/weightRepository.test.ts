import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as realSchema from '../db/schema';

/**
 * Drives lib/weightRepository.ts against a fake `@/db` and a fake
 * `./weightLog` (no filesystem), so it never touches Postgres or disk —
 * same pattern as lib/brain/tools.logMeal.test.ts. mock.module() must run
 * before ./weightRepository is first imported; node:test isolates each test
 * file in its own subprocess, so this lives on its own.
 *
 * The fake `select()` distinguishes logWeightEntry's dedup existence check
 * (select({ id }) ... .where().limit()) from queryManualWeightEvents' full
 * row read (select({ id, timestamp, payload, source }) ... .where(), no
 * .limit()) by whether `payload` is among the requested columns.
 */

const state: {
  existingEventRows: Array<{ id: string }>;
  manualEventRows: Array<{ id: string; timestamp: Date; payload: unknown; source: string }>;
  dailyMetricRows: Array<{ date: string; value: number }>;
  legacyEntries: Array<{ date: string; weight: number; unit: 'lbs' | 'kg' }>;
} = { existingEventRows: [], manualEventRows: [], dailyMetricRows: [], legacyEntries: [] };

let insertedValues: Array<Record<string, unknown>> = [];

const fakeDb = {
  select: (cols?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      if (table === realSchema.events) {
        const wantsFullRow = !!cols && 'payload' in cols;
        if (wantsFullRow) {
          return { where: async () => state.manualEventRows };
        }
        return { where: () => ({ limit: async () => state.existingEventRows }) };
      }
      if (table === realSchema.daily_metrics) {
        return { where: async () => state.dailyMetricRows };
      }
      throw new Error(`unexpected select().from(): ${String(table)}`);
    },
  }),
  insert: (table: unknown) => {
    if (table !== realSchema.events) throw new Error(`unexpected insert(): ${String(table)}`);
    return {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return { returning: async () => [{ id: 'new-event-id' }] };
      },
    };
  },
};

mock.module('@/db', { namedExports: { db: fakeDb, schema: realSchema } });
mock.module('./weightLog', {
  namedExports: {
    readWeightLog: () => state.legacyEntries,
    logWeight: () => {},
  },
});

const repoPromise = import('./weightRepository');

test('logWeightEntry inserts a weight_logged event with value normalized to kg and a localDay', async () => {
  insertedValues = [];
  state.existingEventRows = [];

  const repo = await repoPromise;
  const result = await repo.logWeightEntry('user-1', {
    valueKg: 81.23456,
    measuredAt: new Date('2026-08-01T13:00:00.000Z'),
    source: 'manual',
    timezone: 'UTC',
  });

  assert.equal(result.deduped, false);
  assert.equal(result.localDay, '2026-08-01');
  assert.equal(insertedValues.length, 1);
  assert.equal(insertedValues[0].type, 'weight_logged');
  assert.equal(insertedValues[0].source, 'manual');
  assert.equal(insertedValues[0].user_id, 'user-1');
  const payload = insertedValues[0].payload as Record<string, unknown>;
  assert.equal(payload.value, 81.2); // rounded to 1dp
  assert.equal(payload.unit, 'kg');
  assert.equal(payload.localDay, '2026-08-01');
});

test('logWeightEntry skips the insert and returns the existing id when (source, measuredAt) already exists — dedup', async () => {
  insertedValues = [];
  state.existingEventRows = [{ id: 'existing-id' }];

  const repo = await repoPromise;
  const result = await repo.logWeightEntry('user-1', {
    valueKg: 80,
    measuredAt: new Date('2026-08-01T13:00:00.000Z'),
    source: 'manual',
    timezone: 'UTC',
  });

  assert.equal(result.deduped, true);
  assert.equal(result.id, 'existing-id');
  assert.equal(insertedValues.length, 0);
});

test('logWeightEntry buckets localDay by the given timezone, not UTC', async () => {
  insertedValues = [];
  state.existingEventRows = [];

  const repo = await repoPromise;
  const result = await repo.logWeightEntry('user-1', {
    valueKg: 80,
    measuredAt: new Date('2026-08-01T02:00:00.000Z'), // 2026-07-31 21:00 America/Chicago (CDT, UTC-5)
    source: 'manual',
    timezone: 'America/Chicago',
  });

  assert.equal(result.localDay, '2026-07-31');
});

test('queryManualWeightEvents converts lb-stored payloads to kg and normalizes an unrecognized source to manual', async () => {
  state.manualEventRows = [
    { id: 'e1', timestamp: new Date('2026-08-01T07:00:00.000Z'), payload: { value: 176, unit: 'lbs', localDay: '2026-08-01' }, source: 'manual' },
    { id: 'e2', timestamp: new Date('2026-08-02T07:00:00.000Z'), payload: { value: 80, unit: 'kg', localDay: '2026-08-02' }, source: 'whoop' },
  ];

  const repo = await repoPromise;
  const rows = await repo.queryManualWeightEvents('user-1', 30);

  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0].valueKg - 79.83) < 0.01);
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].localDay, '2026-08-01');
  assert.equal(rows[1].source, 'manual'); // unrecognized events.source falls back to 'manual'
});

test('queryManualWeightOverlay lets the latest manual entry win per day', async () => {
  state.manualEventRows = [
    { id: 'e1', timestamp: new Date('2026-08-01T07:00:00.000Z'), payload: { value: 80, unit: 'kg', localDay: '2026-08-01' }, source: 'manual' },
    { id: 'e2', timestamp: new Date('2026-08-01T20:00:00.000Z'), payload: { value: 79.5, unit: 'kg', localDay: '2026-08-01' }, source: 'coach' },
  ];

  const repo = await repoPromise;
  const overlay = await repo.queryManualWeightOverlay('user-1', 30);

  assert.equal(overlay.size, 1);
  assert.equal(overlay.get('2026-08-01'), 79.5); // later entry (coach correction) wins
});

test('getWeightReadings merges manual events and healthkit daily_metrics rows', async () => {
  state.manualEventRows = [
    { id: 'e1', timestamp: new Date('2026-08-01T07:00:00.000Z'), payload: { value: 80, unit: 'kg', localDay: '2026-08-01' }, source: 'manual' },
  ];
  state.dailyMetricRows = [{ date: '2026-08-02', value: 79.6 }];

  const repo = await repoPromise;
  const readings = await repo.getWeightReadings('user-1', 30, 'UTC');

  assert.equal(readings.length, 2);
  const manual = readings.find((r) => r.source === 'manual');
  const hk = readings.find((r) => r.source === 'healthkit');
  assert.ok(manual);
  assert.ok(hk);
  assert.equal(hk!.localDay, '2026-08-02');
  assert.equal(hk!.valueKg, 79.6);
});

test('importLegacyWeightLogIfPresent is a no-op when there is no legacy file', async () => {
  insertedValues = [];
  state.existingEventRows = [];
  state.legacyEntries = [];

  const repo = await repoPromise;
  await repo.importLegacyWeightLogIfPresent('user-1', 'UTC');

  assert.equal(insertedValues.length, 0);
});

test('importLegacyWeightLogIfPresent inserts one manual event per legacy entry, anchored to local noon', async () => {
  insertedValues = [];
  state.existingEventRows = [];
  state.legacyEntries = [
    { date: '2026-07-01', weight: 180, unit: 'lbs' },
    { date: '2026-07-02', weight: 81, unit: 'kg' },
  ];

  const repo = await repoPromise;
  await repo.importLegacyWeightLogIfPresent('user-1', 'UTC');

  assert.equal(insertedValues.length, 2);
  assert.equal((insertedValues[0].timestamp as Date).toISOString(), '2026-07-01T12:00:00.000Z');
  const p0 = insertedValues[0].payload as Record<string, unknown>;
  assert.ok(Math.abs((p0.value as number) - 81.6) < 0.1); // 180 lb -> kg
  const p1 = insertedValues[1].payload as Record<string, unknown>;
  assert.equal(p1.value, 81);
});

// ── getWeightReadingsWithLazyImport ─────────────────────────────────────────
// lib/brain/context.ts and lib/brain/brief.ts call this (not
// importLegacyWeightLogIfPresent directly) on every coach turn / brief — the
// latency regression this guards against: importLegacyWeightLogIfPresent
// awaits one serial logWeightEntry() per legacy entry with no
// "already imported" short-circuit, so calling it unconditionally on a hot
// path pays that serial-write cost before every reply for a user with a
// large legacy log. It must only run when Postgres has NO readings yet.

test('getWeightReadingsWithLazyImport does NOT run the legacy import when Postgres readings already exist', async () => {
  insertedValues = [];
  state.existingEventRows = [];
  state.manualEventRows = [
    { id: 'e1', timestamp: new Date('2026-08-01T07:00:00.000Z'), payload: { value: 80, unit: 'kg', localDay: '2026-08-01' }, source: 'manual' },
  ];
  state.dailyMetricRows = [];
  // A non-empty legacy file too — if the import ran, insertedValues would be non-empty.
  state.legacyEntries = [{ date: '2026-07-01', weight: 180, unit: 'lbs' }];

  const repo = await repoPromise;
  const readings = await repo.getWeightReadingsWithLazyImport('user-1', 30, 'UTC');

  assert.equal(readings.length, 1);
  assert.equal(insertedValues.length, 0, 'the legacy import must NOT run when readings already exist');
});

test('getWeightReadingsWithLazyImport DOES run the legacy import when there are no readings at all', async () => {
  insertedValues = [];
  state.existingEventRows = [];
  state.manualEventRows = [];
  state.dailyMetricRows = [];
  state.legacyEntries = [
    { date: '2026-07-01', weight: 180, unit: 'lbs' },
    { date: '2026-07-02', weight: 81, unit: 'kg' },
  ];

  const repo = await repoPromise;
  await repo.getWeightReadingsWithLazyImport('user-1', 30, 'UTC');

  assert.equal(insertedValues.length, 2, 'the legacy import must run when there are no readings yet');
});
