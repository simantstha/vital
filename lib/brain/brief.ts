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
import { queryBaseline } from '@/lib/brain/tools';
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

const M_TO_MI = 1 / 1609.34;

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

  // Fetch all recent events in one query, plus the hrv_sdnn baseline row +
  // calibration status (both cheap point-reads off the baselines table, via
  // the shared queryBaseline/getCalibration helpers so this aggregation isn't
  // duplicated across brief.ts and the coach's get_baseline tool).
  const [events, hrvBaseline, calibration] = await Promise.all([
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
  ]);

  const todayEvents   = events.filter(e => e.timestamp >= todayStart);
  const recentEvents  = events.filter(e => e.timestamp >= sevenDaysAgo && e.timestamp < todayStart);

  // ── Today's biometrics ────────────────────────────────────────────────────

  const latestHrv = todayEvents.find(e => e.type === 'hrv_reading')
    ?? recentEvents.find(e => e.type === 'hrv_reading');
  const latestSleep = todayEvents.find(e => e.type === 'sleep_session')
    ?? recentEvents.find(e => e.type === 'sleep_session');
  const latestWeight = events.find(e => e.type === 'weight_logged');

  const hrv  = latestHrv
    ? Math.round(num(pl(latestHrv.payload).value) ?? num(pl(latestHrv.payload).hrv) ?? 65)
    : 65;

  let rhr         = 60;
  let sleepDurMs  = 7 * 3_600_000;
  let sleepEff    = 80;

  if (latestSleep) {
    const sp = pl(latestSleep.payload);
    rhr      = Math.round(num(sp.rhr) ?? num(sp.resting_heart_rate) ?? 60);
    const durMs = num(sp.duration_ms) ??
      (num(sp.duration_s) != null ? num(sp.duration_s)! * 1_000 : null);
    if (durMs != null) sleepDurMs = durMs;
    sleepEff = Math.round(num(sp.efficiency) ?? num(sp.sleep_efficiency) ?? 80);
  }

  const sleepDuration = msToHm(sleepDurMs);

  // Estimate recovery from HRV relative to 7-day baseline
  const hrvReadings7d = recentEvents
    .filter(e => e.type === 'hrv_reading')
    .map(e => num(pl(e.payload).value) ?? num(pl(e.payload).hrv))
    .filter((v): v is number => v != null);

  // Prefer the daily_metrics-derived 30-day baseline (lib/brain/baselines.ts);
  // fall back to the 7-day event-based estimate when no baseline row exists yet
  // (e.g. brand-new user before any /api/ingest/daily has run).
  const baselineStats = hrvBaseline?.stats ?? undefined;
  const baselineHrv =
    baselineStats?.mean30 != null
      ? Math.round(baselineStats.mean30)
      : hrvReadings7d.length > 0
        ? Math.round(hrvReadings7d.reduce((a, b) => a + b, 0) / hrvReadings7d.length)
        : 65;

  const hrvScore   = Math.min(100, Math.round((hrv / baselineHrv) * 70));
  const sleepScore = Math.round((sleepEff / 100) * 30);
  const recovery   = Math.min(100, Math.max(0, hrvScore + sleepScore));
  const strain     = todayEvents.filter(e => e.type === 'workout_completed').length > 0
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
  const weeklyMi = thisWeekRuns.reduce((sum, e) => {
    const m = num(pl(e.payload).distance_m) ?? 0;
    return sum + m * M_TO_MI;
  }, 0);

  // ── Last run ─────────────────────────────────────────────────────────────

  const lastRunEvent = events.find(
    e =>
      e.type === 'workout_completed' &&
      (str(pl(e.payload).type) ?? '').toLowerCase().includes('run'),
  );

  let lastRun: { distanceMi: string; pace: string; dayTime: string; name: string } | null = null;
  if (lastRunEvent) {
    const rp  = pl(lastRunEvent.payload);
    const distM = num(rp.distance_m) ?? 0;
    const durS  = num(rp.duration_s) ?? 0;
    const distMi = distM * M_TO_MI;
    const paceMinMi = distM > 0 && durS > 0
      ? (durS / 60) / distMi
      : 0;
    const paceMin = Math.floor(paceMinMi);
    const paceSec = Math.round((paceMinMi - paceMin) * 60);
    const ts = lastRunEvent.timestamp;
    const h  = ts.getHours();
    const dayTime =
      h < 9 ? 'morning' : h < 12 ? 'late morning' : h < 17 ? 'afternoon' : 'evening';

    lastRun = {
      distanceMi: distMi.toFixed(1),
      pace: paceMinMi > 0 ? `${paceMin}:${paceSec < 10 ? '0' : ''}${paceSec}` : '–',
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

  const dayMap = new Map<string, { hrv?: number; sleepMs?: number; sleepEff?: number; rhr?: number }>();

  for (const e of recentEvents) {
    const key = e.timestamp.toISOString().split('T')[0];
    if (!dayMap.has(key)) dayMap.set(key, {});
    const d = dayMap.get(key)!;
    const p = pl(e.payload);

    if (e.type === 'hrv_reading' && d.hrv == null) {
      d.hrv = num(p.value) ?? num(p.hrv);
    }
    if (e.type === 'sleep_session' && d.sleepMs == null) {
      d.sleepMs  = num(p.duration_ms) ?? (num(p.duration_s) != null ? num(p.duration_s)! * 1000 : undefined);
      d.sleepEff = num(p.efficiency) ?? num(p.sleep_efficiency);
      d.rhr      = num(p.rhr) ?? num(p.resting_heart_rate);
    }
  }

  const historyDays: HistoryDay[] = Array.from(dayMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7)
    .map(([date, d]) => {
      const dayHrv  = d.hrv ?? baselineHrv;
      const dayEff  = d.sleepEff ?? 80;
      const dayRec  = Math.min(100, Math.max(0,
        Math.round((dayHrv / baselineHrv) * 70 + (dayEff / 100) * 30),
      ));
      return {
        date,
        recovery:      dayRec,
        hrv:           Math.round(dayHrv),
        rhr:           Math.round(d.rhr ?? 60),
        sleepPerf:     dayEff,
        sleepDuration: d.sleepMs != null ? msToHm(d.sleepMs) : '–',
      };
    });

  const avgHrv7d = historyDays.length > 0
    ? Math.round(historyDays.reduce((s, d) => s + d.hrv, 0) / historyDays.length)
    : baselineHrv;
  const avgRec7d = historyDays.length > 0
    ? Math.round(historyDays.reduce((s, d) => s + d.recovery, 0) / historyDays.length)
    : recovery;

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
    distanceMi?: string;
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

      const distMi    = distM * M_TO_MI;
      const paceMinMi = distM > 0 && durS > 0 ? (durS / 60) / distMi : 0;
      const paceMin   = Math.floor(paceMinMi);
      const paceSec   = Math.round((paceMinMi - paceMin) * 60);

      return {
        type:        kind,
        date:        e.timestamp.toISOString().split('T')[0],
        distanceMi:  distM > 0 ? distMi.toFixed(1) : undefined,
        pace:        paceMinMi > 0 ? `${paceMin}:${paceSec < 10 ? '0' : ''}${paceSec}` : undefined,
        hr:          num(p.avg_hr) ?? num(p.average_heart_rate),
        name:        str(p.name) ?? str(p.type) ?? 'Workout',
        durationMin: durS > 0 ? Math.round(durS / 60) : undefined,
      } as ActivityRecord;
    });

  // ── Weekly mileage (last 8 weeks) ─────────────────────────────────────────

  type WeeklyLoadRecord = {
    weekStart: string;
    runMi: number;
    walkMi: number;
    gymMin: number;
    gymSessions: number;
  };

  const weekBuckets = new Map<string, WeeklyLoadRecord>();
  for (const e of events.filter(ev => ev.type === 'workout_completed')) {
    const d  = e.timestamp;
    const ws = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    ws.setUTCDate(ws.getUTCDate() - ws.getUTCDay()); // Sunday
    const key = ws.toISOString().split('T')[0];
    if (!weekBuckets.has(key)) {
      weekBuckets.set(key, { weekStart: key, runMi: 0, walkMi: 0, gymMin: 0, gymSessions: 0 });
    }
    const wb   = weekBuckets.get(key)!;
    const p    = pl(e.payload);
    const wt   = (str(p.type) ?? '').toLowerCase();
    const distM = num(p.distance_m) ?? 0;
    const durS  = num(p.duration_s) ?? 0;

    if (wt.includes('run')) wb.runMi  += distM * M_TO_MI;
    else if (wt.includes('walk') || wt.includes('hike')) wb.walkMi += distM * M_TO_MI;
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
      runMi:  Math.round(w.runMi  * 10) / 10,
      walkMi: Math.round(w.walkMi * 10) / 10,
    }));

  // ── Recent nutrition (last 3 days, excluding today) ───────────────────────

  const threeDaysAgo = new Date(todayStart);
  threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);

  const mealDayMap = new Map<string, { calories: number; carbs: number; protein: number; fat: number }>();
  for (const e of events.filter(ev => ev.type === 'meal_logged' && ev.timestamp >= threeDaysAgo && ev.timestamp < todayStart)) {
    const key = e.timestamp.toISOString().split('T')[0];
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
    weeklyMi:   Math.round(weeklyMi * 10) / 10,
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
    calibrating: calibration.status === 'calibrating',
  });
}
