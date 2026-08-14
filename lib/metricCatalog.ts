/**
 * Vital — metric catalog (pure, no DB or Next.js imports).
 *
 * Single source of truth for storage→display unit conversion across every
 * raw `daily_metrics` metric name (`daily_metrics.metric` — the same
 * vocabulary as `baselines.metric`). Every conversion is expressed as a pure
 * multiplicative `scale`, deliberately **never** an additive offset: under
 * `y = k·x`, `stddev(y) = k·stddev(x)` exactly, so scaling a baseline's
 * `sd30` is provably correct. An additive offset would break that identity
 * and was the root cause of a since-fixed 60×-sleep-band bug — see
 * lib/trendsResponse.ts and lib/metricCatalog.test.ts's "no offset key" test.
 *
 * Metric universe (19 raw names): the 11 `SCALAR_METRICS` from
 * app/api/ingest/daily/route.ts, `sleep_minutes` (a separate HealthKit
 * ingest path, see db/schema.ts:250), and the 7 `whoop_*` names from
 * lib/whoop/mapping.ts.
 *
 * Two call sites derive from this catalog instead of hand-rolling unit maps:
 *  - app/api/trends/route.ts (`toDisplay` replaces the old inline `transform()`)
 *  - lib/brain/coachViz.ts (re-derives its private METRIC_META from here,
 *    using `storageUnit` — coachViz never converts values, only labels them)
 */

import type { BaselineStats } from './brain/baselines';

export type MetricSource = 'healthkit' | 'whoop';

export interface MetricSpec {
  label: string;
  storageUnit: string;
  displayUnit: string;
  /** Multiplicative storage→display factor. Never pair with an additive offset. */
  scale: number;
  decimals: number;
  source: MetricSource;
}

export const METRIC_CATALOG: Record<string, MetricSpec> = {
  // HealthKit — scalar (app/api/ingest/daily/route.ts:42-54 SCALAR_METRICS)
  hrv_sdnn:           { label: 'HRV',              storageUnit: 'ms',        displayUnit: 'ms',       scale: 1,      decimals: 0, source: 'healthkit' },
  resting_hr:         { label: 'Resting HR',       storageUnit: 'bpm',       displayUnit: 'bpm',      scale: 1,      decimals: 0, source: 'healthkit' },
  hr_avg:             { label: 'Avg HR',           storageUnit: 'bpm',       displayUnit: 'bpm',      scale: 1,      decimals: 0, source: 'healthkit' },
  steps:              { label: 'Steps',            storageUnit: 'count',     displayUnit: 'count',    scale: 1,      decimals: 0, source: 'healthkit' },
  active_energy_kcal: { label: 'Active Energy',    storageUnit: 'kcal',      displayUnit: 'kcal',     scale: 1,      decimals: 0, source: 'healthkit' },
  body_mass_kg:       { label: 'Weight',           storageUnit: 'kg',        displayUnit: 'kg',       scale: 1,      decimals: 1, source: 'healthkit' },
  vo2_max:            { label: 'VO2 Max',          storageUnit: 'ml/kg/min', displayUnit: 'ml/kg/min',scale: 1,      decimals: 1, source: 'healthkit' },
  distance_m:         { label: 'Distance',         storageUnit: 'm',         displayUnit: 'km',       scale: 1 / 1000, decimals: 2, source: 'healthkit' },
  exercise_min:       { label: 'Exercise Minutes', storageUnit: 'min',       displayUnit: 'min',      scale: 1,      decimals: 0, source: 'healthkit' },
  flights:            { label: 'Flights Climbed',  storageUnit: 'count',     displayUnit: 'count',    scale: 1,      decimals: 0, source: 'healthkit' },
  basal_energy_kcal:  { label: 'Basal Energy',     storageUnit: 'kcal',      displayUnit: 'kcal',     scale: 1,      decimals: 0, source: 'healthkit' },

  // HealthKit — sleep (db/schema.ts:250; not in SCALAR_METRICS, its own ingest path)
  sleep_minutes:      { label: 'Sleep',            storageUnit: 'min',       displayUnit: 'h',        scale: 1 / 60, decimals: 1, source: 'healthkit' },

  // WHOOP (lib/whoop/mapping.ts:76-119)
  whoop_day_strain:   { label: 'Strain',             storageUnit: 'strain', displayUnit: 'strain', scale: 1, decimals: 1, source: 'whoop' },
  whoop_recovery:     { label: 'Recovery',           storageUnit: '%',      displayUnit: '%',      scale: 1, decimals: 0, source: 'whoop' },
  whoop_hrv_rmssd:    { label: 'HRV (WHOOP)',        storageUnit: 'ms',     displayUnit: 'ms',     scale: 1, decimals: 0, source: 'whoop' },
  whoop_resting_hr:   { label: 'Resting HR (WHOOP)', storageUnit: 'bpm',    displayUnit: 'bpm',    scale: 1, decimals: 0, source: 'whoop' },
  whoop_spo2:         { label: 'Blood Oxygen',       storageUnit: '%',      displayUnit: '%',      scale: 1, decimals: 1, source: 'whoop' },
  whoop_skin_temp:    { label: 'Skin Temp',          storageUnit: '°C',     displayUnit: '°C',     scale: 1, decimals: 1, source: 'whoop' },
  whoop_sleep_min:    { label: 'Sleep (WHOOP)',      storageUnit: 'min',    displayUnit: 'min',    scale: 1, decimals: 0, source: 'whoop' },
};

/**
 * Converts one raw storage-unit value to its rounded display-unit value.
 * Throws on an unknown metric — callers (lib/trendsResponse.ts) are expected
 * to filter requested metrics against METRIC_CATALOG first and report
 * unknowns separately, never call toDisplay with one.
 */
export function toDisplay(metric: string, value: number): number {
  const spec = METRIC_CATALOG[metric];
  if (!spec) throw new Error(`toDisplay: unknown metric "${metric}"`);
  const factor = 10 ** spec.decimals;
  return Math.round(value * spec.scale * factor) / factor;
}

/**
 * Converts every independently-nullable field of a BaselineStats snapshot to
 * display units. Safe for `sd30` specifically because scale is a pure
 * multiply: stddev(k·x) = k·stddev(x) exactly, with no additive term to
 * distort it.
 */
export function toDisplayStats(metric: string, stats: BaselineStats): BaselineStats {
  const conv = (v: number | null): number | null => (v == null ? null : toDisplay(metric, v));
  return {
    mean7:  conv(stats.mean7),
    mean30: conv(stats.mean30),
    mean60: conv(stats.mean60),
    sd30:   conv(stats.sd30),
    p25:    conv(stats.p25),
    p50:    conv(stats.p50),
    p75:    conv(stats.p75),
  };
}
