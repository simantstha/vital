/**
 * GET /api/profile
 *
 * Returns the dev user's profile, integration statuses, and aggregate stats.
 *
 * Response:
 * {
 *   name: string,
 *   onboarded: boolean,   // true once users.onboarded_at is set (POST /api/onboarding)
 *   createdAt: string,    // ISO timestamp, users.created_at
 *   integrations: [
 *     { name: "Apple Health", status: "connected" | "disconnected" },
 *   ],
 *   stats: {
 *     loggedDays:  number,   // distinct UTC dates with at least one event
 *     mealsLogged: number,   // total meal_logged events
 *     avgHrv:      number | null,   // avg SDNN ms across all hrv_reading events
 *     workouts:    number,   // total workout_completed events
 *   },
 *   profile: {
 *     age: number | null,
 *     biologicalSex: string | null,
 *     heightCm: number | null,
 *     weightKg: number | null,
 *   },
 *   sleepGoalMinutes: number,   // effective value — users.sleep_goal_minutes ?? 480
 *   lightsOutMinutes: number,   // effective value — users.lights_out_minutes ?? 1350
 * }
 *
 * PATCH /api/profile
 *
 * Partial update of personal-details + sleep-goal profile fields (redesign v3
 * Phase 9). All body fields optional — only the fields present are validated
 * and applied.
 *
 * Request body:
 *   {
 *     name?: string,               // 1–120 chars after trim
 *     age?: integer,               // 5–120
 *     heightCm?: number,           // 50–260
 *     weightKg?: number,           // 20–400
 *     sleepGoalMinutes?: integer,  // 240–720
 *     lightsOutMinutes?: integer,  // 0–1439
 *   }
 *
 * Effects:
 *   - name              → users.name
 *   - age / heightCm     → core-profile.md Identity lines (lib/profileDetails.updateIdentityLines)
 *   - weightKg           → weight-log.json (lib/weightLog.logWeight) AND core-profile.md
 *   - sleepGoalMinutes / lightsOutMinutes → users.sleep_goal_minutes / users.lights_out_minutes;
 *     when lightsOutMinutes changes, today's still-pending "Lights out" plan_items
 *     row (if any) is updated in place so Today reflects the change immediately.
 *
 * Response: { ok: true }
 * 400 on validation failure ({ error }), 401 if unauthenticated.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { getCalibration } from '@/lib/brain/baselines';
import { readMemoryFile } from '@/lib/memory';
import { parseProfileDetails, updateIdentityLines, formatSleepSubtitle } from '@/lib/profileDetails';
import { logWeight } from '@/lib/weightLog';
import { localDayKey, pickTimeZone } from '@/lib/localDay';

export const dynamic = 'force-dynamic';

const DEFAULT_SLEEP_GOAL_MIN = 480;  // 8h — kept in sync with app/api/plan/route.ts
const DEFAULT_LIGHTS_OUT_MIN = 1350; // 22:30 — kept in sync with app/api/plan/route.ts

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // HealthKit-derived stats (avgHrv, workouts, tracked days, integration
  // status) come from daily_metrics — the store the backfill and background
  // sync write to, and the same source Today/Trends read — NOT the events
  // ledger. The app stopped writing hrv_reading/workout_completed events when
  // health sync moved to daily_metrics, so reading events here reported zero.
  // Meals are still logged as events (meal_logged), so mealsLogged stays there.
  const [userRow, calibration, dmAgg, dmDates, mealRows] = await Promise.all([
    db
      .select({
        name: schema.users.name,
        onboarded_at: schema.users.onboarded_at,
        created_at: schema.users.created_at,
        sleep_goal_minutes: schema.users.sleep_goal_minutes,
        lights_out_minutes: schema.users.lights_out_minutes,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1),
    getCalibration(userId),
    db.execute(sql`
      select
        avg(value)  filter (where metric = 'hrv_sdnn')             as avg_hrv,
        coalesce(sum(value) filter (where metric = 'workouts'), 0) as workouts,
        count(*)                                                   as row_count
      from ${schema.daily_metrics}
      where ${schema.daily_metrics.user_id} = ${userId}
    `),
    db
      .selectDistinct({ date: schema.daily_metrics.date })
      .from(schema.daily_metrics)
      .where(eq(schema.daily_metrics.user_id, userId)),
    db
      .select({ timestamp: schema.events.timestamp })
      .from(schema.events)
      .where(and(eq(schema.events.user_id, userId), eq(schema.events.type, 'meal_logged'))),
  ]);

  const name = userRow[0]?.name ?? 'Vital User';
  const onboarded = userRow[0]?.onboarded_at != null;
  const createdAt = (userRow[0]?.created_at ?? new Date(0)).toISOString();
  const sleepGoalMinutes = userRow[0]?.sleep_goal_minutes ?? DEFAULT_SLEEP_GOAL_MIN;
  const lightsOutMinutes = userRow[0]?.lights_out_minutes ?? DEFAULT_LIGHTS_OUT_MIN;

  const aggRow = (dmAgg as unknown as Record<string, unknown>[])[0] ?? {};

  // ── Integration: Apple Health ─────────────────────────────────────────────
  // Connected once any HealthKit data has landed in daily_metrics.
  const hasHealthKit = Number(aggRow.row_count ?? 0) > 0;

  // ── Stats ─────────────────────────────────────────────────────────────────

  // loggedDays: distinct calendar dates the user was tracked — union of
  // daily_metrics days (device-local 'YYYY-MM-DD') and meal-logged UTC days.
  const dateSet = new Set<string>();
  for (const r of dmDates) dateSet.add(String(r.date));
  for (const m of mealRows) dateSet.add(m.timestamp.toISOString().split('T')[0]);

  const mealsLogged = mealRows.length;

  // pg returns aggregates as numeric strings; null when no hrv_sdnn rows exist.
  const avgHrvRaw = aggRow.avg_hrv != null ? Number(aggRow.avg_hrv) : NaN;
  const avgHrv = Number.isFinite(avgHrvRaw) ? Math.round(avgHrvRaw * 10) / 10 : null;

  const workouts = Math.round(Number(aggRow.workouts ?? 0));
  const profile = parseProfileDetails(readMemoryFile(userId, 'core-profile.md'));

  // ── Response ──────────────────────────────────────────────────────────────
  return NextResponse.json({
    name,
    onboarded,
    createdAt,
    integrations: [
      { name: 'Apple Health', status: hasHealthKit ? 'connected' : 'disconnected' },
    ],
    stats: {
      loggedDays:  dateSet.size,
      mealsLogged,
      avgHrv,
      workouts,
    },
    profile,
    calibration,
    sleepGoalMinutes,
    lightsOutMinutes,
  });
}

// ── PATCH ────────────────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export async function PATCH(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { name, age, heightCm, weightKg, sleepGoalMinutes, lightsOutMinutes } = body;

  // ── Validation ───────────────────────────────────────────────────────────
  let trimmedName: string | undefined;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 120) {
      return NextResponse.json({ error: 'name must be a non-empty string of at most 120 characters.' }, { status: 400 });
    }
    trimmedName = name.trim();
  }

  if (age !== undefined && (!isInteger(age) || age < 5 || age > 120)) {
    return NextResponse.json({ error: 'age must be an integer between 5 and 120.' }, { status: 400 });
  }
  if (heightCm !== undefined && (!isFiniteNumber(heightCm) || heightCm < 50 || heightCm > 260)) {
    return NextResponse.json({ error: 'heightCm must be a number between 50 and 260.' }, { status: 400 });
  }
  if (weightKg !== undefined && (!isFiniteNumber(weightKg) || weightKg < 20 || weightKg > 400)) {
    return NextResponse.json({ error: 'weightKg must be a number between 20 and 400.' }, { status: 400 });
  }
  if (sleepGoalMinutes !== undefined && (!isInteger(sleepGoalMinutes) || sleepGoalMinutes < 240 || sleepGoalMinutes > 720)) {
    return NextResponse.json({ error: 'sleepGoalMinutes must be an integer between 240 and 720.' }, { status: 400 });
  }
  if (lightsOutMinutes !== undefined && (!isInteger(lightsOutMinutes) || lightsOutMinutes < 0 || lightsOutMinutes > 1439)) {
    return NextResponse.json({ error: 'lightsOutMinutes must be an integer between 0 and 1439.' }, { status: 400 });
  }

  // ── Effects ──────────────────────────────────────────────────────────────
  if (trimmedName !== undefined) {
    await db.update(schema.users).set({ name: trimmedName }).where(eq(schema.users.id, userId));
  }

  if (age !== undefined || heightCm !== undefined || weightKg !== undefined) {
    updateIdentityLines(userId, {
      age: age as number | undefined,
      heightCm: heightCm as number | undefined,
      weightKg: weightKg as number | undefined,
    });
  }

  if (weightKg !== undefined) {
    const today = new Date().toISOString().split('T')[0];
    logWeight(userId, today, weightKg as number, 'kg');
  }

  if (sleepGoalMinutes !== undefined || lightsOutMinutes !== undefined) {
    const sleepUpdate: Partial<typeof schema.users.$inferInsert> = {};
    if (sleepGoalMinutes !== undefined) sleepUpdate.sleep_goal_minutes = sleepGoalMinutes as number;
    if (lightsOutMinutes !== undefined) sleepUpdate.lights_out_minutes = lightsOutMinutes as number;

    const [updatedRow] = await db
      .update(schema.users)
      .set(sleepUpdate)
      .where(eq(schema.users.id, userId))
      .returning({
        timezone: schema.users.timezone,
        sleep_goal_minutes: schema.users.sleep_goal_minutes,
        lights_out_minutes: schema.users.lights_out_minutes,
      });

    if (lightsOutMinutes !== undefined && updatedRow) {
      const tz = pickTimeZone(null, updatedRow.timezone);
      const dayKey = localDayKey(new Date(), tz);
      const effectiveSleepGoal = updatedRow.sleep_goal_minutes ?? DEFAULT_SLEEP_GOAL_MIN;

      await db
        .update(schema.plan_items)
        .set({
          time_minutes: lightsOutMinutes as number,
          subtitle: formatSleepSubtitle(effectiveSleepGoal),
          updated_at: new Date(),
        })
        .where(and(
          eq(schema.plan_items.user_id, userId),
          eq(schema.plan_items.local_day, dayKey),
          eq(schema.plan_items.title, 'Lights out'),
          eq(schema.plan_items.status, 'pending'),
        ));
    }
  }

  return NextResponse.json({ ok: true });
}
