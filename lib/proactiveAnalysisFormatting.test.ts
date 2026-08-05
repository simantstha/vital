import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAnalysisSource } from './proactiveAnalysisFormatting';
import { type ProactiveAnalysisSource } from './proactiveAnalysisGrounding';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

test('workout figures are rounded and unit-labeled under whitelisted keys', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {
      type: 'Run',
      startTime: '2026-07-13T06:00:00.000Z',
      durationMin: 47.99,
      kcal: 411.6,
      avgHr: 147.6,
      maxHr: 168.2,
      distanceM: 8437,
      paceMinPerKm: 5.383,
      elevationGainM: 119.8,
    },
    availableContext: {},
  };

  const formatted = formatAnalysisSource(source);
  assert.deepEqual(formatted.input, {
    type: 'Run',
    startTime: '2026-07-13T06:00:00.000Z',
    duration: '48 min',
    calories: '412 kcal',
    avgHr: '148 bpm',
    maxHr: '168 bpm',
    distance: '8.4 km',
    pace: '5′23″ /km',
    elevationGainM: '120 m',
  });
});

test('unknown/unwhitelisted workout fields survive verbatim', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: { type: 'Run', hkUuid: 'abc-123', newIosField: { nested: true } },
    availableContext: {},
  };

  const formatted = formatAnalysisSource(source) as { input: Record<string, unknown> };
  assert.equal(formatted.input.hkUuid, 'abc-123');
  assert.deepEqual(formatted.input.newIosField, { nested: true });
});

test('absent or non-finite workout figures are omitted, never emitted as null', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: { type: 'Run', kcal: Number.NaN },
    availableContext: {},
  };

  const formatted = formatAnalysisSource(source) as { input: Record<string, unknown> };
  assert.equal('kcal' in formatted.input, false);
  assert.equal('calories' in formatted.input, false);
  assert.equal(JSON.stringify(formatted.input).includes('null'), false);
});

test('sleep minutes and stage minutes are formatted; other keys pass through', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'sleep',
    date: '2026-07-13',
    input: {
      minutes: 410,
      stages: { core: 180, deep: 62.4, rem: 90, awake: 12, unknownStage: 5 },
      efficiency: 91,
    },
    availableContext: {},
  };

  const formatted = formatAnalysisSource(source);
  assert.deepEqual(formatted.input, {
    duration: '6h 50m',
    stages: { core: '3h 00m', deep: '1h 02m', rem: '1h 30m', awake: '12 min', unknownStage: 5 },
    efficiency: 91,
  });
});

test('availableContext.metrics[] follows the metric-name rounding table', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {},
    availableContext: {
      metrics: [
        { date: '2026-07-13', metric: 'hrv_sdnn', value: 45.7, payload: { raw: true } },
        { date: '2026-07-13', metric: 'resting_hr', value: 58.4, payload: null },
        { date: '2026-07-13', metric: 'steps', value: 8123.9, payload: null },
        { date: '2026-07-13', metric: 'whoop_recovery', value: 71.2, payload: null },
        { date: '2026-07-13', metric: 'whoop_day_strain', value: 12.34, payload: null },
        { date: '2026-07-13', metric: 'body_mass_kg', value: 72.849, payload: null },
        { date: '2026-07-13', metric: 'sleep_minutes', value: 410, payload: null },
        { date: '2026-07-13', metric: 'whoop_sleep_min', value: 59, payload: null },
        { date: '2026-07-13', metric: 'some_other_metric', value: 3.14159, payload: null },
      ],
    },
  };

  const formatted = formatAnalysisSource(source) as { availableContext: { metrics: Array<Record<string, unknown>> } };
  const byMetric = new Map(formatted.availableContext.metrics.map((row) => [row.metric, row.value]));
  assert.equal(byMetric.get('hrv_sdnn'), 46);
  assert.equal(byMetric.get('resting_hr'), 58);
  assert.equal(byMetric.get('steps'), 8124);
  assert.equal(byMetric.get('whoop_recovery'), 71);
  assert.equal(byMetric.get('whoop_day_strain'), 12.3);
  assert.equal(byMetric.get('body_mass_kg'), 72.8);
  assert.equal(byMetric.get('sleep_minutes'), '6h 50m');
  assert.equal(byMetric.get('whoop_sleep_min'), '59 min');
  assert.equal(byMetric.get('some_other_metric'), 3.1);
  // payload passes through untouched.
  assert.deepEqual(formatted.availableContext.metrics[0].payload, { raw: true });
});

test('availableContext.baselines[].stats round to 1dp and preserve null leaves verbatim', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {},
    availableContext: {
      baselines: [
        {
          metric: 'hrv_sdnn',
          established: true,
          stats: { mean7: 45.649, mean30: null, mean60: 44.951, sd30: null, p25: 40.05, p50: 45, p75: 50.111 },
        },
      ],
    },
  };

  const formatted = formatAnalysisSource(source) as { availableContext: { baselines: Array<{ stats: Record<string, unknown> }> } };
  assert.deepEqual(formatted.availableContext.baselines[0].stats, {
    mean7: 45.6, mean30: null, mean60: 45.0, sd30: null, p25: 40.1, p50: 45, p75: 50.1,
  });
});

test('sleep_minutes metric formats to duration string', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {},
    availableContext: {
      metrics: [{ date: '2026-07-13', metric: 'sleep_minutes', value: 410, payload: null }],
    },
  };

  const formatted = formatAnalysisSource(source) as { availableContext: { metrics: Array<Record<string, unknown>> } };
  assert.equal(formatted.availableContext.metrics[0].value, '6h 50m');
});

test('whoop_hrv_rmssd metric rounds to integer', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {},
    availableContext: {
      metrics: [{ date: '2026-07-13', metric: 'whoop_hrv_rmssd', value: 47.29999923706055, payload: null }],
    },
  };

  const formatted = formatAnalysisSource(source) as { availableContext: { metrics: Array<Record<string, unknown>> } };
  assert.equal(formatted.availableContext.metrics[0].value, 47);
});

test('workout distance/pace render in imperial units, unit suffix included, when the user has that preference', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {
      type: 'Run',
      distanceM: 8437,
      paceMinPerKm: 5.383,
      elevationGainM: 119.8,
    },
    availableContext: {},
  };

  const formatted = formatAnalysisSource(source, 'imperial');
  assert.deepEqual(formatted.input, {
    type: 'Run',
    distance: '5.2 mi',
    pace: '8′40″ /mi',
    elevationGainM: '120 m', // deliberately left in metres — out of scope
  });
});

test('formatAnalysisSource defaults to metric when no units argument is passed — existing callers are unaffected', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: { type: 'Run', distanceM: 8437 },
    availableContext: {},
  };

  const formatted = formatAnalysisSource(source) as { input: Record<string, unknown> };
  assert.equal(formatted.input.distance, '8.4 km');
});

test('body_mass_kg converts to lb and relabels to body_mass_lb under imperial — never a converted value under a _kg key', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {},
    availableContext: {
      metrics: [{ date: '2026-07-13', metric: 'body_mass_kg', value: 72.849, payload: null }],
    },
  };

  const formatted = formatAnalysisSource(source, 'imperial') as {
    availableContext: { metrics: Array<Record<string, unknown>> };
  };
  assert.equal(formatted.availableContext.metrics[0].metric, 'body_mass_lb');
  assert.equal(formatted.availableContext.metrics[0].value, Math.round(72.849 * 2.2046226218)); // 161
});

test('body_mass_kg stays body_mass_kg and unconverted under metric (default)', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: {},
    availableContext: {
      metrics: [{ date: '2026-07-13', metric: 'body_mass_kg', value: 72.849, payload: null }],
    },
  };

  const formatted = formatAnalysisSource(source) as {
    availableContext: { metrics: Array<Record<string, unknown>> };
  };
  assert.equal(formatted.availableContext.metrics[0].metric, 'body_mass_kg');
  assert.equal(formatted.availableContext.metrics[0].value, 72.8);
});

test('formatAnalysisSource never mutates its input, even a deep-frozen one', () => {
  const source: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-13',
    input: { type: 'Run', durationMin: 38, kcal: 300 },
    availableContext: {
      metrics: [{ date: '2026-07-13', metric: 'hrv_sdnn', value: 45 }],
      baselines: [{ metric: 'hrv_sdnn', stats: { mean7: 45.1, mean30: null } }],
    },
  };
  const snapshot = structuredClone(source);
  const frozen = deepFreeze(structuredClone(source));

  assert.doesNotThrow(() => formatAnalysisSource(frozen));
  assert.deepEqual(frozen, snapshot);
});
