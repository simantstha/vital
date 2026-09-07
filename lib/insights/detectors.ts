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
