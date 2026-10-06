import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appleStagesFromPayload,
  assembleWeek,
  buildSleepDevicesContext,
  buildWorkoutDevicesContext,
  computeBeforeBed,
  computeEffort,
  computePaceHistory,
  computeSleepUsual,
  computeUsualWorkout,
  deviceIdFromSource,
  effortZoneFromPct,
  median,
  recoverySourceFromMetricSource,
  sleepNightFromDailyMetric,
  vsNormal,
  whoopStagesFromSummary,
} from './analysisContext';

// ── median ───────────────────────────────────────────────────────────────────

test('median: odd/even counts, empty array', () => {
  assert.equal(median([]), undefined);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

// ── vsNormal ─────────────────────────────────────────────────────────────────

test('vsNormal: above/normal/below the mean30 ± 1 sd30 band', () => {
  const baseline = { established: true, mean: 50, sd: 5 };
  assert.equal(vsNormal(56, baseline), 'above');
  assert.equal(vsNormal(44, baseline), 'below');
  assert.equal(vsNormal(50, baseline), 'normal');
  assert.equal(vsNormal(55, baseline), 'normal'); // exactly at the band edge
  assert.equal(vsNormal(55.01, baseline), 'above');
});

test('vsNormal: an unestablished baseline reports nothing', () => {
  assert.equal(vsNormal(80, { established: false, mean: 50, sd: 5 }), undefined);
  assert.equal(vsNormal(80, null), undefined);
  assert.equal(vsNormal(80, undefined), undefined);
});

test('vsNormal: missing or zero sd/mean reports nothing rather than a false band', () => {
  assert.equal(vsNormal(80, { established: true, mean: null, sd: 5 }), undefined);
  assert.equal(vsNormal(80, { established: true, mean: 50, sd: null }), undefined);
  assert.equal(vsNormal(80, { established: true, mean: 50, sd: 0 }), undefined);
});

test('recoverySourceFromMetricSource maps healthkit -> apple, whoop -> whoop', () => {
  assert.equal(recoverySourceFromMetricSource('healthkit'), 'apple');
  assert.equal(recoverySourceFromMetricSource('whoop'), 'whoop');
});

// ── usual workout ────────────────────────────────────────────────────────────

test('computeUsualWorkout: fewer than 3 previous sessions means no usual', () => {
  assert.equal(computeUsualWorkout([]), undefined);
  assert.equal(computeUsualWorkout([{ distanceM: 5000 }]), undefined);
  assert.equal(computeUsualWorkout([{ distanceM: 5000 }, { distanceM: 6000 }]), undefined);
});

test('computeUsualWorkout: medians each field independently, omitting fields nobody has', () => {
  const usual = computeUsualWorkout([
    { distanceM: 5000, durationMin: 30, paceMinPerKm: 6.0, avgHr: 140 },
    { distanceM: 6000, durationMin: 35 }, // no pace/avgHr this session
    { distanceM: 7000, durationMin: 40, paceMinPerKm: 5.5, avgHr: 150 },
  ]);
  assert.deepEqual(usual, {
    sessions: 3,
    distanceM: 6000,
    durationMin: 35,
    paceMinPerKm: 5.75,
    avgHr: 145,
  });
});

test('computeUsualWorkout: a field nobody has is simply omitted, not zeroed', () => {
  const usual = computeUsualWorkout([
    { durationMin: 30 },
    { durationMin: 35 },
    { durationMin: 40 },
  ]);
  assert.deepEqual(usual, { sessions: 3, durationMin: 35 });
});

// ── pace history ─────────────────────────────────────────────────────────────

test('computePaceHistory: fewer than 3 previous paces means no paceHistory', () => {
  assert.equal(computePaceHistory([6.0, 5.8], 5.5), undefined);
  assert.equal(computePaceHistory([], 5.5), undefined);
});

test('computePaceHistory: no current pace means no paceHistory even with enough history', () => {
  assert.equal(computePaceHistory([6.0, 5.8, 5.9], undefined), undefined);
});

test('computePaceHistory: rank 1 = fastest among previous + this one', () => {
  const history = computePaceHistory([6.2, 6.0, 6.5], 5.5); // this run is fastest
  assert.deepEqual(history, { previous: [6.2, 6.0, 6.5], rank: 1 });
});

test('computePaceHistory: rank counts strictly faster runs (lower min/km), so rank and a slow-end dot agree', () => {
  // 5.85 min/km with four faster (lower) earlier runs -> 5th fastest of 8, not 8th.
  const history = computePaceHistory([5.6, 5.95, 5.7, 6.05, 5.8, 5.9, 5.65], 5.85);
  assert.equal(history?.rank, 5);
  // Slower than every previous run -> last place.
  assert.equal(computePaceHistory([5.0, 5.1, 5.2], 6.0)?.rank, 4);
});

test('computePaceHistory: ranks a slower run correctly and keeps oldest->newest order', () => {
  const history = computePaceHistory([5.0, 5.2, 5.1], 6.0); // this run is slowest
  assert.deepEqual(history, { previous: [5.0, 5.2, 5.1], rank: 4 });
});

test('computePaceHistory: ties share the better rank', () => {
  const history = computePaceHistory([5.5, 5.5, 6.0], 5.5);
  // Nothing is strictly faster than 5.5 except... nothing; two ties at 5.5, one slower at 6.0.
  assert.deepEqual(history, { previous: [5.5, 5.5, 6.0], rank: 1 });
});

// ── effort ───────────────────────────────────────────────────────────────────

test('effortZoneFromPct: boundaries', () => {
  assert.equal(effortZoneFromPct(0), 'easy');
  assert.equal(effortZoneFromPct(0.59), 'easy');
  assert.equal(effortZoneFromPct(0.60), 'steady');
  assert.equal(effortZoneFromPct(0.74), 'steady');
  assert.equal(effortZoneFromPct(0.75), 'hard');
  assert.equal(effortZoneFromPct(0.89), 'hard');
  assert.equal(effortZoneFromPct(0.90), 'max');
  assert.equal(effortZoneFromPct(1), 'max');
});

test('computeEffort: missing restingHr, maxHr, or avgHr means no effort', () => {
  assert.equal(computeEffort({ maxHr: 180, avgHr: 150 }), undefined);
  assert.equal(computeEffort({ restingHr: 50, avgHr: 150 }), undefined);
  assert.equal(computeEffort({ restingHr: 50, maxHr: 180 }), undefined);
});

test('computeEffort: maxHr < restingHr + 20 means no effort', () => {
  assert.equal(computeEffort({ restingHr: 50, maxHr: 69, avgHr: 60 }), undefined);
  // exactly at the boundary IS allowed (>= restingHr + 20)
  const effort = computeEffort({ restingHr: 50, maxHr: 70, avgHr: 60 });
  assert.ok(effort);
});

test('computeEffort: computes avgPct clamped to 0..1 and the right zone', () => {
  const effort = computeEffort({ restingHr: 50, maxHr: 180, avgHr: 128 });
  assert.ok(effort);
  assert.equal(effort!.restingHr, 50);
  assert.equal(effort!.maxHr, 180);
  assert.equal(effort!.avgPct, 0.6);
  assert.equal(effort!.zone, 'steady');
});

test('computeEffort: clamps avgPct when avgHr is below resting or above max (bad/noisy data)', () => {
  const below = computeEffort({ restingHr: 50, maxHr: 180, avgHr: 40 });
  assert.equal(below!.avgPct, 0);
  assert.equal(below!.zone, 'easy');
  const above = computeEffort({ restingHr: 50, maxHr: 180, avgHr: 200 });
  assert.equal(above!.avgPct, 1);
  assert.equal(above!.zone, 'max');
});

// ── sleep usual ──────────────────────────────────────────────────────────────

test('computeSleepUsual: fewer than 5 nights means no usual', () => {
  const nights = [{ minutes: 400 }, { minutes: 410 }, { minutes: 420 }, { minutes: 430 }];
  assert.equal(computeSleepUsual(nights), undefined);
});

test('computeSleepUsual: medians minutes and each stage independently', () => {
  const usual = computeSleepUsual([
    { minutes: 400, stages: { core: 200, deep: 60, rem: 80, awake: 20 } },
    { minutes: 410, stages: { core: 210, deep: 65, rem: 85 } }, // no awake this night
    { minutes: 420, stages: { core: 220, deep: 70, rem: 90, awake: 30 } },
    { minutes: 430, stages: { core: 230, deep: 75, rem: 95, awake: 25 } },
    { minutes: 440, stages: { core: 240, deep: 80, rem: 100, awake: 35 } },
  ]);
  assert.deepEqual(usual, {
    nights: 5,
    minutes: 420,
    stages: { core: 220, deep: 70, rem: 90, awake: 27.5 },
  });
});

test('computeSleepUsual: no stage data at all omits the stages key', () => {
  const usual = computeSleepUsual([
    { minutes: 400 }, { minutes: 410 }, { minutes: 420 }, { minutes: 430 }, { minutes: 440 },
  ]);
  assert.deepEqual(usual, { nights: 5, minutes: 420 });
});

// ── week assembly ────────────────────────────────────────────────────────────

test('assembleWeek: missing nights are left out entirely, not backfilled', () => {
  const nightsByDate = new Map([
    ['2026-09-01', 400],
    ['2026-09-03', 420],
    // 2026-09-02 has no data — a rest of the week's dates are missing too
  ]);
  const dates = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
  assert.deepEqual(assembleWeek(nightsByDate, dates), [
    { date: '2026-09-01', minutes: 400 },
    { date: '2026-09-03', minutes: 420 },
  ]);
});

test('assembleWeek: empty map produces an empty week, never fabricated zeros', () => {
  assert.deepEqual(assembleWeek(new Map(), ['2026-09-01', '2026-09-02']), []);
});

// ── before-bed ───────────────────────────────────────────────────────────────

test('computeBeforeBed: a workout ending within 4h of bedtime is reported', () => {
  const result = computeBeforeBed({
    bedTimeIso: '2026-09-01T22:00:00Z',
    workoutEndedAtIsos: ['2026-09-01T19:00:00Z', '2026-09-01T09:00:00Z'],
    mealAtIsos: [],
  });
  assert.deepEqual(result, { lastWorkoutEndedAt: '2026-09-01T19:00:00Z' });
});

test('computeBeforeBed: a workout ending exactly 4h before bedtime is out of window (exclusive)', () => {
  const result = computeBeforeBed({
    bedTimeIso: '2026-09-01T22:00:00Z',
    workoutEndedAtIsos: ['2026-09-01T18:00:00Z'], // exactly 4h before
    mealAtIsos: [],
  });
  assert.deepEqual(result, {});
});

test('computeBeforeBed: a meal within 3h of bedtime is reported; outside 3h is not', () => {
  const result = computeBeforeBed({
    bedTimeIso: '2026-09-01T22:00:00Z',
    workoutEndedAtIsos: [],
    mealAtIsos: ['2026-09-01T20:00:00Z', '2026-09-01T17:00:00Z'],
  });
  assert.deepEqual(result, { lastMealAt: '2026-09-01T20:00:00Z' });
});

test('computeBeforeBed: something after bedtime is never reported', () => {
  const result = computeBeforeBed({
    bedTimeIso: '2026-09-01T22:00:00Z',
    workoutEndedAtIsos: ['2026-09-01T23:00:00Z'],
    mealAtIsos: ['2026-09-01T23:30:00Z'],
  });
  assert.deepEqual(result, {});
});

test('computeBeforeBed: picks the LATEST candidate within window when several qualify', () => {
  const result = computeBeforeBed({
    bedTimeIso: '2026-09-01T22:00:00Z',
    workoutEndedAtIsos: ['2026-09-01T19:00:00Z', '2026-09-01T20:30:00Z'],
    mealAtIsos: [],
  });
  assert.deepEqual(result, { lastWorkoutEndedAt: '2026-09-01T20:30:00Z' });
});

test('computeBeforeBed: no candidates at all returns an empty object (no undefined-poisoned keys)', () => {
  assert.deepEqual(computeBeforeBed({ bedTimeIso: '2026-09-01T22:00:00Z', workoutEndedAtIsos: [], mealAtIsos: [] }), {});
});

// ── stage payload normalization ─────────────────────────────────────────────

test('appleStagesFromPayload: reads core/deep/rem/awake minutes, ignores extra/invalid keys', () => {
  assert.deepEqual(appleStagesFromPayload({ core: 200, deep: 60, rem: 80, awake: 20, junk: 'x' }), {
    core: 200, deep: 60, rem: 80, awake: 20,
  });
  assert.equal(appleStagesFromPayload(null), undefined);
  assert.equal(appleStagesFromPayload('nope'), undefined);
  assert.equal(appleStagesFromPayload({}), undefined);
  assert.deepEqual(appleStagesFromPayload({ core: 200 }), { core: 200 });
});

test('whoopStagesFromSummary: converts the raw WHOOP millisecond fields to per-stage minutes', () => {
  const stages = whoopStagesFromSummary({
    total_light_sleep_time_milli: 200 * 60_000,
    total_slow_wave_sleep_time_milli: 60 * 60_000,
    total_rem_sleep_time_milli: 80 * 60_000,
    total_awake_time_milli: 20 * 60_000,
  });
  assert.deepEqual(stages, { core: 200, deep: 60, rem: 80, awake: 20 });
});

test('whoopStagesFromSummary: no usable fields returns undefined', () => {
  assert.equal(whoopStagesFromSummary(null), undefined);
  assert.equal(whoopStagesFromSummary({}), undefined);
});

// ── sleepNightFromDailyMetric: HealthKit vs WHOOP in-bed/asleep ─────────────

test('sleepNightFromDailyMetric: HealthKit value is already asleep minutes, no conversion', () => {
  const night = sleepNightFromDailyMetric('healthkit', 431, { core: 300, deep: 55, rem: 64, awake: 12 });
  assert.deepEqual(night, { minutes: 431, stages: { core: 300, deep: 55, rem: 64, awake: 12 } });
});

test('sleepNightFromDailyMetric: WHOOP value is IN-BED time; asleep minutes is derived and smaller', () => {
  // 480 min in bed, 60 min awake (per the stage summary) -> 420 min asleep.
  const stageSummary = {
    total_awake_time_milli: 60 * 60_000,
    total_light_sleep_time_milli: 250 * 60_000,
    total_slow_wave_sleep_time_milli: 90 * 60_000,
    total_rem_sleep_time_milli: 80 * 60_000,
  };
  const night = sleepNightFromDailyMetric('whoop', 480, stageSummary);
  assert.ok(night);
  assert.equal(night!.minutes, 420); // asleep, not the 480 in-bed value
  assert.deepEqual(night!.stages, { core: 250, deep: 90, rem: 80, awake: 60 });
});

test('sleepNightFromDailyMetric: WHOOP with no usable stage summary (unscored sleep) is left out entirely', () => {
  assert.equal(sleepNightFromDailyMetric('whoop', 480, null), undefined);
  assert.equal(sleepNightFromDailyMetric('whoop', 480, {}), undefined);
});

test('sleepNightFromDailyMetric: WHOOP with awake time exceeding in-bed time yields no asleep minutes', () => {
  const stageSummary = { total_awake_time_milli: 500 * 60_000 };
  assert.equal(sleepNightFromDailyMetric('whoop', 480, stageSummary), undefined);
});

// ── context.devices ─────────────────────────────────────────────────────────

test('deviceIdFromSource: healthkit -> apple, whoop -> whoop', () => {
  assert.equal(deviceIdFromSource('healthkit'), 'apple');
  assert.equal(deviceIdFromSource('whoop'), 'whoop');
});

test('buildWorkoutDevicesContext: primary session first, kcal only on primary', () => {
  const context = buildWorkoutDevicesContext(
    { source: 'healthkit', payload: { durationMin: 30, distanceM: 5000, avgHr: 140, maxHr: 170, kcal: 300, hrSeries: [120, 150], running: { cadenceSpm: 170, groundContactMs: 240 } } },
    { source: 'whoop', payload: { durationMin: 31, avgHr: 138, maxHr: 168, strain: 12.3, kcal: 320, zonesSec: [60, 120, 300, 600, 180], zoneBasis: 'maxHr' } },
  );

  assert.equal(context.primary, 'apple');
  assert.equal(context.sessions.length, 2);
  const [primarySession, otherSession] = context.sessions;
  assert.equal(primarySession.source, 'apple');
  assert.equal(primarySession.kcal, 300);
  assert.deepEqual(primarySession.hrSeries, [120, 150]);
  assert.deepEqual(primarySession.running, { cadenceSpm: 170, groundContactMs: 240 });
  assert.equal(otherSession.source, 'whoop');
  // The non-primary device's kcal is dropped — "not counted", nothing double-counted.
  assert.ok(!('kcal' in otherSession));
  assert.equal(otherSession.strain, 12.3);
  assert.deepEqual(otherSession.zonesSec, [60, 120, 300, 600, 180]);
  assert.equal(otherSession.zoneBasis, 'maxHr');
});

test('buildWorkoutDevicesContext: WHOOP as the primary/survivor', () => {
  const context = buildWorkoutDevicesContext(
    { source: 'whoop', payload: { durationMin: 45, strain: 14.1, kcal: 500 } },
    { source: 'healthkit', payload: { durationMin: 44, avgHr: 145, kcal: 480 } },
  );
  assert.equal(context.primary, 'whoop');
  assert.equal(context.sessions[0].source, 'whoop');
  assert.equal(context.sessions[0].kcal, 500);
  assert.equal(context.sessions[1].source, 'apple');
  assert.ok(!('kcal' in context.sessions[1]));
});

test('buildWorkoutDevicesContext: missing/non-finite fields are omitted, never fabricated', () => {
  const context = buildWorkoutDevicesContext(
    { source: 'healthkit', payload: { durationMin: 30 } },
    { source: 'whoop', payload: {} },
  );
  assert.ok(!('distanceM' in context.sessions[0]));
  assert.ok(!('avgHr' in context.sessions[1]));
  assert.ok(!('strain' in context.sessions[1]));
  assert.ok(!('zonesSec' in context.sessions[1]));
  assert.ok(!('hrSeries' in context.sessions[0]));
  assert.ok(!('running' in context.sessions[0]));
});

test('buildWorkoutDevicesContext: an empty running block is omitted entirely', () => {
  const context = buildWorkoutDevicesContext(
    { source: 'healthkit', payload: { durationMin: 30, running: {} } },
    { source: 'whoop', payload: {} },
  );
  assert.ok(!('running' in context.sessions[0]));
});

test('buildSleepDevicesContext: both sources present -> primary first with stages', () => {
  const context = buildSleepDevicesContext(
    { source: 'whoop', payload: { minutes: 430, stages: { core: 200, deep: 80, rem: 120, awake: 30 } } },
    { source: 'healthkit', payload: { minutes: 425, stages: { core: 210, deep: 75, rem: 110, awake: 25 } } },
  );
  assert.ok(context);
  assert.equal(context!.primary, 'whoop');
  assert.equal(context!.sessions[0].source, 'whoop');
  assert.equal(context!.sessions[0].minutes, 430);
  assert.deepEqual(context!.sessions[0].stages, { core: 200, deep: 80, rem: 120, awake: 30 });
  assert.equal(context!.sessions[1].source, 'apple');
  assert.equal(context!.sessions[1].minutes, 425);
});

test('buildSleepDevicesContext: no stages is fine, minutes alone is enough', () => {
  const context = buildSleepDevicesContext(
    { source: 'healthkit', payload: { minutes: 400 } },
    { source: 'whoop', payload: { minutes: 410 } },
  );
  assert.ok(context);
  assert.ok(!('stages' in context!.sessions[0]));
});

test('buildSleepDevicesContext: undefined when either side has no real minutes figure', () => {
  assert.equal(buildSleepDevicesContext(
    { source: 'healthkit', payload: { minutes: 400 } },
    { source: 'whoop', payload: {} },
  ), undefined);
  assert.equal(buildSleepDevicesContext(
    { source: 'healthkit', payload: {} },
    { source: 'whoop', payload: { minutes: 400 } },
  ), undefined);
});
