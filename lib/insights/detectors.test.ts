import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectCadenceBreak,
  detectCrossLag,
  detectDayOfWeek,
  detectLevelShift,
  detectTrend,
  INPUT_METRICS,
  OUTCOME_METRICS,
} from './detectors';
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

/** 90-day series from a generator over day index 0..89 (89 = most recent). */
function generated(metric: string, fn: (daysAgo: number) => number | null): MetricSeries {
  const points = [];
  const end = new Date(Date.UTC(2026, 8, 7));
  for (let daysAgo = 89; daysAgo >= 0; daysAgo -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    points.push({ date: d.toISOString().slice(0, 10), value: fn(daysAgo) });
  }
  return { metric, points };
}

test('level shift finds a planted drop in the last week', () => {
  const finding = detectLevelShift(generated('hrv_sdnn', (daysAgo) => {
    const wobble = (daysAgo % 5) - 2;              // small deterministic variation
    return daysAgo < 7 ? 40 + wobble : 60 + wobble;
  }));
  assert.ok(finding);
  assert.equal(finding.kind, 'level_shift');
  assert.ok(finding.effect < -1);                   // a drop, in SD units
  assert.equal(finding.signature, 'level_shift:hrv_sdnn:down');
  assert.ok(finding.pValue !== null && finding.pValue < 0.05);
});

test('level shift on a stable series yields only a small, unconvincing candidate', () => {
  // Detectors emit every hypothesis they TEST; they do not decide what is worth
  // saying. Gating happens in evidence.ts, which must correct over the full
  // family — so a stable series still produces a candidate, it just fails the
  // downstream floor. Pre-filtering here would shrink m and make the
  // false-discovery-rate correction anti-conservative.
  const finding = detectLevelShift(generated('hrv_sdnn', (daysAgo) => 60 + ((daysAgo % 5) - 2)));
  assert.ok(finding, 'expected a candidate, since the hypothesis was tested');
  assert.ok(Math.abs(finding.effect) < 0.8, 'effect must fail the downstream floor');
  assert.ok(finding.pValue !== null && finding.pValue > 0.05);
});

test('level shift stays quiet when the baseline has no variation', () => {
  // sd = 0 would make any change infinitely large; report nothing instead.
  assert.equal(detectLevelShift(generated('hrv_sdnn', (daysAgo) => (daysAgo < 7 ? 40 : 60))), null);
});

test('level shift stays quiet with too few recent days', () => {
  assert.equal(
    detectLevelShift(generated('hrv_sdnn', (daysAgo) => (daysAgo < 7 ? null : 60 + ((daysAgo % 5) - 2)))),
    null,
  );
});

test('trend finds a planted decline and reports its direction', () => {
  const finding = detectTrend(generated('sleep_minutes', (daysAgo) => 420 - (27 - Math.min(daysAgo, 27)) * 4));
  assert.ok(finding);
  assert.equal(finding.kind, 'trend');
  assert.ok(finding.effect < 0);
  assert.equal(finding.signature, 'trend:sleep_minutes:down');
});

test('trend stays quiet on a flat series', () => {
  assert.equal(detectTrend(generated('sleep_minutes', () => 420)), null);
});

test('trend stays quiet with too few observed days in the window', () => {
  assert.equal(
    detectTrend(generated('sleep_minutes', (daysAgo) => (daysAgo % 3 === 0 ? 420 - daysAgo : null))),
    null,
  );
});

test('input and outcome metric sets are disjoint and non-empty', () => {
  assert.ok(INPUT_METRICS.length > 0 && OUTCOME_METRICS.length > 0);
  const overlap = INPUT_METRICS.filter((m) => OUTCOME_METRICS.includes(m));
  assert.deepEqual(overlap, []);
});

test('cross-lag finds a planted next-day relationship', () => {
  // Strain on day d drives recovery DOWN on day d+1.
  const strain = generated('whoop_day_strain', (daysAgo) => 5 + (daysAgo % 10));
  const recovery = generated('whoop_recovery', (daysAgo) => {
    const yesterdayStrain = 5 + ((daysAgo + 1) % 10);
    return 90 - yesterdayStrain * 3;
  });

  const findings = detectCrossLag([strain], [recovery]);
  const lagOne = findings.find((f) => f.detail.lag === 1);
  assert.ok(lagOne, 'expected a lag-1 finding');
  assert.equal(lagOne.kind, 'cross_lag');
  assert.ok(lagOne.effect < -0.9);
  assert.equal(lagOne.signature, 'cross_lag:whoop_day_strain:whoop_recovery:1:down');
});

test('cross-lag finds nothing convincing in unrelated series', () => {
  // Candidates are still emitted (they are tested hypotheses and must count
  // toward m); none of them should clear the magnitude the gate demands.
  const strain = generated('whoop_day_strain', (daysAgo) => 5 + (daysAgo % 10));
  const recovery = generated('whoop_recovery', (daysAgo) => 60 + ((daysAgo * 7) % 11));
  const findings = detectCrossLag([strain], [recovery]);
  assert.ok(findings.length > 0, 'tested pairs must be emitted even when unimpressive');
  assert.deepEqual(findings.filter((f) => Math.abs(f.effect) >= 0.35), []);
});

test('cross-lag skips pairs with too few overlapping observations', () => {
  const sparse = generated('whoop_day_strain', (daysAgo) => (daysAgo < 80 ? null : 10));
  const recovery = generated('whoop_recovery', () => 60);
  assert.deepEqual(detectCrossLag([sparse], [recovery]), []);
});

test('cross-lag pairs values by date, not by array position', () => {
  // One missing input day (daysAgo=40) must not shift the outcome alignment.
  // Date-joining gives exactly 89 pairs at lag 0 (90 days less the gap) and 88
  // at lag 1 (the gap, plus the final day whose D+1 falls outside the window).
  // An index-join would yield 89 at both lags while silently correlating
  // mismatched days — which is precisely how a detector manufactures a
  // relationship that does not exist. Assert the counts, not just a bound.
  const input = generated('steps', (daysAgo) => (daysAgo === 40 ? null : 8000 + (daysAgo % 7) * 500));
  const outcome = generated('sleep_minutes', (daysAgo) => 400 + ((daysAgo % 7) * 500) / 100);
  const findings = detectCrossLag([input], [outcome]);
  assert.equal(findings.find((f) => f.detail.lag === 0)?.n, 89);
  assert.equal(findings.find((f) => f.detail.lag === 1)?.n, 88);
});

test('day-of-week finds a planted weekend effect', () => {
  // 2026-09-07 is a Monday; weekends get markedly less sleep.
  const finding = detectDayOfWeek(generated('sleep_minutes', (daysAgo) => {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    return (weekend ? 300 : 450) + (daysAgo % 4);
  }));
  assert.ok(finding);
  assert.equal(finding.kind, 'day_of_week');
  assert.equal(finding.signature, 'day_of_week:sleep_minutes');
});

test('day-of-week finds nothing convincing when every weekday looks the same', () => {
  // The 4-day value cycle and the 7-day week have lcm 28 across a 90-day
  // window, so weekday means genuinely differ by a hair. The hypothesis was
  // testable and was tested, so a candidate is emitted and counts toward m —
  // it simply has no support behind it.
  const finding = detectDayOfWeek(generated('sleep_minutes', (daysAgo) => 420 + (daysAgo % 4)));
  assert.ok(finding, 'expected a candidate, since the hypothesis was tested');
  assert.ok(finding.pValue !== null && finding.pValue > 0.2);
});

test('day-of-week stays quiet without all seven weekdays covered', () => {
  const finding = detectDayOfWeek(generated('sleep_minutes', (daysAgo) => {
    const d = new Date(Date.UTC(2026, 8, 7));
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.getUTCDay() === 3 ? null : 420 + (daysAgo % 4);
  }));
  assert.equal(finding, null);
});
