/**
 * Coach inline data-viz — normalizes the raw result of a data tool
 * (get_metric_trend / get_sleep_summary / compare_periods) into a compact,
 * client-renderable payload so the iOS chat can draw a mini chart / stat card
 * inline instead of only showing a "Checked your HRV trend" chip.
 *
 * Only these three tools produce a viz; everything else stays text-only.
 *
 * Unit conversion: the underlying data tools (lib/brain/tools.ts) always
 * return metric values (daily_metrics is stored metric). `buildCoachViz`
 * takes the caller's `UnitSystem` and converts `body_mass_kg` points/stats to
 * lb for imperial — display-only, the tool result and DB stay metric.
 */

import { LB_PER_KG } from '../metricFormat';
import type { UnitSystem } from '../units';
import { METRIC_CATALOG } from '../metricCatalog';

export type CoachViz =
  | {
      kind: 'trend';
      title: string;
      unit: string;
      points: { label: string; value: number }[];
      mean: number | null;
      baseline: number | null;
      deltaPct: number | null;
    }
  | {
      kind: 'sleep';
      title: string;
      points: { label: string; value: number }[];  // value = minutes
      meanMinutes: number | null;
      consistency: string;
    }
  | {
      kind: 'compare';
      title: string;
      unit: string;
      currentMean: number | null;
      previousMean: number | null;
      delta: number | null;
      deltaPct: number | null;
    };

/**
 * Metric metadata, unit-aware: `body_mass_kg` reports `unit: 'lb'` for an
 * imperial user. Derived from lib/metricCatalog.ts's METRIC_CATALOG — this
 * function uses each spec's **storageUnit**, not displayUnit, because
 * buildCoachViz's values are never scaled by lib/metricCatalog.ts's
 * `toDisplay()` (only `convertMetricValue()` above, which is a no-op except
 * for `body_mass_kg`/imperial); the label just needs to describe whatever
 * unit the value is actually in. `steps` keeps its historical empty-string
 * unit (label alone reads fine: "Steps · last 7 days") rather than the
 * catalog's `'count'`.
 */
function meta(metric: string, unitSystem: UnitSystem): { label: string; unit: string } {
  const spec = METRIC_CATALOG[metric];
  const base = spec
    ? { label: spec.label, unit: spec.storageUnit === 'count' ? '' : spec.storageUnit }
    : { label: metric, unit: '' };
  if (metric === 'body_mass_kg' && unitSystem === 'imperial') return { ...base, unit: 'lb' };
  return base;
}

/** Converts a raw metric value for display — only `body_mass_kg` under `imperial` actually converts; everything else passes through. Pure scalar (kg→lb), so it's safe to apply to deltas as well as absolute values. */
function convertMetricValue(metric: string, value: number, unitSystem: UnitSystem): number {
  if (metric === 'body_mass_kg' && unitSystem === 'imperial') return value * LB_PER_KG;
  return value;
}

/** Single-letter weekday label from an ISO 'YYYY-MM-DD' date. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getUTCDay()];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Build a CoachViz from a tool name + its (already JSON-parsed) result.
 * Returns null when the tool isn't chartable or has no data to show.
 * `unitSystem` (default 'metric') converts `body_mass_kg` points/stats to lb
 * for display — the tool result itself and the underlying DB stay metric.
 */
export function buildCoachViz(name: string, parsed: unknown, unitSystem: UnitSystem = 'metric'): CoachViz | null {
  if (parsed == null || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;

  if (name === 'get_metric_trend') {
    const metric = String(r.metric ?? '');
    const rawPoints = Array.isArray(r.points) ? r.points : [];
    const points = rawPoints
      .map((p) => {
        const o = p as Record<string, unknown>;
        const raw = num(o.value);
        const value = raw != null ? convertMetricValue(metric, raw, unitSystem) : null;
        return { label: dayLabel(String(o.date ?? '')), value };
      })
      .filter((p): p is { label: string; value: number } => p.value != null);
    if (points.length === 0) return null;

    const stats = (r.stats ?? {}) as Record<string, unknown>;
    const baselineObj = (r.baseline ?? null) as Record<string, unknown> | null;
    const rawMean = num(stats.mean);
    const mean = rawMean != null ? convertMetricValue(metric, rawMean, unitSystem) : null;
    const rawBaseline = baselineObj ? num(baselineObj.mean30) : null;
    const baseline = rawBaseline != null ? convertMetricValue(metric, rawBaseline, unitSystem) : null;
    const deltaPct =
      mean != null && baseline != null && baseline !== 0
        ? Math.round(((mean - baseline) / baseline) * 100)
        : null;
    const m = meta(metric, unitSystem);
    return {
      kind: 'trend',
      title: `${m.label} · last ${points.length} days`,
      unit: m.unit,
      points,
      mean: mean != null ? Math.round(mean) : null,
      baseline: baseline != null ? Math.round(baseline) : null,
      deltaPct,
    };
  }

  if (name === 'get_sleep_summary') {
    const nights = Array.isArray(r.nights) ? r.nights : [];
    const points = nights
      .map((n) => {
        const o = n as Record<string, unknown>;
        return { label: dayLabel(String(o.date ?? '')), value: num(o.minutes) };
      })
      .filter((p): p is { label: string; value: number } => p.value != null);
    if (points.length === 0) return null;
    return {
      kind: 'sleep',
      title: `Sleep · last ${points.length} nights`,
      points,
      meanMinutes: num(r.meanMinutes) != null ? Math.round(num(r.meanMinutes)!) : null,
      consistency: String(r.consistency ?? 'unknown'),
    };
  }

  if (name === 'compare_periods') {
    const metric = String(r.metric ?? '');
    const current = (r.current ?? {}) as Record<string, unknown>;
    const previous = (r.previous ?? {}) as Record<string, unknown>;
    const rawCurrentMean = num(current.mean);
    const rawPreviousMean = num(previous.mean);
    const currentMean = rawCurrentMean != null ? convertMetricValue(metric, rawCurrentMean, unitSystem) : null;
    const previousMean = rawPreviousMean != null ? convertMetricValue(metric, rawPreviousMean, unitSystem) : null;
    if (currentMean == null && previousMean == null) return null;
    const m = meta(metric, unitSystem);
    const rawDelta = num(r.delta);
    const delta = rawDelta != null ? convertMetricValue(metric, rawDelta, unitSystem) : null;
    return {
      kind: 'compare',
      title: `${m.label} · this vs last period`,
      unit: m.unit,
      currentMean: currentMean != null ? Math.round(currentMean) : null,
      previousMean: previousMean != null ? Math.round(previousMean) : null,
      delta: delta != null ? Math.round(delta) : null,
      deltaPct: num(r.deltaPct),
    };
  }

  return null;
}
