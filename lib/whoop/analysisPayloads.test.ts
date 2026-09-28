import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWhoopSleepInput, buildWhoopWorkoutInput, titleCaseSportName, zonesFromWhoopZoneDurations } from './analysisPayloads';
import type { WhoopSleep, WhoopWorkout } from './client';

test('titleCaseSportName: single word', () => {
  assert.equal(titleCaseSportName('running'), 'Running');
});

test('titleCaseSportName: underscore-separated words', () => {
  assert.equal(titleCaseSportName('high_intensity_interval_training'), 'High Intensity Interval Training');
});

test('titleCaseSportName: already-uppercase input is normalized', () => {
  assert.equal(titleCaseSportName('WEIGHTLIFTING'), 'Weightlifting');
});

function workout(overrides: Partial<WhoopWorkout> = {}): WhoopWorkout {
  return {
    id: 'w-1',
    user_id: 1,
    start: '2026-08-01T10:00:00.000Z',
    end: '2026-08-01T10:45:00.000Z',
    sport_name: 'running',
    score_state: 'SCORED',
    score: {
      strain: 12.3,
      average_heart_rate: 140,
      max_heart_rate: 170,
      kilojoule: 2000,
      distance_meter: 5000,
    },
    ...overrides,
  };
}

test('buildWhoopWorkoutInput: maps every field, title-cases sport, converts kJ->kcal', () => {
  const input = buildWhoopWorkoutInput(workout());
  assert.equal(input.type, 'Running');
  assert.equal(input.startTime, '2026-08-01T10:00:00.000Z');
  assert.equal(input.durationMin, 45);
  assert.equal(input.kcal, Math.round(2000 / 4.184));
  assert.equal(input.avgHr, 140);
  assert.equal(input.maxHr, 170);
  assert.equal(input.distanceM, 5000);
  assert.equal(input.strain, 12.3);
  assert.equal(input.source, 'whoop');
});

test('buildWhoopWorkoutInput: underscore sport name is title-cased', () => {
  const input = buildWhoopWorkoutInput(workout({ sport_name: 'weightlifting' }));
  assert.equal(input.type, 'Weightlifting');
});

test('buildWhoopWorkoutInput: omits null/missing fields entirely, never writes 0', () => {
  const input = buildWhoopWorkoutInput(workout({
    score: { strain: 5, average_heart_rate: 0 as unknown as number, max_heart_rate: 150, kilojoule: undefined as unknown as number, distance_meter: null },
  }));
  assert.ok(!('kcal' in input));
  assert.ok(!('distanceM' in input));
  // average_heart_rate of literal 0 is a real (if implausible) value from WHOOP, not a missing one; passed through.
  assert.equal(input.avgHr, 0);
});

test('buildWhoopWorkoutInput: no score at all -> only the always-present fields', () => {
  const input = buildWhoopWorkoutInput(workout({ score: null }));
  assert.deepEqual(input, {
    type: 'Running',
    startTime: '2026-08-01T10:00:00.000Z',
    durationMin: 45,
    source: 'whoop',
  });
});

test('zonesFromWhoopZoneDurations: maps zones 1-5 to whole seconds, dropping zone zero', () => {
  const zones = zonesFromWhoopZoneDurations({
    zone_zero_milli: 60_000,
    zone_one_milli: 120_000,
    zone_two_milli: 180_000,
    zone_three_milli: 240_000,
    zone_four_milli: 300_000,
    zone_five_milli: 30_000,
  });
  assert.deepEqual(zones, [120, 180, 240, 300, 30]);
});

test('zonesFromWhoopZoneDurations: undefined when zone_durations is absent', () => {
  assert.equal(zonesFromWhoopZoneDurations(undefined), undefined);
  assert.equal(zonesFromWhoopZoneDurations(null), undefined);
});

test('buildWhoopWorkoutInput: maps zone_durations into zonesSec + zoneBasis: maxHr', () => {
  const input = buildWhoopWorkoutInput(workout({
    score: {
      strain: 12.3,
      average_heart_rate: 140,
      max_heart_rate: 170,
      kilojoule: 2000,
      zone_durations: {
        zone_zero_milli: 0,
        zone_one_milli: 60_000,
        zone_two_milli: 120_000,
        zone_three_milli: 300_000,
        zone_four_milli: 600_000,
        zone_five_milli: 180_000,
      },
    },
  }));
  assert.deepEqual(input.zonesSec, [60, 120, 300, 600, 180]);
  assert.equal(input.zoneBasis, 'maxHr');
});

test('buildWhoopWorkoutInput: omits zonesSec/zoneBasis entirely when WHOOP reports no zone_durations', () => {
  const input = buildWhoopWorkoutInput(workout());
  assert.ok(!('zonesSec' in input));
  assert.ok(!('zoneBasis' in input));
});

function sleep(overrides: Partial<WhoopSleep> = {}): WhoopSleep {
  return {
    id: 's-1',
    user_id: 1,
    start: '2026-08-01T23:00:00.000Z',
    end: '2026-08-02T07:00:00.000Z',
    nap: false,
    score_state: 'SCORED',
    score: {
      stage_summary: {
        total_in_bed_time_milli: 480 * 60_000,
        total_awake_time_milli: 30 * 60_000,
        total_light_sleep_time_milli: 200 * 60_000,
        total_slow_wave_sleep_time_milli: 100 * 60_000,
        total_rem_sleep_time_milli: 150 * 60_000,
      },
    },
    ...overrides,
  };
}

test('buildWhoopSleepInput: minutes is asleep time (in-bed minus awake), stages rounded to minutes', () => {
  const input = buildWhoopSleepInput(sleep());
  assert.ok(input);
  assert.equal(input!.minutes, 450); // 480 - 30
  assert.deepEqual(input!.stages, { core: 200, deep: 100, rem: 150, awake: 30 });
  assert.equal(input!.source, 'whoop');
});

test('buildWhoopSleepInput: no stage_summary yet (unscored) -> null', () => {
  assert.equal(buildWhoopSleepInput(sleep({ score: null })), null);
  assert.equal(buildWhoopSleepInput(sleep({ score: { stage_summary: undefined } })), null);
});

test('buildWhoopSleepInput: missing in-bed or awake time -> null (cannot derive asleep minutes)', () => {
  assert.equal(
    buildWhoopSleepInput(sleep({ score: { stage_summary: { total_awake_time_milli: 30 * 60_000 } } })),
    null,
  );
  assert.equal(
    buildWhoopSleepInput(sleep({ score: { stage_summary: { total_in_bed_time_milli: 480 * 60_000 } } })),
    null,
  );
});

test('buildWhoopSleepInput: non-positive derived asleep time -> null', () => {
  const input = buildWhoopSleepInput(sleep({
    score: { stage_summary: { total_in_bed_time_milli: 30 * 60_000, total_awake_time_milli: 30 * 60_000 } },
  }));
  assert.equal(input, null);
});

test('buildWhoopSleepInput: missing individual stage fields are omitted, not zeroed', () => {
  const input = buildWhoopSleepInput(sleep({
    score: {
      stage_summary: {
        total_in_bed_time_milli: 480 * 60_000,
        total_awake_time_milli: 30 * 60_000,
        // no light/slow_wave/rem fields
      },
    },
  }));
  assert.ok(input);
  assert.deepEqual(input!.stages, { awake: 30 });
});
