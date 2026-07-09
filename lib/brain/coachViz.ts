/**
 * Coach inline data-viz — normalizes the raw result of a data tool
 * (get_metric_trend / get_sleep_summary / compare_periods) into a compact,
 * client-renderable payload so the iOS chat can draw a mini chart / stat card
 * inline instead of only showing a "Checked your HRV trend" chip.
 *
 * Only these three tools produce a viz; everything else stays text-only.
 */

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

const METRIC_META: Record<string, { label: string; unit: string }> = {
  hrv_sdnn:           { label: 'HRV',           unit: 'ms' },
  resting_hr:         { label: 'Resting HR',    unit: 'bpm' },
  hr_avg:             { label: 'Avg HR',        unit: 'bpm' },
  steps:              { label: 'Steps',         unit: '' },
  active_energy_kcal: { label: 'Active energy', unit: 'kcal' },
  body_mass_kg:       { label: 'Weight',        unit: 'kg' },
  sleep_minutes:      { label: 'Sleep',         unit: 'min' },
};

function meta(metric: string): { label: string; unit: string } {
  return METRIC_META[metric] ?? { label: metric, unit: '' };
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
 */
export function buildCoachViz(name: string, parsed: unknown): CoachViz | null {
  if (parsed == null || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;

  if (name === 'get_metric_trend') {
    const metric = String(r.metric ?? '');
    const rawPoints = Array.isArray(r.points) ? r.points : [];
    const points = rawPoints
      .map((p) => {
        const o = p as Record<string, unknown>;
        return { label: dayLabel(String(o.date ?? '')), value: num(o.value) };
      })
      .filter((p): p is { label: string; value: number } => p.value != null);
    if (points.length === 0) return null;

    const stats = (r.stats ?? {}) as Record<string, unknown>;
    const baselineObj = (r.baseline ?? null) as Record<string, unknown> | null;
    const mean = num(stats.mean);
    const baseline = baselineObj ? num(baselineObj.mean30) : null;
    const deltaPct =
      mean != null && baseline != null && baseline !== 0
        ? Math.round(((mean - baseline) / baseline) * 100)
        : null;
    const m = meta(metric);
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
    const currentMean = num(current.mean);
    const previousMean = num(previous.mean);
    if (currentMean == null && previousMean == null) return null;
    const m = meta(metric);
    return {
      kind: 'compare',
      title: `${m.label} · this vs last period`,
      unit: m.unit,
      currentMean: currentMean != null ? Math.round(currentMean) : null,
      previousMean: previousMean != null ? Math.round(previousMean) : null,
      delta: num(r.delta) != null ? Math.round(num(r.delta)!) : null,
      deltaPct: num(r.deltaPct),
    };
  }

  return null;
}
