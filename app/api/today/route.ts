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
import { getCachedBrief, setCachedBrief, briefCacheKey } from '@/lib/brain/briefCache';
import { getCalibration } from '@/lib/brain/baselines';
import { queryMetricPoints, type MetricPoint } from '@/lib/brain/tools';
import { resolveDietBudget } from '@/lib/brain/dietBudget';
import { localDayKey, pickTimeZone, isValidTimeZone } from '@/lib/localDay';

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

/**
 * Builds a { value, deltaPct } biometric card from a daily_metrics series.
 * Points arrive ascending, so the latest is last and the prior day is second-
 * to-last. `transform` maps the stored unit to the card unit (e.g. sleep
 * minutes → hours). Empty series → nulls (iOS decode is null-tolerant).
 */
function cardFromPoints(
  points: MetricPoint[],
  transform: (v: number) => number = v => v,
): { value: number | null; deltaPct: number | null } {
  if (points.length === 0) return { value: null, deltaPct: null };
  const value = transform(points[points.length - 1].value);
  const prior = points.length > 1 ? transform(points[points.length - 2].value) : null;
  return { value, deltaPct: deltaPct(value, prior) };
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
  // The diet budget is bucketed by the user's *local* calendar day (see below),
  // not UTC, so "consumed" resets at their local midnight. The device sends its
  // current zone as ?tz= on every request, so this tracks travel automatically.
  const paramTz = new URL(request.url).searchParams.get('tz');
  const now = new Date();
  // Pull a generous window (a local day starts at most ~14h from UTC midnight,
  // well inside this) — we refine to "today" by local-day key in JS below.
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const threeDaysAgo = new Date(utcMidnight);
  threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);

  // ── DB read (fast). The LLM brief is served from cache, never awaited here ─
  let events: (typeof schema.events.$inferSelect)[];
  let calibration: Awaited<ReturnType<typeof getCalibration>>;
  let hrvPts: MetricPoint[], rhrPts: MetricPoint[], sleepPts: MetricPoint[];
  let userRow: (typeof schema.users.$inferSelect) | undefined;
  try {
    [events, calibration, hrvPts, rhrPts, sleepPts, userRow] = await Promise.all([
      db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.user_id, userId), gte(schema.events.timestamp, threeDaysAgo)))
        .orderBy(desc(schema.events.timestamp)),
      getCalibration(userId),
      // Biometric cards read the aggregated daily_metrics store — the same
      // source Trends and the coach data-tools use — so all surfaces agree.
      // A 7-day window guarantees a prior point for the delta across a gap.
      queryMetricPoints(userId, 'hrv_sdnn', 7),
      queryMetricPoints(userId, 'resting_hr', 7),
      queryMetricPoints(userId, 'sleep_minutes', 7),
      db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1).then(r => r[0]),
    ]);
  } catch (err) {
    return NextResponse.json({ error: `DB read error: ${String(err)}` }, { status: 500 });
  }

  // ── Partition by the user's local calendar day (events power the diet
  //    budget only). Prefer the fresh request tz, else the stored one, else UTC.
  const tz = pickTimeZone(paramTz, userRow?.timezone);
  const dayKey = localDayKey(now, tz);
  const todayEvents = events.filter(e => localDayKey(e.timestamp, tz) === dayKey);

  // Travel-aware: persist the device's current zone so background jobs
  // (/api/brief) compute the same local day. Fire-and-forget; this response
  // already uses paramTz directly, so it's correct even before this commits.
  if (isValidTimeZone(paramTz) && paramTz !== userRow?.timezone) {
    void db
      .update(schema.users)
      .set({ timezone: paramTz })
      .where(eq(schema.users.id, userId))
      .catch(err => console.error('[/api/today] tz persist failed:', err));
  }

  // ── Biometric cards from daily_metrics (single source of truth) ──────────
  const { value: hrvValue,   deltaPct: hrvDelta }   = cardFromPoints(hrvPts, v => Math.round(v));
  const { value: rhrValue,   deltaPct: rhrDelta }   = cardFromPoints(rhrPts, v => Math.round(v));
  const { value: sleepHours, deltaPct: sleepDelta } =
    cardFromPoints(sleepPts, v => Math.round((v / 60) * 10) / 10);

  // ── Diet budget ──────────────────────────────────────────────────────────
  // Target + macro targets come from the shared resolver (user override, else
  // auto-calculated from goal + weight). Consumed macros are summed from
  // today's meal_logged events.
  const budget = userRow
    ? await resolveDietBudget(userRow, userId)
    : await resolveDietBudget(
        { goal: null, target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null },
        userId,
      );

  let consumedKcal = 0, consumedProtein = 0, consumedCarbs = 0, consumedFat = 0;
  for (const e of todayEvents.filter(e => e.type === 'meal_logged')) {
    const p   = pl(e.payload);
    consumedKcal    += Math.round(num(p.kcal) ?? num(p.calories) ?? 0);
    consumedProtein += Math.round(num(p.p)    ?? num(p.protein)  ?? 0);
    consumedCarbs   += Math.round(num(p.c)    ?? num(p.carbs)    ?? 0);
    consumedFat     += Math.round(num(p.f)    ?? num(p.fat)      ?? 0);
  }

  // ── Brief (insight + plan) — cached; regenerated in the background ────────
  // The Claude brief takes 15–27s, so we never block this response on it.
  // Cache hit → return it. Cache miss → return empty (the iOS app keeps its
  // own default insight/plan) and warm the cache in the background.
  let insight = '';
  let plan: Array<{ name: string; kcal: number; why: string }> = [];

  const cacheKey = briefCacheKey(userId, dayKey);
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
      mode:          budget.mode,
      goal:          budget.goal,
      targetKcal:    budget.targetKcal,
      consumedKcal,
      remaining:     Math.max(0, budget.targetKcal - consumedKcal),
      // Macro TARGETS (from the resolver) — the iOS app used to derive these
      // from a fixed 30/40/30 split; now they're server-authoritative.
      proteinTarget: budget.protein,
      carbsTarget:   budget.carbs,
      fatTarget:     budget.fat,
      // Consumed-so-far, summed from today's logged meals.
      protein:       consumedProtein,
      carbs:         consumedCarbs,
      fat:           consumedFat,
    },
    insight,
    plan,
    calibration,
  });
}
