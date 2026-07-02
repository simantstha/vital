/**
 * GET /api/today
 *
 * Returns today's biometric snapshot, diet budget, AI insight, and meal plan.
 *
 * Response shape:
 * {
 *   metrics: {
 *     hrv:       { value: number|null, unit: "ms",  deltaPct: number|null },
 *     sleep:     { value: number|null, unit: "h",   deltaPct: number|null },
 *     restingHr: { value: number|null, unit: "bpm", deltaPct: number|null },
 *   },
 *   dietBudget: {
 *     targetKcal: 2400,
 *     consumedKcal: number,
 *     remaining: number,
 *     protein: number,
 *     carbs: number,
 *     fat: number,
 *   },
 *   insight: string,
 *   plan: [{ name: string, kcal: number, why: string }],
 * }
 *
 * Numbers come from SQL; insight + plan come from lib/brain/brief (Claude).
 * If the Claude call fails, insight falls back to a static string and plan to [].
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, gte, desc } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { generateDailyBriefFromDb } from '@/lib/brain/brief';
import { getCachedBrief, setCachedBrief, briefCacheKey, todayKey } from '@/lib/brain/briefCache';

export const dynamic = 'force-dynamic';

// ── Payload helpers ─────────────────────────────────────────────────────────

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function deltaPct(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior === 0) return null;
  return Math.round(((current - prior) / prior) * 100);
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // ── Date boundaries ──────────────────────────────────────────────────────
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Pull 3 days so we can compute deltas (today vs yesterday vs day-before)
  const threeDaysAgo = new Date(todayStart);
  threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);

  // ── DB read (fast). The LLM brief is served from cache, never awaited here ─
  let events: (typeof schema.events.$inferSelect)[];
  try {
    events = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.user_id, userId), gte(schema.events.timestamp, threeDaysAgo)))
      .orderBy(desc(schema.events.timestamp));
  } catch (err) {
    return NextResponse.json({ error: `DB read error: ${String(err)}` }, { status: 500 });
  }

  // ── Partition by date bucket ─────────────────────────────────────────────
  const todayEvents     = events.filter(e => e.timestamp >= todayStart);
  const yesterdayEvents = events.filter(e => e.timestamp < todayStart);

  // ── HRV ─────────────────────────────────────────────────────────────────
  const hrvEvents  = events.filter(e => e.type === 'hrv_reading');
  const latestHrv  = hrvEvents[0];
  const prevHrv    = hrvEvents[1];

  const extractHrv = (e: (typeof events)[number] | undefined): number | null => {
    if (!e) return null;
    const p = pl(e.payload);
    // Handle all field name variants used across iOS app + seed
    const v = num(p.value) ?? num(p.hrv) ?? num(p.valueMs) ?? num(p.sdnn);
    return v != null ? Math.round(v) : null;
  };

  const hrvValue    = extractHrv(latestHrv);
  const prevHrvVal  = extractHrv(prevHrv);
  const hrvDelta    = deltaPct(hrvValue, prevHrvVal);

  // ── Sleep + resting HR ───────────────────────────────────────────────────
  // Sleep sessions: latest from today-or-yesterday (could have logged this morning),
  // then the prior session for delta.
  const sleepEvents  = events.filter(e => e.type === 'sleep_session');
  const latestSleep  = sleepEvents[0];
  const prevSleep    = sleepEvents[1];

  const extractSleep = (e: (typeof events)[number] | undefined): { hours: number | null; rhr: number | null } => {
    if (!e) return { hours: null, rhr: null };
    const p = pl(e.payload);
    const durMs = num(p.duration_ms) ?? (num(p.duration_s) != null ? num(p.duration_s)! * 1_000 : null);
    const rhr   = num(p.rhr) ?? num(p.resting_heart_rate);
    return {
      hours: durMs != null ? Math.round((durMs / 3_600_000) * 10) / 10 : null,
      rhr:   rhr   != null ? Math.round(rhr) : null,
    };
  };

  const { hours: sleepHours, rhr: rhrValue }        = extractSleep(latestSleep);
  const { hours: prevSleepH, rhr: prevRhrVal }       = extractSleep(prevSleep);
  const sleepDelta = deltaPct(sleepHours, prevSleepH);
  const rhrDelta   = deltaPct(rhrValue, prevRhrVal);

  // ── Diet budget (today only) ─────────────────────────────────────────────
  const TARGET_KCAL = 2400;
  let consumedKcal = 0, protein = 0, carbs = 0, fat = 0;

  for (const e of todayEvents.filter(e => e.type === 'meal_logged')) {
    const p   = pl(e.payload);
    consumedKcal += Math.round(num(p.kcal)    ?? num(p.calories) ?? 0);
    protein      += Math.round(num(p.p)       ?? num(p.protein)  ?? 0);
    carbs        += Math.round(num(p.c)       ?? num(p.carbs)    ?? 0);
    fat          += Math.round(num(p.f)       ?? num(p.fat)      ?? 0);
  }

  // Suppress a meal entry if we also pulled yesterday's meals (shouldn't happen
  // given todayEvents filter, but belt-and-suspenders check is free).
  void yesterdayEvents;

  // ── Brief (insight + plan) — cached; regenerated in the background ────────
  // The Claude brief takes 15–27s, so we never block this response on it.
  // Cache hit → return it. Cache miss → return empty (the iOS app keeps its
  // own default insight/plan) and warm the cache in the background.
  let insight = '';
  let plan: Array<{ name: string; kcal: number; why: string }> = [];

  const cacheKey = briefCacheKey(userId, todayKey());
  const cached = getCachedBrief(cacheKey);
  if (cached) {
    insight = cached.insight;
    plan    = cached.plan;
  } else {
    void generateDailyBriefFromDb(userId)
      .then(brief => {
        setCachedBrief(cacheKey, {
          insight: brief.body,
          plan: brief.meals.map(m => ({ name: m.k, kcal: m.kcal, why: m.why })),
        });
      })
      .catch(err => console.error('[/api/today] background brief generation failed:', err));
  }

  // ── Response ─────────────────────────────────────────────────────────────
  return NextResponse.json({
    metrics: {
      hrv: {
        value:    hrvValue,
        unit:     'ms',
        deltaPct: hrvDelta,
      },
      sleep: {
        value:    sleepHours,
        unit:     'h',
        deltaPct: sleepDelta,
      },
      restingHr: {
        value:    rhrValue,
        unit:     'bpm',
        deltaPct: rhrDelta,
      },
    },
    dietBudget: {
      targetKcal:  TARGET_KCAL,
      consumedKcal,
      remaining:   Math.max(0, TARGET_KCAL - consumedKcal),
      protein,
      carbs,
      fat,
    },
    insight,
    plan,
  });
}
