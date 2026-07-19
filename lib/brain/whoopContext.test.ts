import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWhoopContextLine, type WhoopContextRow } from './whoopContext';

/**
 * Unit tests for the pure WHOOP-context-line formatter (Task 7 — see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md). The formatter
 * lives in its own DB-free module (lib/brain/whoopContext.ts) precisely so
 * these tests run without a DATABASE_URL — lib/brain/context.ts imports
 * `@/db` at module load and would throw here. assembleContext() itself pulls
 * in a full DB pipeline (events/nodes/messages/baselines/calibration/
 * schedule) that isn't worth mocking end-to-end; this tests the pure
 * formatting logic directly with plain row objects, same split as
 * lib/whoop/mapping.ts's pure mapping functions.
 */

const TODAY = '2026-07-19';
const YESTERDAY = '2026-07-18';

function row(date: string, metric: string, value: number, payload: unknown = null): WhoopContextRow {
  return { date, metric, value, payload };
}

test('returns undefined when there are no whoop rows for today or yesterday', () => {
  const line = buildWhoopContextLine([], TODAY, YESTERDAY);
  assert.equal(line, undefined);
});

test('returns undefined when rows exist only outside the today/yesterday window', () => {
  const rows = [row('2026-07-01', 'whoop_recovery', 70)];
  assert.equal(buildWhoopContextLine(rows, TODAY, YESTERDAY), undefined);
});

test('builds a full line from today when today has recovery, HRV, strain, and sleep', () => {
  const rows = [
    row(TODAY, 'whoop_recovery', 62),
    row(TODAY, 'whoop_hrv_rmssd', 45.4),
    row(TODAY, 'whoop_day_strain', 14.23),
    row(TODAY, 'whoop_sleep_min', 432, { performance: 89.4 }),
  ];
  const line = buildWhoopContextLine(rows, TODAY, YESTERDAY);
  assert.equal(line, 'WHOOP (today): recovery 62%, HRV 45ms RMSSD (not comparable to HealthKit SDNN), day strain 14.2, sleep 7h12m (performance 89%)');
});

test('falls back to yesterday when today has no whoop data at all', () => {
  const rows = [
    row(YESTERDAY, 'whoop_recovery', 55),
    row(YESTERDAY, 'whoop_day_strain', 10),
  ];
  const line = buildWhoopContextLine(rows, TODAY, YESTERDAY);
  assert.equal(line, 'WHOOP (yesterday): recovery 55%, day strain 10.0');
});

test('prefers today over yesterday even when today has only a subset of fields', () => {
  const rows = [
    row(TODAY, 'whoop_recovery', 80),
    row(YESTERDAY, 'whoop_recovery', 55),
    row(YESTERDAY, 'whoop_day_strain', 10),
    row(YESTERDAY, 'whoop_sleep_min', 400),
  ];
  const line = buildWhoopContextLine(rows, TODAY, YESTERDAY);
  // Today has SOME data (recovery), so today's bucket wins wholesale —
  // yesterday's strain/sleep are not merged in.
  assert.equal(line, 'WHOOP (today): recovery 80%');
});

test('omits sleep performance when the payload has no performance field', () => {
  const rows = [row(TODAY, 'whoop_sleep_min', 400, null)];
  const line = buildWhoopContextLine(rows, TODAY, YESTERDAY);
  assert.equal(line, 'WHOOP (today): sleep 6h40m');
});

test('ignores non-whoop metrics mixed into the same rows', () => {
  const rows = [row(TODAY, 'whoop_recovery', 70)];
  const line = buildWhoopContextLine(rows, TODAY, YESTERDAY);
  assert.equal(line, 'WHOOP (today): recovery 70%');
});

test('includes only recovery when hrv/strain/sleep are absent', () => {
  const rows = [row(TODAY, 'whoop_recovery', 91)];
  assert.equal(buildWhoopContextLine(rows, TODAY, YESTERDAY), 'WHOOP (today): recovery 91%');
});
