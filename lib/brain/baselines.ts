/**
 * Vital Brain — baseline computation over daily_metrics
 *
 * recomputeBaselines() runs cheap SQL aggregates (7/30/60-day means, 30-day
 * stddev, p25/p50/p75 over 90 days, data_days) per (user, metric) and upserts
 * the result into `baselines`. No cron needed — this is called at the end of
 * every POST /api/ingest/daily.
 *
 * getCalibration() reports whether the coach has enough history to make
 * recovery/training calls yet (hrv_sdnn + resting_hr + sleep_minutes all
 * "established", i.e. >= 14 days of data in the trailing 90-day window).
 */

import { db, schema } from '@/db';
import { sql } from 'drizzle-orm';
import { readMemoryFile, writeMemoryFile } from '@/lib/memory';

export interface BaselineStats {
  mean7: number | null;
  mean30: number | null;
  mean60: number | null;
  sd30: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

const CALIBRATION_METRICS = ['hrv_sdnn', 'resting_hr', 'sleep_minutes'] as const;
const ESTABLISHED_MIN_DAYS = 14;

function n(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/**
 * Recomputes and upserts baseline stats for the given metrics, for one user.
 * Safe to call with metrics that have zero rows — upserts a data_days: 0,
 * established: false row so getCalibration() always has something to read.
 */
export async function recomputeBaselines(userId: string, metrics: string[]): Promise<void> {
  for (const metric of metrics) {
    const rows = await db.execute(sql`
      select
        avg(value) filter (where date >= current_date - interval '7 days')  as mean7,
        avg(value) filter (where date >= current_date - interval '30 days') as mean30,
        avg(value) filter (where date >= current_date - interval '60 days') as mean60,
        stddev_samp(value) filter (where date >= current_date - interval '30 days') as sd30,
        percentile_cont(0.25) within group (order by value)
          filter (where date >= current_date - interval '90 days') as p25,
        percentile_cont(0.5) within group (order by value)
          filter (where date >= current_date - interval '90 days') as p50,
        percentile_cont(0.75) within group (order by value)
          filter (where date >= current_date - interval '90 days') as p75,
        count(distinct date) filter (where date >= current_date - interval '90 days') as data_days
      from ${schema.daily_metrics}
      where ${schema.daily_metrics.user_id} = ${userId}
        and ${schema.daily_metrics.metric} = ${metric}
    `);

    const row = (rows as unknown as Record<string, unknown>[])[0] ?? {};
    const dataDays = Number(row.data_days ?? 0);
    const stats: BaselineStats = {
      mean7:  n(row.mean7),
      mean30: n(row.mean30),
      mean60: n(row.mean60),
      sd30:   n(row.sd30),
      p25:    n(row.p25),
      p50:    n(row.p50),
      p75:    n(row.p75),
    };
    const established = dataDays >= ESTABLISHED_MIN_DAYS;

    await db
      .insert(schema.baselines)
      .values({
        user_id: userId,
        metric,
        stats,
        data_days: dataDays,
        established,
        computed_at: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.baselines.user_id, schema.baselines.metric],
        set: { stats, data_days: dataDays, established, computed_at: new Date() },
      });

    if (metric === 'hrv_sdnn' && stats.mean30 != null) {
      writeHrvBaselineToProfile(userId, Math.round(stats.mean30));
    }
  }
}

/**
 * Rewrites the `HRV baseline: Nms (updated …)` line in the user's
 * core-profile.md. Moved here from lib/claude.ts (formerly a private
 * `updateHrvBaseline`, fed only by the 7-day event-based estimate) so both
 * the on-ingest baseline recompute and the daily-brief fallback path share
 * one implementation.
 */
export function writeHrvBaselineToProfile(userId: string, currentAvg: number): void {
  const profile = readMemoryFile(userId, 'core-profile.md');
  if (!profile) return;

  const match = /hrv baseline:\s*(\d+)\s*ms/i.exec(profile);
  if (!match) return;

  const stored = parseInt(match[1], 10);
  if (Math.abs(currentAvg - stored) <= 3) return;

  const date = new Date().toISOString().split('T')[0];
  const updated = profile.replace(
    /hrv baseline:\s*\d+\s*ms \(updated [^)]+\)/i,
    `HRV baseline: ${currentAvg}ms (updated ${date})`
  );
  writeMemoryFile(userId, 'core-profile.md', updated);
}

export interface Calibration {
  status: 'calibrating' | 'ready';
  metrics: Record<string, { dataDays: number; established: boolean }>;
}

/**
 * Reports whether the user has enough daily_metrics history for the coach to
 * safely make recovery/training calls. Ready requires hrv_sdnn, resting_hr,
 * and sleep_minutes to all be established (>= 14 days of data in 90d).
 */
export async function getCalibration(userId: string): Promise<Calibration> {
  // Count distinct data-days directly from daily_metrics — the same store the
  // Trends charts read — rather than the `baselines.data_days` snapshot, which
  // only refreshes on recomputeBaselines() and can lag behind a backfill. This
  // structurally guarantees the calibration counter agrees with the charts.
  const metricList = sql.join(CALIBRATION_METRICS.map(m => sql`${m}`), sql`, `);
  const rows = await db.execute(sql`
    select
      ${schema.daily_metrics.metric} as metric,
      count(distinct ${schema.daily_metrics.date}) as data_days
    from ${schema.daily_metrics}
    where ${schema.daily_metrics.user_id} = ${userId}
      and ${schema.daily_metrics.metric} in (${metricList})
      and ${schema.daily_metrics.date} >= current_date - interval '90 days'
    group by ${schema.daily_metrics.metric}
  `);

  const dayCounts = new Map<string, number>();
  for (const r of rows as unknown as Record<string, unknown>[]) {
    dayCounts.set(String(r.metric), Number(r.data_days ?? 0));
  }

  const metrics: Calibration['metrics'] = {};
  for (const m of CALIBRATION_METRICS) {
    const dataDays = dayCounts.get(m) ?? 0;
    metrics[m] = { dataDays, established: dataDays >= ESTABLISHED_MIN_DAYS };
  }

  const ready = CALIBRATION_METRICS.every(m => metrics[m].established);
  return { status: ready ? 'ready' : 'calibrating', metrics };
}
