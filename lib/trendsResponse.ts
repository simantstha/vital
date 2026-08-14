/**
 * Vital — Trends batch response assembler (pure, no DB or Next.js imports).
 *
 * Shapes the `GET /api/trends?metrics=...` response from already-fetched
 * rows: multi-metric points (queryMetricPointsMulti), all baseline rows
 * (queryAllBaselines — reused, not re-queried), fresh per-metric data-day
 * counts (queryMetricDataDays), and an optional manual-weight overlay
 * (readWeightLog, `body_mass_kg` only). app/api/trends/route.ts stays a thin
 * adapter: it fetches these four inputs (one query each) and calls
 * buildTrendsBatch() — every unit conversion, null-handling, and dedup rule
 * lives here and is covered by lib/trendsResponse.test.ts with no
 * DATABASE_URL required.
 *
 * Contract (see docs/plans trends-revamp spec, "Backend (PR 1)"):
 *  - Keys are raw `daily_metrics.metric` names — one vocabulary across
 *    `daily_metrics`, `baselines`, and lib/metricCatalog.ts.
 *  - Every requested-and-known metric gets a key even with zero points —
 *    `points: []` is meaningfully different from an absent key.
 *  - Unknown metric names are dropped from `series` and echoed in
 *    `unknownMetrics` — never a 400 (a newer client asking for an unknown
 *    metric loses a tile, not the whole screen).
 *  - `baseline` may be null; each stat field is independently nullable
 *    (`sd30` is null for a single day of data — stddev_samp of one row).
 *  - `established` is recomputed here from the fresh `dataDays` passed in,
 *    deliberately overriding any stale `baselines.established` snapshot —
 *    same rationale as getCalibration() (lib/brain/baselines.ts:130-133):
 *    the snapshot only refreshes on recomputeBaselines() and can lag a
 *    backfill.
 *  - No verdict, no direction, no "above/below" string. Server ships
 *    numbers; the client ships judgment.
 */

import { METRIC_CATALOG, toDisplay, toDisplayStats } from './metricCatalog';
import type { BaselineStats } from './brain/baselines';
import type { MetricPointRow, MetricDataDaysRow, BaselineSnapshot } from './brain/tools';

// Must match lib/brain/baselines.ts's ESTABLISHED_MIN_DAYS. Duplicated
// (rather than imported) so this module stays DB-free: lib/brain/baselines.ts
// imports `@/db`, which throws at module load without DATABASE_URL set.
const ESTABLISHED_MIN_DAYS = 14;

export interface TrendsSeriesPoint {
  date: string;
  value: number;
}

export interface TrendsSeriesEntry {
  metric: string;
  label: string;
  unit: string;
  points: TrendsSeriesPoint[];
  baseline: BaselineStats | null;
  dataDays: number;
  established: boolean;
  lastDate: string | null;
}

export interface TrendsBatchInput {
  /** Raw daily_metrics metric names, already deduped/capped by the route. */
  requested: string[];
  points: MetricPointRow[];
  /** All of the user's baseline rows (queryAllBaselines) — filtered here by metric. */
  baselines: BaselineSnapshot[];
  dayCounts: MetricDataDaysRow[];
  /** date (YYYY-MM-DD) → kg overlay for `body_mass_kg` only; manual wins per day. */
  manualWeight?: Map<string, number>;
}

export interface TrendsBatchResult {
  series: Record<string, TrendsSeriesEntry>;
  unknownMetrics: string[];
}

export function buildTrendsBatch(input: TrendsBatchInput): TrendsBatchResult {
  const { requested, points, baselines, dayCounts, manualWeight } = input;

  const pointsByMetric = new Map<string, TrendsSeriesPoint[]>();
  for (const p of points) {
    if (!METRIC_CATALOG[p.metric]) continue; // defensive; route/DB should never send an unknown metric here
    const list = pointsByMetric.get(p.metric) ?? [];
    list.push({ date: p.date, value: toDisplay(p.metric, p.value) });
    pointsByMetric.set(p.metric, list);
  }

  if (manualWeight && manualWeight.size > 0) {
    const byDate = new Map((pointsByMetric.get('body_mass_kg') ?? []).map((pt) => [pt.date, pt.value]));
    for (const [date, kg] of manualWeight) {
      byDate.set(date, toDisplay('body_mass_kg', kg)); // manual wins per day
    }
    pointsByMetric.set(
      'body_mass_kg',
      [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)),
    );
  }

  const baselineByMetric = new Map(baselines.map((b) => [b.metric, b]));
  const dayCountByMetric = new Map(dayCounts.map((d) => [d.metric, d]));

  const series: Record<string, TrendsSeriesEntry> = {};
  const unknownMetrics: string[] = [];
  const seen = new Set<string>();

  for (const metric of requested) {
    if (seen.has(metric)) continue;
    seen.add(metric);

    const spec = METRIC_CATALOG[metric];
    if (!spec) {
      unknownMetrics.push(metric);
      continue;
    }

    const pts = (pointsByMetric.get(metric) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const baselineRow = baselineByMetric.get(metric);
    const dayCount = dayCountByMetric.get(metric);
    const dataDays = dayCount?.dataDays ?? 0;

    series[metric] = {
      metric,
      label: spec.label,
      unit: spec.displayUnit,
      points: pts,
      baseline: baselineRow?.stats ? toDisplayStats(metric, baselineRow.stats) : null,
      dataDays,
      established: dataDays >= ESTABLISHED_MIN_DAYS,
      lastDate: dayCount?.lastDate ?? null,
    };
  }

  return { series, unknownMetrics };
}
