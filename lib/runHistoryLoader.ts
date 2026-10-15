/**
 * Vital — running history for the endurance week plan (DB loader)
 *
 * The week plan (lib/enduranceProgression.ts `enduranceWeekPlan`) looks at more
 * than the 28 / 30 days of workouts the goal progress and weekly review loaders
 * read: a restart is judged against the median of the 4 weeks before last week,
 * a spike is only known from the week before it, and "first week of running"
 * means no earlier run at all. `queryWorkouts` clamps at 30 days, so the longer
 * window is read here — running workouts with a distance only. No scoring logic
 * lives here.
 */

import { and, eq, gte, lte } from 'drizzle-orm';
import { db, schema } from '@/db';
import { isRunningWorkoutType } from '@/lib/goalProgress';

/** Days of running history the week plan is given: last week plus the 4 before it with room to spare (11 weeks). */
export const RUN_HISTORY_DAYS = 77;

export interface RunHistoryRow {
  day: string;
  km: number;
  durationMin: number | null;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Running workouts with a distance on local days `todayKey - days` .. `todayKey` (inclusive), oldest first. */
export async function loadRunHistory(userId: string, todayKey: string, days: number = RUN_HISTORY_DAYS): Promise<RunHistoryRow[]> {
  const rows = await db
    .select({ date: schema.daily_metrics.date, payload: schema.daily_metrics.payload })
    .from(schema.daily_metrics)
    .where(
      and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, 'workouts'),
        gte(schema.daily_metrics.date, addDays(todayKey, -days)),
        lte(schema.daily_metrics.date, todayKey),
      ),
    );

  const runs: RunHistoryRow[] = [];
  for (const row of rows) {
    const list = Array.isArray(row.payload) ? (row.payload as Array<Record<string, unknown>>) : [];
    for (const w of list) {
      const type = typeof w.type === 'string' ? w.type : null;
      if (!isRunningWorkoutType(type)) continue;
      if (typeof w.distanceM !== 'number' || !Number.isFinite(w.distanceM) || w.distanceM <= 0) continue;
      runs.push({
        day: row.date,
        km: w.distanceM / 1000,
        durationMin: typeof w.durationMin === 'number' && Number.isFinite(w.durationMin) ? w.durationMin : null,
      });
    }
  }
  return runs.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
