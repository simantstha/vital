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
 *     lowEnergyWarning: { thresholdKcal: number, appliedFloor: boolean, message: string } | null,
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
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { generateDailyBriefFromDb } from '@/lib/brain/brief';
import { getDailyBrief, upsertDailyBrief } from '@/lib/brain/dailyBriefRepository';
import { getCalibration } from '@/lib/brain/baselines';
import { queryMetricPoints, type MetricPoint } from '@/lib/brain/tools';
import { resolveDietBudget } from '@/lib/brain/dietBudget';
import { resolveDailyIntake } from '@/lib/brain/nutritionIntake';
import { localDayKey, pickTimeZone, isValidTimeZone } from '@/lib/localDay';
import { resolveUnitSystem } from '@/lib/units';

export const dynamic = 'force-dynamic';

// ── Payload helpers ─────────────────────────────────────────────────────────

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

  // ── DB read (fast). The LLM brief is served from cache, never awaited here ─
  let calibration: Awaited<ReturnType<typeof getCalibration>>;
  let hrvPts: MetricPoint[], rhrPts: MetricPoint[], sleepPts: MetricPoint[];
  let userRow: (typeof schema.users.$inferSelect) | undefined;
  try {
    [calibration, hrvPts, rhrPts, sleepPts, userRow] = await Promise.all([
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

  // Prefer the fresh request tz, else the stored one, else UTC.
  const tz = pickTimeZone(paramTz, userRow?.timezone);
  const dayKey = localDayKey(now, tz);

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
  // auto-calculated from goal + weight). Consumed macros come from
  // resolveDailyIntake: today's meal_logged events if any exist, else
  // HealthKit's dietary_* metrics (e.g. synced from MyFitnessPal) if a
  // nonzero reading exists, else zero — see lib/brain/nutritionIntake.ts for
  // the full precedence and why a >0 guard gates the HealthKit fallback.
  const budget = userRow
    ? await resolveDietBudget(userRow, userId)
    : await resolveDietBudget(
        { goal: null, target_kcal: null, protein_target_g: null, carbs_target_g: null, fat_target_g: null },
        userId,
      );

  const intakeByDay = await resolveDailyIntake(userId, [dayKey], tz ?? 'UTC');
  const intake = intakeByDay.get(dayKey)!;
  const consumedKcal    = intake.kcal;
  const consumedProtein = intake.protein;
  const consumedCarbs   = intake.carbs;
  const consumedFat     = intake.fat;

  // ── Brief (insight + plan) — persisted in Postgres; regenerated in the
  //    background on a miss. The proactive worker pre-warms this at the
  //    user's morning slot (scripts/proactive-health-worker.ts), so most
  //    opens hit; this on-demand path is the fallback for a user who opens
  //    before their slot or whose pre-warm failed. The Claude generation
  //    itself takes 15–27s, so we never block this response on it — the
  //    Postgres read above is a single indexed row lookup, fast enough to
  //    await directly. Hit → return it. Miss → return empty (the iOS app
  //    keeps its own default insight/plan) and warm it in the background.
  let insight = '';
  let plan: Array<{ name: string; kcal: number; why: string }> = [];

  const unitSystem = resolveUnitSystem(userRow?.unit_system);
  const persistedBrief = await getDailyBrief(userId, dayKey, unitSystem);
  if (persistedBrief) {
    insight = persistedBrief.insight;
    plan    = persistedBrief.plan;
  } else {
    void generateDailyBriefFromDb(userId)
      .then(brief =>
        upsertDailyBrief(userId, dayKey, unitSystem, {
          insight: brief.body,
          plan: brief.meals.map(m => ({ name: m.k, kcal: m.kcal, why: m.why })),
        }),
      )
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
      // Which source resolveDailyIntake used for consumedKcal/protein/carbs/fat
      // above — 'logged' (Vital meal log), 'healthkit' (e.g. MyFitnessPal via
      // Apple Health), or 'none'. sourceName is the logging app name when
      // known (HealthKit only), else null.
      consumedSource:     intake.source,
      consumedSourceName: intake.sourceName,
      // Macro TARGETS (from the resolver) — the iOS app used to derive these
      // from a fixed 30/40/30 split; now they're server-authoritative.
      proteinTarget: budget.protein,
      carbsTarget:   budget.carbs,
      fatTarget:     budget.fat,
      // Consumed-so-far, summed from today's logged meals.
      protein:       consumedProtein,
      carbs:         consumedCarbs,
      fat:           consumedFat,
      // Present when targetKcal is at/under the sex-aware low-energy-
      // availability floor — see lib/brain/dietBudget.ts. null otherwise.
      lowEnergyWarning: budget.lowEnergyWarning ?? null,
    },
    insight,
    plan,
    calibration,
  });
}
