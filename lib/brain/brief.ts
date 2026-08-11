/**
 * Vital Brain — daily brief, Postgres-backed
 *
 * generateDailyBriefFromDb(userId) pulls all biometric context from Postgres
 * HealthKit events instead of Whoop/Strava/MFP, then delegates to the same
 * Claude prompt in lib/claude.ts (generateDailyBrief).
 *
 * This replaces the old app/api/brief/route.ts → fetchWhoopMetrics /
 * fetchStravaData / getDiaryMacros wiring.
 */

import { db, schema } from '@/db';
import { eq, and, gte, desc } from 'drizzle-orm';
import { generateDailyBrief } from '@/lib/claude';
import { getCalibration } from '@/lib/brain/baselines';
import { queryBaseline, queryMetricPoints, querySleepSummary, type MetricPoint, type BaselineSnapshot } from '@/lib/brain/tools';
import {
  computeRecovery,
  selectHrvSource,
  sleepEfficiencyFromHealthKitStages,
  sleepFromWhoopStageSummary,
  buildRecoveryHistory,
  summarizeRecoveryTrend,
  DEFAULT_SLEEP_GOAL_MIN,
  type HrvMetric,
} from '@/lib/brain/recovery';
import { localDayKey, pickTimeZone } from '@/lib/localDay';
import { resolveUnitSystem, type UnitSystem } from '@/lib/units';
import { KM_PER_MILE } from '@/lib/metricFormat';
import type { DailyBrief } from '@/lib/types';

// ── Payload helpers ─────────────────────────────────────────────────────────

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function msToHm(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m < 10 ? '0' : ''}${m}m`;
}

/** Sunday-of-the-week key for an already-local 'YYYY-MM-DD' day (calendar
 *  arithmetic on a local key, mirroring lib/streak.ts's previousDayKey).
 *  Exported for unit testing (see brief.test.ts). */
export function weekStartKeyFromLocalDay(localDay: string): string {
  const [year, month, day] = localDay.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay()); // back to Sunday
  return date.toISOString().slice(0, 10);
}

/** Metres → the user's preferred display-distance unit (km for metric, mi for imperial). Display-only — storage stays metric. */
function metersToUnitDistance(m: number, units: UnitSystem): number {
  return units === 'imperial' ? m / 1000 / KM_PER_MILE : m / 1000;
}

// ── Main export ─────────────────────────────────────────────────────────────

export async function generateDailyBriefFromDb(userId: string): Promise<DailyBrief> {
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const eightWeeksAgo = new Date(todayStart);
  eightWeeksAgo.setUTCDate(eightWeeksAgo.getUTCDate() - 56);
  const sevenDaysAgo = new Date(todayStart);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);

  // One events read (weight/meals/workouts still live there), plus the hrv_sdnn
  // baseline row and calibration status via the shared helpers. Biometrics come
  // from daily_metrics (hrv_sdnn / resting_hr / sleep_minutes) — the SAME store
  // the Today metric cards, Trends, and the coach's data-tools read. Reading
  // them here (instead of the events ledger, which HealthKit never writes to)
  // guarantees the narrative and the cards can never disagree.
  //
  // The hrv_sdnn point window is 14 days (not 7) because selectHrvSource()
  // needs a recency probe wider than the 7-day history window, and the
  // baseline-fallback in computeBaselineForSource() below needs >=5 prior
  // points to fall back to — history still only renders the trailing 7.
  const [
    events,
    hrvBaseline,
    calibration,
    hrvPts,
    rhrPts,
    sleepSummary,
    foodNodes,
    [userRow],
    whoopHrvBaseline,
    whoopHrvPts,
    whoopRecoveryPts,
    whoopConnRows,
  ] = await Promise.all([
    db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.user_id, userId),
          gte(schema.events.timestamp, eightWeeksAgo),
        ),
      )
      .orderBy(desc(schema.events.timestamp)),
    queryBaseline(userId, 'hrv_sdnn'),
    getCalibration(userId),
    queryMetricPoints(userId, 'hrv_sdnn', 14),
    queryMetricPoints(userId, 'resting_hr', 7),
    querySleepSummary(userId, 7),
    db.select().from(schema.nodes)
      .where(and(eq(schema.nodes.user_id, userId), eq(schema.nodes.status, 'active')))
      .orderBy(desc(schema.nodes.weight)),
    db.select({
      timezone:           schema.users.timezone,
      unit_system:        schema.users.unit_system,
      sleep_goal_minutes: schema.users.sleep_goal_minutes,
    }).from(schema.users).where(eq(schema.users.id, userId)).limit(1),
    queryBaseline(userId, 'whoop_hrv_rmssd'),
    queryMetricPoints(userId, 'whoop_hrv_rmssd', 14),
    queryMetricPoints(userId, 'whoop_recovery', 2),
    db.select({ status: schema.whoop_connections.status })
      .from(schema.whoop_connections).where(eq(schema.whoop_connections.user_id, userId)).limit(1),
  ]);

  // No request context here (background/cron-generated brief), so this can
  // only use the stored device timezone, not a fresher request-supplied one —
  // still correct, just not travel-instant (see lib/localDay.ts).
  const tz = pickTimeZone(null, userRow?.timezone);

  // Display-unit preference — resolved once here (same select as timezone,
  // no extra query), threaded only into distance formatting below. Fixes the
  // pre-existing bug where this brief hardcoded miles for every user
  // regardless of unitSystem, while coach chat (lib/brain/context.ts) and the
  // data tools (lib/brain/tools.ts) hardcoded km — the two surfaces used to
  // contradict each other regardless of locale.
  const unitSystem = resolveUnitSystem(userRow?.unit_system);
  const distanceUnit = unitSystem === 'imperial' ? 'mi' : 'km';

  // Partition food-related nodes into restrictions and preferences
  const restrictions = foodNodes
    .filter(n => ['Allergy', 'Intolerance', 'Condition'].includes(String(n.type)))
    .map(n => ({ type: String(n.type), label: String(n.label) }));

  const preferences = foodNodes
    .filter(n => ['FoodPreference', 'Cuisine', 'PantryItem'].includes(String(n.type)))
    .map(n => ({ type: String(n.type), label: String(n.label) }))
    .slice(0, 15);

  const todayEvents   = events.filter(e => e.timestamp >= todayStart);
  const recentEvents  = events.filter(e => e.timestamp >= sevenDaysAgo && e.timestamp < todayStart);
  const latestWeight  = events.find(e => e.type === 'weight_logged');

  // ── Today's biometrics (latest daily_metrics point; null when unsynced) ────

  const whoopConnected = whoopConnRows[0]?.status === 'active';

  // WHOOP wins whenever it has fresh data; a baseline-only source beats no
  // source at all. Everything downstream — today's HRV value, the baseline
  // it's compared to, and the 7-day history — reads ONLY this metric, so an
  // SDNN reading can never meet an RMSSD baseline (see lib/brain/recovery.ts).
  const selectedHrvSource: HrvMetric | null = selectHrvSource({
    whoopConnected,
    whoopRecentPointDays: whoopHrvPts.length,
    whoopBaselineDataDays: whoopHrvBaseline?.dataDays ?? 0,
    healthkitRecentPointDays: hrvPts.length,
    healthkitBaselineDataDays: hrvBaseline?.dataDays ?? 0,
  });

  const sourcePts: MetricPoint[] =
    selectedHrvSource === 'whoop_hrv_rmssd' ? whoopHrvPts :
    selectedHrvSource === 'hrv_sdnn'        ? hrvPts :
    [];
  const sourceBaseline: BaselineSnapshot | null =
    selectedHrvSource === 'whoop_hrv_rmssd' ? whoopHrvBaseline :
    selectedHrvSource === 'hrv_sdnn'        ? hrvBaseline :
    null;

  const sourceLatestPt = sourcePts.at(-1) ?? null;
  const hrv: number | null = sourceLatestPt ? Math.round(sourceLatestPt.value) : null;

  // Baseline HRV for the recovery score: prefer the 30-day baseline row for
  // the SELECTED source; only when that's absent, fall back to the mean of
  // that same metric's OWN points, excluding the day being scored, and only
  // when there are at least 5 prior points — otherwise no baseline at all
  // (never impute one). hrvBaselineFromShortWindow flags the fallback path
  // so computeRecovery caps confidence at 'provisional'.
  function computeBaselineForSource(): { baseline: number | null; fromShortWindow: boolean; established: boolean } {
    const established = sourceBaseline?.established ?? false;
    const mean30 = sourceBaseline?.stats?.mean30;
    if (mean30 != null) return { baseline: Math.round(mean30), fromShortWindow: false, established };

    const priorPoints = sourcePts.filter(p => p.date !== sourceLatestPt?.date);
    if (priorPoints.length >= 5) {
      const mean = priorPoints.reduce((a, p) => a + p.value, 0) / priorPoints.length;
      return { baseline: Math.round(mean), fromShortWindow: true, established };
    }
    return { baseline: null, fromShortWindow: false, established };
  }
  const {
    baseline: hrvBaselineValue,
    fromShortWindow: hrvBaselineFromShortWindow,
    established: hrvBaselineEstablished,
  } = computeBaselineForSource();

  const latestRhrPt = rhrPts.at(-1) ?? null;
  const rhr: number | null = latestRhrPt ? Math.round(latestRhrPt.value) : null;

  // Sleep: HealthKit nights first (efficiency derived from the stage payload
  // via sleepEfficiencyFromHealthKitStages). If HealthKit has zero nights AND
  // the selected HRV source is WHOOP, fall back to whoop_sleep_min — which is
  // IN-BED time, not asleep time, so sleepFromWhoopStageSummary's conversion
  // is mandatory rather than treating it as asleep minutes directly.
  let nightsForScoring: Array<{ date: string; asleepMinutes: number; sleepEfficiencyPct: number | null }> =
    sleepSummary.nights.map(n => ({
      date: n.date,
      asleepMinutes: n.minutes,
      sleepEfficiencyPct: sleepEfficiencyFromHealthKitStages(n.minutes, n.stages),
    }));

  if (nightsForScoring.length === 0 && selectedHrvSource === 'whoop_hrv_rmssd') {
    const whoopSleepSummary = await querySleepSummary(userId, 7, 'whoop_sleep_min');
    nightsForScoring = whoopSleepSummary.nights
      .map(n => {
        const converted = sleepFromWhoopStageSummary(n.minutes, n.stages);
        return converted
          ? { date: n.date, asleepMinutes: converted.asleepMinutes, sleepEfficiencyPct: converted.efficiencyPct }
          : null;
      })
      .filter((n): n is { date: string; asleepMinutes: number; sleepEfficiencyPct: number } => n != null);
  }

  const latestNight = nightsForScoring.at(-1) ?? null;
  const sleepMinutes: number | null = latestNight ? Math.round(latestNight.asleepMinutes) : null;
  const sleepDuration: string | null = sleepMinutes != null ? msToHm(sleepMinutes * 60_000) : null;
  const sleepEff: number | null = latestNight?.sleepEfficiencyPct ?? null;

  const sleepGoalMinutes = userRow?.sleep_goal_minutes ?? DEFAULT_SLEEP_GOAL_MIN;

  const recoveryResult = computeRecovery({
    hrvSource: selectedHrvSource,
    hrv,
    hrvBaseline: hrvBaselineValue,
    hrvBaselineEstablished,
    hrvBaselineFromShortWindow,
    asleepMinutes: latestNight?.asleepMinutes ?? null,
    sleepEfficiencyPct: latestNight?.sleepEfficiencyPct ?? null,
    sleepGoalMinutes,
  });

  // WHOOP's own recovery score — reference only, never the score we prompt
  // the coach with (that's recoveryResult.score, Vital's own blend above).
  const whoopRecovery: number | null =
    whoopRecoveryPts.length ? Math.round(whoopRecoveryPts.at(-1)!.value) : null;

  const strain = todayEvents.filter(e => e.type === 'workout_completed').length > 0
    ? '–'
    : '0.0';

  // ── Current week mileage ──────────────────────────────────────────────────

  const weekStart = new Date(todayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay()); // Sunday
  const thisWeekRuns = events.filter(
    e =>
      e.type === 'workout_completed' &&
      e.timestamp >= weekStart &&
      (str(pl(e.payload).type) ?? '').toLowerCase().includes('run'),
  );
  const weeklyDistance = thisWeekRuns.reduce((sum, e) => {
    const m = num(pl(e.payload).distance_m) ?? 0;
    return sum + metersToUnitDistance(m, unitSystem);
  }, 0);

  // ── Last run ─────────────────────────────────────────────────────────────

  const lastRunEvent = events.find(
    e =>
      e.type === 'workout_completed' &&
      (str(pl(e.payload).type) ?? '').toLowerCase().includes('run'),
  );

  let lastRun: { distance: string; pace: string; dayTime: string; name: string } | null = null;
  if (lastRunEvent) {
    const rp  = pl(lastRunEvent.payload);
    const distM = num(rp.distance_m) ?? 0;
    const durS  = num(rp.duration_s) ?? 0;
    const distUnit = metersToUnitDistance(distM, unitSystem);
    const paceMinUnit = distM > 0 && durS > 0
      ? (durS / 60) / distUnit
      : 0;
    const paceMin = Math.floor(paceMinUnit);
    const paceSec = Math.round((paceMinUnit - paceMin) * 60);
    const ts = lastRunEvent.timestamp;
    const h  = ts.getHours();
    const dayTime =
      h < 9 ? 'morning' : h < 12 ? 'late morning' : h < 17 ? 'afternoon' : 'evening';

    lastRun = {
      distance: distUnit.toFixed(1),
      pace: paceMinUnit > 0 ? `${paceMin}:${paceSec < 10 ? '0' : ''}${paceSec}` : '–',
      dayTime,
      name: str(rp.name) ?? str(rp.type) ?? 'Run',
    };
  }

  // ── 7-day recovery history ───────────────────────────────────────────────

  // Built from the same daily_metrics points as today's biometrics above (the
  // SELECTED HRV source only, same baseline), so the trend the coach
  // describes matches what Trends shows. A day with no HRV reading is
  // omitted rather than fabricated — see buildRecoveryHistory in
  // lib/brain/recovery.ts.
  const historySourcePts = sourcePts.slice(-7);
  const dayMap = new Map<string, { hrv?: number; rhr?: number; asleepMinutes?: number; sleepEfficiencyPct?: number }>();
  const touchDay = (date: string) => {
    if (!dayMap.has(date)) dayMap.set(date, {});
    return dayMap.get(date)!;
  };
  for (const p of historySourcePts) touchDay(p.date).hrv = p.value;
  for (const p of rhrPts) touchDay(p.date).rhr = p.value;
  for (const n of nightsForScoring) {
    const d = touchDay(n.date);
    d.asleepMinutes = n.asleepMinutes;
    if (n.sleepEfficiencyPct != null) d.sleepEfficiencyPct = n.sleepEfficiencyPct;
  }

  const historyDaysRaw = Array.from(dayMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7)
    .map(([date, d]) => ({
      date,
      hrv: d.hrv,
      rhr: d.rhr,
      asleepMinutes: d.asleepMinutes,
      sleepEfficiencyPct: d.sleepEfficiencyPct,
    }));

  const recoveryHistory = buildRecoveryHistory(historyDaysRaw, {
    hrvSource: selectedHrvSource,
    hrvBaseline: hrvBaselineValue,
    hrvBaselineEstablished,
    hrvBaselineFromShortWindow,
    sleepGoalMinutes,
  });

  const trendSummary = summarizeRecoveryTrend(recoveryHistory);

  // ── Recent activities (last 7 days) ───────────────────────────────────────

  type ActivityRecord = {
    type: 'run' | 'gym' | 'walk';
    date: string;
    distance?: string;
    pace?: string;
    hr?: number;
    zone?: string;
    name: string;
    durationMin?: number;
  };

  const recentActivities: ActivityRecord[] = recentEvents
    .filter(e => e.type === 'workout_completed')
    .slice(0, 14)
    .map(e => {
      const p     = pl(e.payload);
      const wType = (str(p.type) ?? str(p.workout_type) ?? 'workout').toLowerCase();
      const distM = num(p.distance_m) ?? 0;
      const durS  = num(p.duration_s) ?? 0;

      let kind: 'run' | 'gym' | 'walk' = 'gym';
      if (wType.includes('run')) kind = 'run';
      else if (wType.includes('walk') || wType.includes('hike')) kind = 'walk';

      const distUnit    = metersToUnitDistance(distM, unitSystem);
      const paceMinUnit = distM > 0 && durS > 0 ? (durS / 60) / distUnit : 0;
      const paceMin     = Math.floor(paceMinUnit);
      const paceSec     = Math.round((paceMinUnit - paceMin) * 60);

      return {
        type:        kind,
        date:        localDayKey(e.timestamp, tz),
        distance:    distM > 0 ? distUnit.toFixed(1) : undefined,
        pace:        paceMinUnit > 0 ? `${paceMin}:${paceSec < 10 ? '0' : ''}${paceSec}` : undefined,
        hr:          num(p.avg_hr) ?? num(p.average_heart_rate),
        name:        str(p.name) ?? str(p.type) ?? 'Workout',
        durationMin: durS > 0 ? Math.round(durS / 60) : undefined,
      } as ActivityRecord;
    });

  // ── Weekly mileage (last 8 weeks) ─────────────────────────────────────────

  type WeeklyLoadRecord = {
    weekStart: string;
    runDistance: number;
    walkDistance: number;
    gymMin: number;
    gymSessions: number;
  };

  const weekBuckets = new Map<string, WeeklyLoadRecord>();
  for (const e of events.filter(ev => ev.type === 'workout_completed')) {
    // Bucket by the workout's *local* day, then walk back to that local
    // week's Sunday — calendar arithmetic on an already-local key (like
    // lib/streak.ts's previousDayKey), so it's DST-proof and never buckets a
    // late-night local workout into the wrong (UTC) week.
    const key = weekStartKeyFromLocalDay(localDayKey(e.timestamp, tz));
    if (!weekBuckets.has(key)) {
      weekBuckets.set(key, { weekStart: key, runDistance: 0, walkDistance: 0, gymMin: 0, gymSessions: 0 });
    }
    const wb   = weekBuckets.get(key)!;
    const p    = pl(e.payload);
    const wt   = (str(p.type) ?? '').toLowerCase();
    const distM = num(p.distance_m) ?? 0;
    const durS  = num(p.duration_s) ?? 0;

    if (wt.includes('run')) wb.runDistance  += metersToUnitDistance(distM, unitSystem);
    else if (wt.includes('walk') || wt.includes('hike')) wb.walkDistance += metersToUnitDistance(distM, unitSystem);
    else {
      wb.gymMin      += Math.round(durS / 60);
      wb.gymSessions += 1;
    }
  }
  const weeklyMileage: WeeklyLoadRecord[] = Array.from(weekBuckets.values())
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
    .slice(0, 8)
    .map(w => ({
      ...w,
      runDistance:  Math.round(w.runDistance  * 10) / 10,
      walkDistance: Math.round(w.walkDistance * 10) / 10,
    }));

  // ── Recent nutrition (last 3 days, excluding today) ───────────────────────

  const threeDaysAgo = new Date(todayStart);
  threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);

  const mealDayMap = new Map<string, { calories: number; carbs: number; protein: number; fat: number }>();
  for (const e of events.filter(ev => ev.type === 'meal_logged' && ev.timestamp >= threeDaysAgo && ev.timestamp < todayStart)) {
    const key = localDayKey(e.timestamp, tz);
    if (!mealDayMap.has(key)) mealDayMap.set(key, { calories: 0, carbs: 0, protein: 0, fat: 0 });
    const day = mealDayMap.get(key)!;
    const p   = pl(e.payload);
    day.calories += Math.round(num(p.kcal) ?? num(p.calories) ?? 0);
    day.carbs    += Math.round(num(p.c)    ?? num(p.carbs)    ?? 0);
    day.protein  += Math.round(num(p.p)    ?? num(p.protein)  ?? 0);
    day.fat      += Math.round(num(p.f)    ?? num(p.fat)      ?? 0);
  }
  const recentNutrition = Array.from(mealDayMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 3)
    .map(([date, macros]) => ({ date, ...macros }));

  // ── Weight from latest event ──────────────────────────────────────────────

  let weightKg: number | undefined;
  if (latestWeight) {
    const wp = pl(latestWeight.payload);
    let w = num(wp.value) ?? num(wp.weight);
    if (w != null) {
      const unit = str(wp.unit);
      if (unit === 'lbs' || unit === 'lb') w *= 0.453592;
      weightKg = Math.round(w * 10) / 10;
    }
  }

  // ── Delegate to lib/claude.ts generateDailyBrief ─────────────────────────
  return generateDailyBrief(userId, {
    recovery: recoveryResult.score,
    recoveryConfidence: recoveryResult.confidence,
    recoverySourceLabel: recoveryResult.hrvSourceLabel,
    recoveryGaps: recoveryResult.gaps,
    whoopRecovery,
    hrv,
    rhr,
    sleepPerf:  sleepEff,
    sleepDuration,
    strain,
    weeklyDistance: Math.round(weeklyDistance * 10) / 10,
    distanceUnit,
    unitSystem,
    lastRun,
    history: {
      days:          recoveryHistory,
      avgRecovery7d: trendSummary.avgRecovery,
      avgHrv7d:      trendSummary.avgHrv,
      trend:         trendSummary.trend,
    },
    recentActivities,
    weeklyMileage,
    recentNutrition,
    weightKg,
    foodProfile: restrictions.length || preferences.length ? { restrictions, preferences } : undefined,
    calibrating: calibration.status === 'calibrating',
  });
}
