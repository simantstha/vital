import { mean, sd, olsSlope, studentTTwoSidedP } from './stats';
import type { Finding, MetricSeries } from './types';

/** Metrics whose rhythm is meaningful enough that breaking it is worth saying. */
export const CADENCE_METRICS = ['exercise_min', 'active_energy_kcal', 'whoop_day_strain'];

const CADENCE_WINDOW_DAYS = 28;
const MIN_SESSIONS_PER_WEEK = 3;
const MIN_SILENT_DAYS = 3;

/**
 * Fires when an established rhythm has gone quiet.
 *
 * This is a rule about a known cadence, not a hypothesis test, so it reports
 * `pValue: null` and is excluded from the FDR family — forcing it through a
 * multiple-comparisons correction would be statistical theater.
 *
 * A day counts as active when its value is > 0. A null (no data) and a
 * recorded 0 both fail to count, which is correct: neither is a session.
 */
export function detectCadenceBreak(series: MetricSeries): Finding | null {
  const points = series.points;
  if (points.length === 0) return null;

  const isActive = (index: number): boolean => {
    const value = points[index].value;
    return value !== null && value > 0;
  };

  // Days since the most recent active day, counting back from the last point.
  let daysSinceLast = -1;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (isActive(i)) { daysSinceLast = points.length - 1 - i; break; }
  }
  if (daysSinceLast < 0) return null;           // never active — nothing to break
  if (daysSinceLast < MIN_SILENT_DAYS) return null;

  // Establish the cadence from the 28 days BEFORE the silence began, so the
  // silence itself doesn't drag the rate down and mask the break.
  const lastActiveIndex = points.length - 1 - daysSinceLast;
  const windowStart = Math.max(0, lastActiveIndex - CADENCE_WINDOW_DAYS + 1);
  let activeDays = 0;
  for (let i = windowStart; i <= lastActiveIndex; i += 1) if (isActive(i)) activeDays += 1;

  const observedDays = lastActiveIndex - windowStart + 1;
  if (observedDays < CADENCE_WINDOW_DAYS) return null;   // not enough history to call it established

  const perWeek = (activeDays / observedDays) * 7;
  if (perWeek < MIN_SESSIONS_PER_WEEK) return null;

  const expectedGap = Math.ceil(7 / perWeek);
  const threshold = Math.max(MIN_SILENT_DAYS, 2 * expectedGap);
  if (daysSinceLast < threshold) return null;

  return {
    kind: 'cadence_break',
    signature: `cadence_break:${series.metric}`,
    metrics: [series.metric],
    effect: daysSinceLast,
    effectLabel: `${daysSinceLast} days since the last session`,
    n: observedDays,
    pValue: null,
    detail: {
      daysSinceLast,
      sessionsPerWeek: Number(perWeek.toFixed(1)),
      windowDays: observedDays,
    },
  };
}

const RECENT_DAYS = 7;
const BASELINE_DAYS = 28;
const MIN_RECENT_OBS = 7;
const MIN_BASELINE_OBS = 21;

const TREND_DAYS = 28;
const MIN_TREND_OBS = 20;

/** Observed (non-null) values from the last `count` points. */
function tailValues(series: MetricSeries, count: number, skip = 0): number[] {
  const end = series.points.length - skip;
  const start = Math.max(0, end - count);
  const out: number[] = [];
  for (let i = start; i < end; i += 1) {
    const value = series.points[i].value;
    if (value !== null) out.push(value);
  }
  return out;
}

/**
 * Compares the last 7 days against the preceding 28, in units of the user's own
 * baseline SD. Expressing the change in personal SD is the point: 10 bpm means
 * something different for a steady resting heart rate than a volatile one.
 */
export function detectLevelShift(series: MetricSeries): Finding | null {
  const recent = tailValues(series, RECENT_DAYS);
  const baseline = tailValues(series, BASELINE_DAYS, RECENT_DAYS);
  if (recent.length < MIN_RECENT_OBS || baseline.length < MIN_BASELINE_OBS) return null;

  const baselineSd = sd(baseline);
  if (baselineSd === 0) return null;    // no variation: any change would read as infinite

  const recentMean = mean(recent);
  const baselineMean = mean(baseline);
  const effect = (recentMean - baselineMean) / baselineSd;

  // Welch t-test on the two means.
  const varRecent = sd(recent) ** 2 / recent.length;
  const varBaseline = baselineSd ** 2 / baseline.length;
  const denominator = Math.sqrt(varRecent + varBaseline);
  if (denominator === 0) return null;

  const t = (recentMean - baselineMean) / denominator;
  const df =
    (varRecent + varBaseline) ** 2 /
    (varRecent ** 2 / (recent.length - 1) + varBaseline ** 2 / (baseline.length - 1));
  const pValue = studentTTwoSidedP(t, Math.max(1, df));

  const direction = effect < 0 ? 'down' : 'up';
  return {
    kind: 'level_shift',
    signature: `level_shift:${series.metric}:${direction}`,
    metrics: [series.metric],
    effect,
    effectLabel: `${Math.abs(effect).toFixed(1)} SD ${direction === 'down' ? 'below' : 'above'} baseline`,
    n: recent.length + baseline.length,
    pValue,
    detail: {
      recentMean: Number(recentMean.toFixed(2)),
      baselineMean: Number(baselineMean.toFixed(2)),
      recentDays: recent.length,
      baselineDays: baseline.length,
    },
  };
}

/** Ordinary least squares slope over the last 28 days, with a t-test on the slope. */
export function detectTrend(series: MetricSeries): Finding | null {
  const window = series.points.slice(Math.max(0, series.points.length - TREND_DAYS));
  const xs: number[] = [];
  const ys: number[] = [];
  window.forEach((point, index) => {
    if (point.value !== null) { xs.push(index); ys.push(point.value); }
  });
  if (xs.length < MIN_TREND_OBS) return null;

  const { slope, pValue, n } = olsSlope(xs, ys);
  if (slope === 0) return null;

  const direction = slope < 0 ? 'down' : 'up';
  return {
    kind: 'trend',
    signature: `trend:${series.metric}:${direction}`,
    metrics: [series.metric],
    effect: slope,
    effectLabel: `${slope > 0 ? '+' : ''}${(slope * 7).toFixed(1)} per week`,
    n,
    pValue,
    detail: {
      slopePerDay: Number(slope.toFixed(4)),
      slopePerWeek: Number((slope * 7).toFixed(2)),
      observedDays: n,
    },
  };
}
