/**
 * NULL-DATA CANARY — the most important test in the insight engine.
 *
 * Runs the complete battery over synthetic users whose data contains no real
 * pattern by construction (seeded random walks), and asserts that almost
 * nothing survives the evidence gate.
 *
 * If this test starts failing, the engine has begun inventing patterns. Fix the
 * engine. DO NOT relax the assertion — an engine that reports findings from
 * noise is worse than no engine, because its users cannot tell the difference.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectCadenceBreak, detectCrossLag, detectDayOfWeek, detectLevelShift, detectTrend,
  INPUT_METRICS, OUTCOME_METRICS,
} from './detectors';
import { applyEvidenceGate } from './evidence';
import type { MetricSeries } from './types';

/** Deterministic PRNG (mulberry32) — a flaky canary gets muted, and a muted canary protects nothing. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 90-day random walk with no trend, no shift, and no cross-metric structure. */
function randomWalk(metric: string, random: () => number): MetricSeries {
  const points = [];
  let value = 50;
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let daysAgo = 89; daysAgo >= 0; daysAgo -= 1) {
    value += (random() - 0.5) * 4;
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    points.push({ date: d.toISOString().slice(0, 10), value });
  }
  return { metric, points };
}

const ALL_METRICS = [...INPUT_METRICS, ...OUTCOME_METRICS];
const established = new Set(ALL_METRICS);

test('the full battery reports almost nothing on pure noise', () => {
  const USERS = 40;
  let usersWithAnyFinding = 0;
  let totalFindings = 0;

  for (let user = 0; user < USERS; user += 1) {
    const random = makeRandom(1000 + user);
    const byMetric = new Map(ALL_METRICS.map((m) => [m, randomWalk(m, random)]));

    const candidates = [
      ...detectCrossLag(
        INPUT_METRICS.map((m) => byMetric.get(m)!),
        OUTCOME_METRICS.map((m) => byMetric.get(m)!),
      ),
    ];
    for (const metric of ALL_METRICS) {
      const series = byMetric.get(metric)!;
      const shift = detectLevelShift(series); if (shift) candidates.push(shift);
      const trend = detectTrend(series);      if (trend) candidates.push(trend);
      const dow = detectDayOfWeek(series);    if (dow) candidates.push(dow);
      const cadence = detectCadenceBreak(series); if (cadence) candidates.push(cadence);
    }

    const certified = applyEvidenceGate(candidates, established);
    if (certified.length > 0) usersWithAnyFinding += 1;
    totalFindings += certified.length;
  }

  // A random walk genuinely drifts, so a small number of level_shift/trend
  // findings are real statements about that walk and are not failures. What
  // must NOT happen is the engine finding something for most users.
  assert.ok(
    usersWithAnyFinding / USERS < 0.35,
    `engine spoke for ${usersWithAnyFinding}/${USERS} pure-noise users (${totalFindings} findings) — it is inventing patterns`,
  );
});

test('the cross-lag sweep in particular finds almost nothing on noise', () => {
  const USERS = 40;
  let crossLagFindings = 0;

  for (let user = 0; user < USERS; user += 1) {
    const random = makeRandom(7000 + user);
    const inputs = INPUT_METRICS.map((m) => randomWalk(m, random));
    const outcomes = OUTCOME_METRICS.map((m) => randomWalk(m, random));
    crossLagFindings += applyEvidenceGate(detectCrossLag(inputs, outcomes), established).length;
  }

  // This is the sweep that would confabulate hardest without BH control:
  // ~150 hypotheses per user, ~6000 across the batch.
  assert.ok(
    crossLagFindings / USERS < 0.5,
    `cross-lag produced ${crossLagFindings} findings across ${USERS} noise users — the FDR correction is not holding`,
  );
});

test('the battery still finds a genuinely planted effect', () => {
  // The canary must not pass merely because the engine is mute.
  const random = makeRandom(42);
  const strain = randomWalk('whoop_day_strain', random);
  const recovery: MetricSeries = {
    metric: 'whoop_recovery',
    points: strain.points.map((point, index) => ({
      date: point.date,
      value: index === 0 ? 70 : 100 - (strain.points[index - 1].value as number),
    })),
  };

  const certified = applyEvidenceGate(detectCrossLag([strain], [recovery]), established);
  assert.ok(certified.length > 0, 'planted cross-lag effect was not detected — the engine is mute, not safe');
});

test('the battery finds a MODERATE, realistic effect buried in noise', () => {
  // The test above plants a near-perfect relationship (rho ~ -1), which no real
  // health data ever shows. This is the power test: after the autocorrelation
  // correction the null battery certifies exactly 0 of 4375, and an engine that
  // only speaks for perfect relationships is the "statistically impeccable and
  // permanently silent" failure the spec warns about. A real coaching signal —
  // yesterday's training load explaining roughly half the variance in today's
  // recovery, on top of genuine day-to-day noise — must survive.
  const random = makeRandom(4242);
  const strain = randomWalk('whoop_day_strain', random);

  const recovery: MetricSeries = {
    metric: 'whoop_recovery',
    points: strain.points.map((point, index) => ({
      date: point.date,
      // Noise amplitude 15 (uniform, sd 4.33) is chosen to MATCH the signal's
      // sd, giving R^2 ~ 0.5 and |rho| ~ 0.7. An earlier version used 40
      // (sd 11.55), which claimed R^2 ~ 0.5 in its comment but actually planted
      // R^2 ~ 0.12 — the finding then died at the 0.35 rho floor and the test
      // looked like an over-correction failure when it was a bad fixture.
      value: index === 0
        ? 70
        : 70 - 0.7 * (strain.points[index - 1].value as number) + (random() - 0.5) * 15,
    })),
  };

  const certified = applyEvidenceGate(detectCrossLag([strain], [recovery]), established);
  assert.ok(
    certified.length > 0,
    'a moderate real effect was not detected — the correction is over-conservative and the engine cannot do its job',
  );
});
