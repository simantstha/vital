import {
  mean,
  sd,
  olsSlope,
  studentTTwoSidedP,
  spearman,
  kruskalWallisSevenGroups,
  lag1Autocorrelation,
  effectiveSampleSize,
  effectiveSampleSizePair,
} from './stats';
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

  // Welch t-test on the two means, with degrees of freedom corrected for serial
  // dependence. `r` is estimated once over the whole window because the 7-day
  // recent slice is too short to estimate it on its own; see effectiveSampleSize.
  const r = lag1Autocorrelation([...baseline, ...recent]);
  const nRecentEff = effectiveSampleSize(recent.length, r);
  const nBaselineEff = effectiveSampleSize(baseline.length, r);

  const varRecent = sd(recent) ** 2 / nRecentEff;
  const varBaseline = baselineSd ** 2 / nBaselineEff;
  const denominator = Math.sqrt(varRecent + varBaseline);
  if (denominator === 0) return null;

  const t = (recentMean - baselineMean) / denominator;
  const df =
    (varRecent + varBaseline) ** 2 /
    (varRecent ** 2 / Math.max(1, nRecentEff - 1) + varBaseline ** 2 / Math.max(1, nBaselineEff - 1));
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

  const { slope, pValue: rawP, n, t } = olsSlope(xs, ys);
  if (slope === 0) return null;

  // Ninety daily observations are not ninety independent ones; see
  // effectiveSampleSize. Without this, regressing an autocorrelated series on
  // time produces spuriously significant slopes (the classic spurious
  // regression), which is what made the null-data canary certify 79% of noise.
  const nEff = effectiveSampleSize(n, lag1Autocorrelation(ys));
  const pValue = t === 0 ? rawP : studentTTwoSidedP(t, Math.max(1, nEff - 2));

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

/**
 * What the user did. Paired against OUTCOME_METRICS only — see the spec section
 * "Why crossLag is directional, not a blind sweep". Widening these lists
 * enlarges the hypothesis family and costs statistical power; do not extend
 * them without redoing that argument.
 */
export const INPUT_METRICS = [
  'whoop_day_strain', 'steps', 'exercise_min', 'distance_m', 'active_energy_kcal',
  'dietary_energy_kcal', 'dietary_protein_g', 'dietary_carbs_g', 'dietary_fat_g',
];

/** How the body responded. */
export const OUTCOME_METRICS = [
  'hrv_sdnn', 'whoop_hrv_rmssd', 'resting_hr', 'whoop_resting_hr',
  'whoop_recovery', 'sleep_minutes', 'whoop_sleep_min', 'whoop_spo2', 'whoop_skin_temp',
];

const CROSS_LAGS = [0, 1];
const MIN_PAIRS = 30;
export const MIN_ABS_RHO = 0.35;

const MIN_WEEKS_FOR_DAY_OF_WEEK = 8;

/**
 * Correlates each input on day d with each outcome on day d+lag.
 *
 * Pairs are joined BY DATE, never by array index — a gap in either series must
 * not silently shift the alignment and manufacture a relationship.
 *
 * Returns raw candidates; the effect floor and FDR correction are applied in
 * evidence.ts, not here.
 */
export function detectCrossLag(inputs: MetricSeries[], outcomes: MetricSeries[]): Finding[] {
  const findings: Finding[] = [];

  const indexOf = (series: MetricSeries): Map<string, number> => {
    const map = new Map<string, number>();
    for (const point of series.points) if (point.value !== null) map.set(point.date, point.value);
    return map;
  };

  const shiftDate = (date: string, days: number): string => {
    const [y, m, d] = date.split('-').map(Number);
    const shifted = new Date(Date.UTC(y, m - 1, d));
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };

  for (const input of inputs) {
    const inputByDate = indexOf(input);
    if (inputByDate.size < MIN_PAIRS) continue;

    for (const outcome of outcomes) {
      const outcomeByDate = indexOf(outcome);
      if (outcomeByDate.size < MIN_PAIRS) continue;

      for (const lag of CROSS_LAGS) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [date, inputValue] of inputByDate) {
          const outcomeValue = outcomeByDate.get(shiftDate(date, lag));
          if (outcomeValue === undefined) continue;
          xs.push(inputValue);
          ys.push(outcomeValue);
        }
        if (xs.length < MIN_PAIRS) continue;

        // Every pair we could test is a hypothesis and MUST be emitted, even
        // when rho is tiny. Dropping unimpressive pairs here would shrink the
        // family size m that evidence.ts corrects over — and because |rho| and
        // the p-value move together, that selection makes Benjamini-Hochberg
        // anti-conservative. The MIN_PAIRS check above is different in kind: a
        // pair with too little overlap was never testable, so it is genuinely
        // not part of the family.
        const { rho, n } = spearman(xs, ys);
        const nEff = effectiveSampleSizePair(n, lag1Autocorrelation(xs), lag1Autocorrelation(ys));
        const pValue = Math.abs(rho) >= 1
          ? 0
          : studentTTwoSidedP(rho * Math.sqrt((nEff - 2) / (1 - rho * rho)), Math.max(1, nEff - 2));

        const direction = rho < 0 ? 'down' : 'up';
        findings.push({
          kind: 'cross_lag',
          signature: `cross_lag:${input.metric}:${outcome.metric}:${lag}:${direction}`,
          metrics: [input.metric, outcome.metric],
          effect: rho,
          effectLabel: `${direction === 'down' ? 'inverse' : 'positive'} (rho ${rho.toFixed(2)})`,
          n,
          pValue,
          detail: { lag, rho: Number(rho.toFixed(3)), pairs: n, input: input.metric, outcome: outcome.metric },
        });
      }
    }
  }

  return findings;
}

/**
 * Kruskal–Wallis across the seven weekdays. Requires all seven represented
 * (which fixes df at 6 — see stats.ts) and at least 8 weeks of coverage.
 */
export function detectDayOfWeek(series: MetricSeries): Finding | null {
  const groups: number[][] = Array.from({ length: 7 }, () => []);
  let observed = 0;

  for (const point of series.points) {
    if (point.value === null) continue;
    const [y, m, d] = point.date.split('-').map(Number);
    groups[new Date(Date.UTC(y, m - 1, d)).getUTCDay()].push(point.value);
    observed += 1;
  }

  if (observed < MIN_WEEKS_FOR_DAY_OF_WEEK * 7) return null;
  if (groups.some((group) => group.length === 0)) return null;

  const { h, pValue, n } = kruskalWallisSevenGroups(groups);
  if (h === 0) return null;

  const dayMeans = groups.map((group) => group.reduce((a, b) => a + b, 0) / group.length);
  const highest = dayMeans.indexOf(Math.max(...dayMeans));
  const lowest = dayMeans.indexOf(Math.min(...dayMeans));
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    kind: 'day_of_week',
    signature: `day_of_week:${series.metric}`,
    metrics: [series.metric],
    effect: dayMeans[highest] - dayMeans[lowest],
    effectLabel: `${names[lowest]} lowest, ${names[highest]} highest`,
    n,
    pValue,
    detail: {
      highestDay: names[highest],
      lowestDay: names[lowest],
      highestMean: Number(dayMeans[highest].toFixed(1)),
      lowestMean: Number(dayMeans[lowest].toFixed(1)),
    },
  };
}
