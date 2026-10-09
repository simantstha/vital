/**
 * Vital — peak running week before a race's taper (DB loader)
 *
 * The taper, race-week and recovery targets (lib/enduranceProgression.ts) are
 * shares of the runner's peak week: the biggest weekly running km in the 4
 * weeks before the taper began (21 days before the race). That window ends
 * 22–49 days before the race, further back than the 28-day windows the goal
 * progress and weekly review loaders read, so it is read here — and only
 * while a taper / race week / recovery is actually under way. No scoring logic
 * lives here; the pure `peakWeekKmBeforeTaper` does the arithmetic.
 */

import { and, eq, gte, lte } from 'drizzle-orm';
import { db, schema } from '@/db';
import { isWindDownPhase, peakWeekKmBeforeTaper, racePhase, TAPER_START_DAYS } from '@/lib/enduranceProgression';
import { isRunningWorkoutType } from '@/lib/goalProgress';

/** Days of running history before the taper that the peak week is taken from. */
const PEAK_WINDOW_DAYS = 28;

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Peak week (km) for the race on `raceDate`, as of the local day(s) `onDays`
 * (the weekly review passes the reviewed and the coming Monday). Null without a
 * race, when none of those days is in taper / race week / recovery (nothing
 * needs it then), and when no running with a distance was logged in the window
 * — the callers fall back to the weekly distance goal.
 */
export async function loadRacePeakWeekKm(
  userId: string,
  raceDate: string | null | undefined,
  onDays: string | string[],
): Promise<number | null> {
  const days = Array.isArray(onDays) ? onDays : [onDays];
  if (!raceDate || !days.some(day => isWindDownPhase(racePhase(raceDate, day)))) return null;
  const taperStart = addDays(raceDate, -TAPER_START_DAYS);
  const from = addDays(taperStart, -PEAK_WINDOW_DAYS);
  const to = addDays(taperStart, -1);

  const rows = await db
    .select({ date: schema.daily_metrics.date, payload: schema.daily_metrics.payload })
    .from(schema.daily_metrics)
    .where(
      and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, 'workouts'),
        gte(schema.daily_metrics.date, from),
        lte(schema.daily_metrics.date, to),
      ),
    );

  const runs: Array<{ day: string; km: number }> = [];
  for (const row of rows) {
    const list = Array.isArray(row.payload) ? (row.payload as Array<Record<string, unknown>>) : [];
    for (const w of list) {
      const type = typeof w.type === 'string' ? w.type : null;
      if (!isRunningWorkoutType(type)) continue;
      if (typeof w.distanceM !== 'number' || !Number.isFinite(w.distanceM) || w.distanceM <= 0) continue;
      runs.push({ day: row.date, km: w.distanceM / 1000 });
    }
  }
  return peakWeekKmBeforeTaper(runs, raceDate);
}
