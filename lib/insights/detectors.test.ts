import assert from 'node:assert/strict';
import test from 'node:test';

import { detectCadenceBreak } from './detectors';
import type { MetricSeries } from './types';

/** Builds a 90-day series ending 2026-09-07 from a day -> value map. */
function series(metric: string, values: Record<string, number | null>): MetricSeries {
  const points = [];
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let i = 89; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    points.push({ date, value: date in values ? values[date] : null });
  }
  return { metric, points };
}

/** Marks `every`-th day active with `value`, across the whole window. */
function regular(every: number, value = 45): Record<string, number> {
  const out: Record<string, number> = {};
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let i = 89; i >= 0; i -= 1) {
    if (i % every !== 0) continue;
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out[d.toISOString().slice(0, 10)] = value;
  }
  return out;
}

test('fires when a six-day-a-week cadence has been silent for days', () => {
  // Active every day except the trailing 5.
  const values = regular(1);
  for (let i = 0; i < 5; i += 1) {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - i);
    delete values[d.toISOString().slice(0, 10)];
  }
  const finding = detectCadenceBreak(series('exercise_min', values));
  assert.ok(finding);
  assert.equal(finding.kind, 'cadence_break');
  assert.equal(finding.pValue, null);
  assert.equal(finding.effect, 5);
  assert.equal(finding.signature, 'cadence_break:exercise_min');
});

test('stays quiet when the user trained today', () => {
  assert.equal(detectCadenceBreak(series('exercise_min', regular(1))), null);
});

test('stays quiet when there is no established cadence to break', () => {
  // ~1 session/week, the last one 14 days ago: silent long enough to clear the
  // MIN_SILENT_DAYS guard, so this genuinely exercises the >= 3/week bar rather
  // than short-circuiting before it.
  const values: Record<string, number> = {};
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let i = 89; i >= 14; i -= 1) {
    if (i % 7 !== 0) continue;
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    values[d.toISOString().slice(0, 10)] = 45;
  }
  assert.equal(detectCadenceBreak(series('exercise_min', values)), null);
});

test('a rest day is not a break for a six-day-a-week athlete', () => {
  const values = regular(1);
  const d = new Date(Date.UTC(2026, 8, 7));
  delete values[d.toISOString().slice(0, 10)];
  assert.equal(detectCadenceBreak(series('exercise_min', values)), null);
});

test('treats a recorded zero as a non-active day, not as missing data', () => {
  const values: Record<string, number | null> = regular(1);
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - i);
    values[d.toISOString().slice(0, 10)] = 0;
  }
  const finding = detectCadenceBreak(series('exercise_min', values));
  assert.ok(finding);
  assert.equal(finding.effect, 6);
});

test('returns null for a series with no activity at all', () => {
  assert.equal(detectCadenceBreak(series('exercise_min', {})), null);
});
