import { and, eq, gte, inArray, lte } from 'drizzle-orm';

import type { DayPoint, MetricSeries } from './types';

/** Rolling window the battery analyses. */
export const INSIGHT_WINDOW_DAYS = 90;

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Expands sparse rows into one point per day across [startDay, endDay].
 *
 * A day with no row becomes `value: null`. It is NEVER zero-filled — absence is
 * not a measured zero, and every detector downstream relies on telling them
 * apart.
 */
export function densify(
  rows: { date: string; value: number }[],
  startDay: string,
  endDay: string,
): DayPoint[] {
  const byDate = new Map<string, number>();
  for (const row of rows) byDate.set(row.date, row.value);

  const points: DayPoint[] = [];
  for (let day = startDay; day <= endDay; day = addDays(day, 1)) {
    const value = byDate.get(day);
    points.push({ date: day, value: value === undefined ? null : value });
  }
  return points;
}

/** Metrics with enough history for the engine to reason about, per `baselines`. */
export async function establishedMetrics(userId: string): Promise<Set<string>> {
  const { db, schema } = await import('@/db');

  const rows = await db
    .select({ metric: schema.baselines.metric })
    .from(schema.baselines)
    .where(and(eq(schema.baselines.user_id, userId), eq(schema.baselines.established, true)));
  return new Set(rows.map((row) => row.metric));
}

/** Loads dense series for the given metrics over the window ending at endDay. */
export async function loadSeries(
  userId: string,
  metrics: string[],
  endDay: string,
  windowDays: number = INSIGHT_WINDOW_DAYS,
): Promise<MetricSeries[]> {
  const { db, schema } = await import('@/db');

  if (metrics.length === 0) return [];
  const startDay = addDays(endDay, -(windowDays - 1));

  const rows = await db
    .select({
      metric: schema.daily_metrics.metric,
      date: schema.daily_metrics.date,
      value: schema.daily_metrics.value,
    })
    .from(schema.daily_metrics)
    .where(and(
      eq(schema.daily_metrics.user_id, userId),
      inArray(schema.daily_metrics.metric, metrics),
      gte(schema.daily_metrics.date, startDay),
      lte(schema.daily_metrics.date, endDay),
    ));

  const grouped = new Map<string, { date: string; value: number }[]>();
  for (const metric of metrics) grouped.set(metric, []);
  for (const row of rows) {
    // `date` columns come back as 'YYYY-MM-DD' strings from postgres.js.
    grouped.get(row.metric)?.push({ date: String(row.date), value: Number(row.value) });
  }

  return metrics.map((metric) => ({
    metric,
    points: densify(grouped.get(metric) ?? [], startDay, endDay),
  }));
}
