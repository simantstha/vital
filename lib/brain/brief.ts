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
import { queryBaseline, queryMetricPoints, querySleepSummary } from '@/lib/brain/tools';
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
  const [events, hrvBaseline, calibration, hrvPts, rhrPts, sleepSummary, foodNodes, [userRow]] = await Promise.all([
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
    queryMetricPoints(userId, 'hrv_sdnn', 7),
    queryMetricPoints(userId, 'resting_hr', 7),
    querySleepSummary(userId, 7),
    db.select().from(schema.nodes).where(eq(schema.nodes.user_id, userId)).orderBy(desc(schema.nodes.weight)),
    db.select({ timezone: schema.users.timezone, unit_system: schema.users.unit_system })
      .from(schema.users).where(eq(schema.users.id, userId)).limit(1),
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

  // Sleep efficiency isn't a stored metric, so derive it from the stage payload
  // (asleep vs asleep+awake) when available; null otherwise.
  function sleepEfficiency(minutes: number, stages: unknown): number | null {
    const s = pl(stages);
    const awake = num(s.awake) ?? num(s.awakeMinutes);
    if (awake == null || minutes + awake <= 0) return null;
    return Math.round((minutes / (minutes + awake)) * 100);
  }

  const latestHrvPt = hrvPts.at(-1) ?? null;
  const latestRhrPt = rhrPts.at(-1) ?? null;
  const nights      = sleepSummary.nights;
  const latestNight = nights.at(-1) ?? null;

  const hrv: number | null = latestHrvPt ? Math.round(latestHrvPt.value) : null;
  const rhr: number | null = latestRhrPt ? Math.round(latestRhrPt.value) : null;
  const sleepMinutes: number | null = latestNight ? Math.round(latestNight.minutes) : null;
  const sleepDuration: string | null = sleepMinutes != null ? msToHm(sleepMinutes * 60_000) : null;
  const sleepEff: number | null = latestNight ? sleepEfficiency(latestNight.minutes, latestNight.stages) : null;

  // Baseline HRV for the recovery score: prefer the 30-day baseline row, else
  // the mean of the available daily_metrics points, else null (no data at all).
  const baselineStats = hrvBaseline?.stats ?? undefined;
  const hrvMean7d = hrvPts.length
    ? Math.round(hrvPts.reduce((a, p) => a + p.value, 0) / hrvPts.length)
    : null;
  const baselineHrv: number | null =
    baselineStats?.mean30 != null ? Math.round(baselineStats.mean30) : hrvMean7d;

  // Recovery is only meaningful with an HRV reading + a baseline to compare to.
  let recovery: number | null = null;
  if (hrv != null && baselineHrv != null && baselineHrv > 0) {
    const hrvScore   = Math.min(100, Math.round((hrv / baselineHrv) * 70));
    const sleepScore = Math.round(((sleepEff ?? 85) / 100) * 30);
    recovery = Math.min(100, Math.max(0, hrvScore + sleepScore));
  }
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

  // ── 7-day history ─────────────────────────────────────────────────────────

  type HistoryDay = {
    date: string;
    recovery: number;
    hrv: number;
    rhr: number;
    sleepPerf: number;
    sleepDuration: string;
  };

  // Built from the same daily_metrics points as today's biometrics above, so
  // the trend the coach describes matches what Trends shows.
  const dayMap = new Map<string, { hrv?: number; sleepMin?: number; sleepEff?: number; rhr?: number }>();
  const touchDay = (date: string) => {
    if (!dayMap.has(date)) dayMap.set(date, {});
    return dayMap.get(date)!;
  };
  for (const p of hrvPts) touchDay(p.date).hrv = p.value;
  for (const p of rhrPts) touchDay(p.date).rhr = p.value;
  for (const n of nights) {
    const d = touchDay(n.date);
    d.sleepMin = n.minutes;
    d.sleepEff = sleepEfficiency(n.minutes, n.stages) ?? undefined;
  }

  const historyDays: HistoryDay[] = Array.from(dayMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7)
    .map(([date, d]) => {
      const dayHrv  = d.hrv ?? baselineHrv ?? 0;
      const dayEff  = d.sleepEff ?? 85;
      const dayRec  = baselineHrv != null && baselineHrv > 0
        ? Math.min(100, Math.max(0, Math.round((dayHrv / baselineHrv) * 70 + (dayEff / 100) * 30)))
        : 0;
      return {
        date,
        recovery:      dayRec,
        hrv:           Math.round(dayHrv),
        rhr:           Math.round(d.rhr ?? 0),
        sleepPerf:     dayEff,
        sleepDuration: d.sleepMin != null ? msToHm(d.sleepMin * 60_000) : '–',
      };
    });

  const avgHrv7d = historyDays.length > 0
    ? Math.round(historyDays.reduce((s, d) => s + d.hrv, 0) / historyDays.length)
    : (baselineHrv ?? 0);
  const avgRec7d = historyDays.length > 0
    ? Math.round(historyDays.reduce((s, d) => s + d.recovery, 0) / historyDays.length)
    : (recovery ?? 0);

  const recent3Rec = historyDays.slice(0, 3).map(d => d.recovery);
  const older3Rec  = historyDays.slice(4).map(d => d.recovery);
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const diff = avg(recent3Rec) - avg(older3Rec);
  const trend: 'improving' | 'declining' | 'stable' =
    diff > 5 ? 'improving' : diff < -5 ? 'declining' : 'stable';

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
    recovery,
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
      days:          historyDays,
      avgRecovery7d: avgRec7d,
      avgHrv7d,
      trend,
    },
    recentActivities,
    weeklyMileage,
    recentNutrition,
    weightKg,
    foodProfile: restrictions.length || preferences.length ? { restrictions, preferences } : undefined,
    calibrating: calibration.status === 'calibrating',
  });
}
