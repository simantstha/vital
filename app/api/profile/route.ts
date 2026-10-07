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
 *     loggedDays:  number,   // distinct local calendar dates with at least one event
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
 *   unitSystem: 'metric' | 'imperial' | null,   // raw users.unit_system — explicitly
 *                                                // nullable so the client can distinguish
 *                                                // "unset" (fall back to device locale)
 *                                                // from an explicit 'metric' choice.
 *   // Goal target (roadmap v5 — all null when unset)
 *   targetWeightKg:      number | null,   // users.target_weight_kg
 *   targetDate:          string | null,   // users.target_date, 'YYYY-MM-DD'
 *   weeklySessionsTarget: number | null,  // users.weekly_sessions_target
 *   weeklyDistanceKmTarget: number | null, // users.weekly_distance_km_target (km on the wire)
 *   goalStartWeightKg:   number | null,   // users.goal_start_weight_kg
 *   goalStartedAt:       string | null,   // ISO timestamp, users.goal_started_at
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
 *     unitSystem?: 'metric' | 'imperial',
 *     targetWeightKg?: number | null,       // 30–300; null clears
 *     targetDate?: string | null,           // 'YYYY-MM-DD', future and <= 3 years out; null clears
 *     weeklySessionsTarget?: integer | null, // 1–14; null clears
 *     weeklyDistanceKmTarget?: number | null, // 1–300 km; null clears
 *   }
 *
 * Effects:
 *   - name              → users.name
 *   - age / heightCm     → core-profile.md Identity lines (lib/profileDetails.updateIdentityLines)
 *   - weightKg           → a `weight_logged` event (lib/weightRepository.logWeightEntry,
 *     source: 'manual') AND core-profile.md
 *   - sleepGoalMinutes / lightsOutMinutes → users.sleep_goal_minutes / users.lights_out_minutes;
 *     when lightsOutMinutes changes, today's still-pending "Lights out" plan_items
 *     row (if any) is updated in place so Today reflects the change immediately.
 *   - unitSystem          → users.unit_system (strictly validated — 400 on a
 *     present-but-invalid value, unlike onboarding's lenient normalize-on-write).
 *
 *   - targetWeightKg / targetDate / weeklySessionsTarget / weeklyDistanceKmTarget →
 *     users.target_weight_kg / target_date / weekly_sessions_target / weekly_distance_km_target. When targetWeightKg changes to a new
 *     non-null value, goal progress re-anchors: users.goal_started_at = now and
 *     users.goal_start_weight_kg = latest trend weight (null if no weigh-ins).
 *     (A goal-TYPE change re-anchors the same way, in PATCH /api/diet-goal.)
 *
 * Response: { ok: true }
 * 400 on validation failure ({ error }), 401 if unauthenticated.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { getCalibration } from '@/lib/brain/baselines';
import { readCoreProfile } from '@/lib/coreProfileStore';
import { ensureHealthConstraintNodes } from '@/lib/brain/healthConstraints';
import { parseProfileDetails, updateIdentityLines, formatSleepSubtitle } from '@/lib/profileDetails';
import { importLegacyWeightLogIfPresent, logWeightEntry } from '@/lib/weightRepository';
import { localDayKey, pickTimeZone } from '@/lib/localDay';
import { parseUnitSystem } from '@/lib/units';
import { parseTargetDate, parseTargetWeightKg, parseWeeklySessionsTarget, parseWeeklyDistanceKmTarget } from '@/lib/goalTarget';
import { buildGoalRestart } from '@/lib/goalStart';

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
        timezone: schema.users.timezone,
        unit_system: schema.users.unit_system,
        target_weight_kg: schema.users.target_weight_kg,
        target_date: schema.users.target_date,
        weekly_sessions_target: schema.users.weekly_sessions_target,
        weekly_distance_km_target: schema.users.weekly_distance_km_target,
        goal_start_weight_kg: schema.users.goal_start_weight_kg,
        goal_started_at: schema.users.goal_started_at,
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
  // daily_metrics days (already device-local 'YYYY-MM-DD') and meal-logged
  // days. Meal timestamps are absolute instants, so they must be bucketed by
  // the SAME local day (not UTC) or a meal logged after local midnight but
  // before UTC midnight invents a phantom day and inflates this count.
  const tz = pickTimeZone(null, userRow[0]?.timezone);
  const dateSet = new Set<string>();
  for (const r of dmDates) dateSet.add(String(r.date));
  for (const m of mealRows) dateSet.add(localDayKey(m.timestamp, tz));

  const mealsLogged = mealRows.length;

  // pg returns aggregates as numeric strings; null when no hrv_sdnn rows exist.
  const avgHrvRaw = aggRow.avg_hrv != null ? Number(aggRow.avg_hrv) : NaN;
  const avgHrv = Number.isFinite(avgHrvRaw) ? Math.round(avgHrvRaw * 10) / 10 : null;

  const workouts = Math.round(Number(aggRow.workouts ?? 0));
  const profile = parseProfileDetails(await readCoreProfile(userId));

  // Lazy backfill for users who onboarded before health-constraint nodes
  // existed (see lib/brain/healthConstraints.ts) — this route runs on the
  // `app` process, which has the volume, and iOS calls it regularly. Never
  // allowed to fail this fetch: ensureHealthConstraintNodes already swallows
  // its own errors, but the call is wrapped here too as defense-in-depth
  // against a future change to that contract.
  try {
    await ensureHealthConstraintNodes(userId);
  } catch (err) {
    console.error(`[profile] ensureHealthConstraintNodes failed for user ${userId}:`, err);
  }

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
    unitSystem: userRow[0]?.unit_system ?? null,
    targetWeightKg: userRow[0]?.target_weight_kg ?? null,
    targetDate: userRow[0]?.target_date ?? null,
    weeklySessionsTarget: userRow[0]?.weekly_sessions_target ?? null,
    weeklyDistanceKmTarget: userRow[0]?.weekly_distance_km_target ?? null,
    goalStartWeightKg: userRow[0]?.goal_start_weight_kg ?? null,
    goalStartedAt: userRow[0]?.goal_started_at ? new Date(userRow[0].goal_started_at).toISOString() : null,
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

  const {
    name, age, heightCm, weightKg, sleepGoalMinutes, lightsOutMinutes, unitSystem,
    targetWeightKg, targetDate, weeklySessionsTarget, weeklyDistanceKmTarget,
  } = body;

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
  let parsedUnitSystem: 'metric' | 'imperial' | undefined;
  if (unitSystem !== undefined) {
    const parsed = parseUnitSystem(unitSystem);
    if (parsed === null) {
      return NextResponse.json({ error: 'unitSystem must be "metric" or "imperial".' }, { status: 400 });
    }
    parsedUnitSystem = parsed;
  }

  // Goal target fields: undefined → untouched, null → clear, otherwise validated.
  let parsedTargetWeight: number | null | undefined;
  if (targetWeightKg !== undefined) {
    if (targetWeightKg === null) {
      parsedTargetWeight = null;
    } else {
      const r = parseTargetWeightKg(targetWeightKg);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      parsedTargetWeight = r.value;
    }
  }
  let parsedTargetDate: string | null | undefined;
  if (targetDate !== undefined) {
    if (targetDate === null) {
      parsedTargetDate = null;
    } else {
      // "Future" is judged on the user's local day.
      const [tzRow] = await db
        .select({ timezone: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const todayKey = localDayKey(new Date(), pickTimeZone(null, tzRow?.timezone));
      const r = parseTargetDate(targetDate, todayKey);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      parsedTargetDate = r.value;
    }
  }
  let parsedWeeklySessions: number | null | undefined;
  if (weeklySessionsTarget !== undefined) {
    if (weeklySessionsTarget === null) {
      parsedWeeklySessions = null;
    } else {
      const r = parseWeeklySessionsTarget(weeklySessionsTarget);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      parsedWeeklySessions = r.value;
    }
  }
  let parsedWeeklyDistance: number | null | undefined;
  if (weeklyDistanceKmTarget !== undefined) {
    if (weeklyDistanceKmTarget === null) {
      parsedWeeklyDistance = null;
    } else {
      const r = parseWeeklyDistanceKmTarget(weeklyDistanceKmTarget);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      parsedWeeklyDistance = r.value;
    }
  }

  // ── Effects ──────────────────────────────────────────────────────────────
  if (trimmedName !== undefined) {
    await db.update(schema.users).set({ name: trimmedName }).where(eq(schema.users.id, userId));
  }

  if (parsedUnitSystem !== undefined) {
    await db.update(schema.users).set({ unit_system: parsedUnitSystem }).where(eq(schema.users.id, userId));
  }

  if (age !== undefined || heightCm !== undefined || weightKg !== undefined) {
    await updateIdentityLines(userId, {
      age: age as number | undefined,
      heightCm: heightCm as number | undefined,
      weightKg: weightKg as number | undefined,
    });
  }

  if (weightKg !== undefined) {
    // Bucket by the user's *local* day, not UTC — otherwise a weight logged
    // late at night can land on the wrong day's point on the Trends chart
    // (which overlays this over device-local daily_metrics dates).
    const [row] = await db
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const tz = pickTimeZone(null, row?.timezone);
    // Import any legacy weight-log.json first — iOS has zero callers of
    // /api/weight-log (see lib/weightRepository.ts), so this PATCH path may
    // be the only write this user's weigh-ins ever go through; a cheap
    // no-op when the file doesn't exist.
    await importLegacyWeightLogIfPresent(userId, tz);
    await logWeightEntry(userId, { valueKg: weightKg as number, measuredAt: new Date(), source: 'manual', timezone: tz });
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

  // ── Goal target ───────────────────────────────────────────────────────────
  // Runs after the weight log above so a same-request weightKg is already part
  // of the trend used for the re-anchored start weight.
  if (parsedTargetWeight !== undefined || parsedTargetDate !== undefined || parsedWeeklySessions !== undefined || parsedWeeklyDistance !== undefined) {
    const goalUpdate: Partial<typeof schema.users.$inferInsert> = {};
    if (parsedTargetDate !== undefined) goalUpdate.target_date = parsedTargetDate;
    if (parsedWeeklySessions !== undefined) goalUpdate.weekly_sessions_target = parsedWeeklySessions;
    if (parsedWeeklyDistance !== undefined) goalUpdate.weekly_distance_km_target = parsedWeeklyDistance;

    if (parsedTargetWeight !== undefined) {
      goalUpdate.target_weight_kg = parsedTargetWeight;
      if (parsedTargetWeight !== null) {
        const [current] = await db
          .select({ target_weight_kg: schema.users.target_weight_kg })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        if (current?.target_weight_kg !== parsedTargetWeight) {
          Object.assign(goalUpdate, await buildGoalRestart(userId));
        }
      }
    }

    await db.update(schema.users).set(goalUpdate).where(eq(schema.users.id, userId));
  }

  return NextResponse.json({ ok: true });
}
