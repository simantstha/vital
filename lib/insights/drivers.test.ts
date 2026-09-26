import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeDrivers,
  isStale,
  pairByDateLag,
  selectDrivers,
  terciles,
  type DriversRepository,
  type StoredFinding,
} from './drivers';
import type { MetricSeries } from './types';

function crossLagFinding(opts: {
  input: string;
  outcome: string;
  lag: 0 | 1;
  rho: number;
  pairs?: number;
}): StoredFinding {
  const { input, outcome, lag, rho, pairs = 40 } = opts;
  const direction = rho < 0 ? 'down' : 'up';
  return {
    signature: `cross_lag:${input}:${outcome}:${lag}:${direction}`,
    kind: 'cross_lag',
    computed_for: '2026-09-20',
    payload: {
      effect: rho,
      effectLabel: `${direction} (rho ${rho})`,
      n: pairs,
      pValue: 0.001,
      metrics: [input, outcome],
      detail: { lag, rho, pairs, input, outcome },
    },
  };
}

// ─── isStale ────────────────────────────────────────────────────────────────

test('isStale: false within the 7-day window', () => {
  assert.equal(isStale('2026-09-20', '2026-09-27'), false);
});

test('isStale: true more than 7 days before local today', () => {
  assert.equal(isStale('2026-09-18', '2026-09-27'), true);
});

test('isStale: exactly 7 days is not stale (boundary)', () => {
  assert.equal(isStale('2026-09-20', '2026-09-27'), false);
});

// ─── selectDrivers: confirmation requirement ───────────────────────────────

test('selectDrivers: drops a finding present on only one day', () => {
  const row = crossLagFinding({ input: 'steps', outcome: 'hrv_sdnn', lag: 0, rho: 0.4 });
  const picked = selectDrivers([row], new Set(), 'hrv_sdnn'); // no previous-day signature
  assert.deepEqual(picked, []);
});

test('selectDrivers: keeps a finding confirmed on both days', () => {
  const row = crossLagFinding({ input: 'steps', outcome: 'hrv_sdnn', lag: 0, rho: 0.4 });
  const picked = selectDrivers([row], new Set([row.signature]), 'hrv_sdnn');
  assert.equal(picked.length, 1);
  assert.equal(picked[0].input, 'steps');
});

test('selectDrivers: only keeps cross_lag rows whose outcome matches the requested metric', () => {
  const wrongOutcome = crossLagFinding({ input: 'steps', outcome: 'resting_hr', lag: 0, rho: 0.4 });
  const picked = selectDrivers([wrongOutcome], new Set([wrongOutcome.signature]), 'hrv_sdnn');
  assert.deepEqual(picked, []);
});

// ─── selectDrivers: lag dedupe ──────────────────────────────────────────────

test('selectDrivers: same input at lag 0 and lag 1 keeps only the larger |rho|', () => {
  const lag0 = crossLagFinding({ input: 'steps', outcome: 'hrv_sdnn', lag: 0, rho: 0.4 });
  const lag1 = crossLagFinding({ input: 'steps', outcome: 'hrv_sdnn', lag: 1, rho: -0.6 });
  const rows = [lag0, lag1];
  const previous = new Set([lag0.signature, lag1.signature]);

  const picked = selectDrivers(rows, previous, 'hrv_sdnn');
  assert.equal(picked.length, 1);
  assert.equal(picked[0].lag, 1);
  assert.equal(picked[0].rho, -0.6);
  assert.equal(picked[0].direction, 'down');
});

// ─── selectDrivers: cap of 3 ────────────────────────────────────────────────

test('selectDrivers: sorts by |rho| descending and caps at 3', () => {
  const inputs = ['steps', 'exercise_min', 'distance_m', 'dietary_protein_g', 'whoop_day_strain'];
  const rhos = [0.36, 0.9, 0.5, -0.7, 0.4];
  const rows = inputs.map((input, i) => crossLagFinding({ input, outcome: 'hrv_sdnn', lag: 0, rho: rhos[i] }));
  const previous = new Set(rows.map((r) => r.signature));

  const picked = selectDrivers(rows, previous, 'hrv_sdnn');
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.map((p) => p.input), ['exercise_min', 'dietary_protein_g', 'distance_m']);
});

// ─── pairByDateLag: date-joined pairing across a gap ───────────────────────

function series(metric: string, points: Array<[string, number | null]>): MetricSeries {
  return { metric, points: points.map(([date, value]) => ({ date, value })) };
}

test('pairByDateLag: joins by date, skipping a gap rather than shifting alignment', () => {
  const input = series('steps', [
    ['2026-09-01', 5000],
    ['2026-09-02', 6000], // outcome missing this day — must be skipped, not shifted
    ['2026-09-03', 7000],
  ]);
  const outcome = series('hrv_sdnn', [
    ['2026-09-01', 50],
    ['2026-09-03', 60],
  ]);

  const pairs = pairByDateLag(input, outcome, 0);
  assert.deepEqual(pairs, [
    { input: 5000, outcome: 50 },
    { input: 7000, outcome: 60 },
  ]);
});

test('pairByDateLag: lag 1 pairs input[d] with outcome[d+1]', () => {
  const input = series('steps', [['2026-09-01', 5000], ['2026-09-02', 6000]]);
  const outcome = series('hrv_sdnn', [['2026-09-02', 50], ['2026-09-03', 60]]);

  const pairs = pairByDateLag(input, outcome, 1);
  assert.deepEqual(pairs, [
    { input: 5000, outcome: 50 },
    { input: 6000, outcome: 60 },
  ]);
});

test('pairByDateLag: null values are excluded from both sides', () => {
  const input = series('steps', [['2026-09-01', null], ['2026-09-02', 6000]]);
  const outcome = series('hrv_sdnn', [['2026-09-01', 50], ['2026-09-02', null]]);

  assert.deepEqual(pairByDateLag(input, outcome, 0), []);
});

// ─── terciles ───────────────────────────────────────────────────────────────

function pairsFromInputs(inputs: number[], outcomeOf: (x: number) => number) {
  return inputs.map((x) => ({ input: x, outcome: outcomeOf(x) }));
}

test('terciles: reports high/low outcome means with counts, for enough pairs', () => {
  // 15 pairs, input 1..15, outcome mirrors input — top and bottom tercile
  // (5 each) should be clearly separated.
  const pairs = pairsFromInputs(
    Array.from({ length: 15 }, (_, i) => i + 1),
    (x) => x * 2,
  );
  const result = terciles(pairs);
  assert.ok(result.low);
  assert.ok(result.high);
  assert.equal(result.low!.n, 5);
  assert.equal(result.high!.n, 5);
  // low tercile inputs 1..5 -> outcomes 2,4,6,8,10 -> mean 6
  assert.equal(result.low!.mean, 6);
  // high tercile inputs 11..15 -> outcomes 22,24,26,28,30 -> mean 26
  assert.equal(result.high!.mean, 26);
  assert.equal(result.lowInputMean, 3);
  assert.equal(result.highInputMean, 13);
});

test('terciles: null high/low when a tercile has fewer than 5 pairs', () => {
  const pairs = pairsFromInputs([1, 2, 3, 4, 5, 6, 7, 8, 9], (x) => x); // 9 pairs -> tercile size 3
  const result = terciles(pairs);
  assert.equal(result.high, null);
  assert.equal(result.low, null);
  assert.equal(result.highInputMean, null);
  assert.equal(result.lowInputMean, null);
});

test('terciles: empty input yields all-null result', () => {
  assert.deepEqual(terciles([]), { high: null, low: null, highInputMean: null, lowInputMean: null });
});

// ─── computeDrivers: end-to-end orchestration over fakes ───────────────────

function fakeRepository(overrides: Partial<DriversRepository> = {}): DriversRepository {
  return {
    latestComputedFor: async () => '2026-09-20',
    findingsForDay: async () => [],
    loadSeries: async () => [],
    ...overrides,
  };
}

test('computeDrivers: unrecognized outcome metric returns 200 with empty drivers, no repository calls', async () => {
  let called = false;
  const repository = fakeRepository({ latestComputedFor: async () => { called = true; return null; } });
  const result = await computeDrivers(repository, 'user-1', 'not_a_real_metric', '2026-09-27');
  assert.deepEqual(result, { metric: 'not_a_real_metric', computedFor: null, drivers: [] });
  assert.equal(called, false);
});

test('computeDrivers: no findings at all -> computedFor null, empty drivers', async () => {
  const repository = fakeRepository({ latestComputedFor: async () => null });
  const result = await computeDrivers(repository, 'user-1', 'hrv_sdnn', '2026-09-27');
  assert.deepEqual(result, { metric: 'hrv_sdnn', computedFor: null, drivers: [] });
});

test('computeDrivers: stale computedFor (>7 days old) -> computedFor null, empty drivers', async () => {
  const repository = fakeRepository({ latestComputedFor: async () => '2026-09-01' });
  const result = await computeDrivers(repository, 'user-1', 'hrv_sdnn', '2026-09-27');
  assert.deepEqual(result, { metric: 'hrv_sdnn', computedFor: null, drivers: [] });
});

test('computeDrivers: end to end, one confirmed driver with a tercile magnitude', async () => {
  const row = crossLagFinding({ input: 'steps', outcome: 'hrv_sdnn', lag: 0, rho: 0.5, pairs: 42 });
  const inputSeries = series(
    'steps',
    Array.from({ length: 15 }, (_, i) => [`2026-08-${String(i + 1).padStart(2, '0')}`, (i + 1) * 1000] as [string, number]),
  );
  const outcomeSeries = series(
    'hrv_sdnn',
    Array.from({ length: 15 }, (_, i) => [`2026-08-${String(i + 1).padStart(2, '0')}`, 40 + i] as [string, number]),
  );

  const repository = fakeRepository({
    latestComputedFor: async () => '2026-09-20',
    findingsForDay: async (_userId, day) => (day === '2026-09-20' || day === '2026-09-19' ? [row] : []),
    loadSeries: async () => [inputSeries, outcomeSeries],
  });

  const result = await computeDrivers(repository, 'user-1', 'hrv_sdnn', '2026-09-27');
  assert.equal(result.computedFor, '2026-09-20');
  assert.equal(result.drivers.length, 1);
  const [driver] = result.drivers;
  assert.equal(driver.input, 'steps');
  assert.equal(driver.lag, 0);
  assert.equal(driver.pairs, 42);
  assert.ok(driver.high);
  assert.ok(driver.low);
});
