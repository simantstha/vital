/**
 * POST /api/ingest/daily
 *
 * Receives day-keyed HealthKit summaries from the iOS app (1-year backfill,
 * and later the background sync coordinator) and upserts them into the
 * `daily_metrics` table, then recomputes baselines for whatever metrics were
 * touched. Unlike /api/ingest (append-only `events`), this route is
 * idempotent by construction: UNIQUE(user_id, date, metric) + upsert means
 * re-posting the same day is a no-op write, not a duplicate row.
 *
 * Body:
 * {
 *   days: [{
 *     date: 'YYYY-MM-DD',
 *     metrics?: {
 *       hrv_sdnn?: number, resting_hr?: number, hr_avg?: number,
 *       steps?: number, active_energy_kcal?: number, body_mass_kg?: number,
 *     },
 *     sleep?: { minutes: number, stages?: unknown },
 *     workouts?: Array<{ hkUuid: string, [key: string]: unknown }>,
 *   }]
 * }
 * Response: { upserted: number }
 *
 * Auth: session JWT via middleware.ts → x-user-id header, read with
 * lib/auth.ts getUserIdFromRequest(). Cap: 60 days per request (400 above).
 */

import { NextResponse } from 'next/server';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { recomputeBaselines } from '@/lib/brain/baselines';
import {
  reconcilePersistedWorkouts,
  sleepAnalysisCandidate,
} from '@/lib/healthAnalysisReconciliation';

const MAX_DAYS_PER_REQUEST = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SCALAR_METRICS = [
  'hrv_sdnn',
  'resting_hr',
  'hr_avg',
  'steps',
  'active_energy_kcal',
  'body_mass_kg',
  'vo2_max',
  'distance_m',
  'exercise_min',
  'flights',
  'basal_energy_kcal',
] as const;
type ScalarMetric = typeof SCALAR_METRICS[number];

interface DayInput {
  date: string;
  metrics?: Partial<Record<ScalarMetric, number>>;
  sleep?: { minutes: number; stages?: unknown };
  workouts?: Array<{ hkUuid: string; [key: string]: unknown }>;
}

function isDayInput(d: unknown): d is DayInput {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  if (typeof o.date !== 'string' || !DATE_RE.test(o.date)) return false;
  if (o.metrics !== undefined && (o.metrics === null || typeof o.metrics !== 'object')) return false;
  if (o.sleep !== undefined) {
    if (o.sleep === null || typeof o.sleep !== 'object') return false;
    if (typeof (o.sleep as Record<string, unknown>).minutes !== 'number') return false;
  }
  if (o.workouts !== undefined) {
    if (!Array.isArray(o.workouts)) return false;
    if (!o.workouts.every((workout) => (
      workout !== null
      && typeof workout === 'object'
      && typeof (workout as Record<string, unknown>).hkUuid === 'string'
      && (workout as Record<string, unknown>).hkUuid !== ''
    ))) return false;
  }
  return true;
}

interface Row {
  user_id: string;
  date: string;
  metric: string;
  value: number;
  payload: unknown;
  source: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).days)) {
    return NextResponse.json({ error: 'Body must be { days: DayInput[] }.' }, { status: 400 });
  }

  const raw = (body as { days: unknown[] }).days;

  if (raw.length === 0) {
    return NextResponse.json({ upserted: 0 });
  }

  if (raw.length > MAX_DAYS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many days: ${raw.length} exceeds the ${MAX_DAYS_PER_REQUEST}-day cap per request.` },
      { status: 400 }
    );
  }

  const invalid = raw.filter((d) => !isDayInput(d));
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `${invalid.length} day(s) are malformed (need date: 'YYYY-MM-DD', and valid metrics/sleep/workouts).` },
      { status: 400 }
    );
  }

  const days = raw as DayInput[];
  const receivedAt = new Date();

  // ── Flatten into daily_metrics rows ───────────────────────────────────────
  const rows: Row[] = [];
  const touchedMetrics = new Set<string>();

  for (const day of days) {
    if (day.metrics) {
      for (const metric of SCALAR_METRICS) {
        const value = day.metrics[metric];
        if (typeof value !== 'number') continue;
        rows.push({ user_id: userId, date: day.date, metric, value, payload: null, source: 'healthkit' });
        touchedMetrics.add(metric);
      }
    }
    if (day.sleep) {
      rows.push({
        user_id: userId,
        date: day.date,
        metric: 'sleep_minutes',
        value: day.sleep.minutes,
        payload: day.sleep.stages ?? null,
        source: 'healthkit',
      });
      touchedMetrics.add('sleep_minutes');
    }
    if (day.workouts) {
      rows.push({
        user_id: userId,
        date: day.date,
        metric: 'workouts',
        value: day.workouts.length,
        payload: day.workouts,
        source: 'healthkit',
      });
      touchedMetrics.add('workouts');
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ upserted: 0 });
  }

  try {
    const workoutDays = days.filter((day) => day.workouts !== undefined);

    await db.transaction(async (tx) => {
      // Serialize each user's ingest transactions so daily source rows and queue
      // rows cannot be reconciled from different concurrent snapshots.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);

      const persistedWorkoutRows = workoutDays.length === 0
        ? []
        : await tx
          .select({
            hkUuid: schema.workout_analyses.hk_uuid,
            workoutDate: schema.workout_analyses.workout_date,
            contentFingerprint: schema.workout_analyses.content_fingerprint,
            status: schema.workout_analyses.status,
          })
          .from(schema.workout_analyses)
          .where(and(
            eq(schema.workout_analyses.user_id, userId),
            inArray(schema.workout_analyses.workout_date, workoutDays.map((day) => day.date)),
          ));
      const workoutReconciliation = reconcilePersistedWorkouts(
        persistedWorkoutRows,
        workoutDays.flatMap((day) => (day.workouts ?? []).map((workout) => ({
          workoutDate: day.date,
          workout,
        }))),
      );

      await tx
        .insert(schema.daily_metrics)
        .values(rows)
        .onConflictDoUpdate({
          target: [schema.daily_metrics.user_id, schema.daily_metrics.date, schema.daily_metrics.metric],
          set: {
            value:      sql`excluded.value`,
            payload:    sql`excluded.payload`,
            source:     sql`excluded.source`,
            updated_at: sql`now()`,
          },
        });

      const removedHkUuids = workoutReconciliation.removedHkUuids;
      if (removedHkUuids.length > 0) {
        await tx.update(schema.workout_analyses).set({
          status: 'deleted',
          deleted_at: receivedAt,
          lease_expires_at: null,
          updated_at: receivedAt,
        }).where(and(
          eq(schema.workout_analyses.user_id, userId),
          inArray(schema.workout_analyses.hk_uuid, removedHkUuids),
        ));
      }

      // Upserts follow removals so a workout moved between included dates ends active.
      for (const entry of workoutReconciliation.upserts) {
        await tx.insert(schema.workout_analyses).values({
          user_id: userId,
          hk_uuid: entry.workout.hkUuid,
          workout_date: entry.workoutDate,
          content_fingerprint: entry.fingerprint,
          input_payload: entry.workout,
        }).onConflictDoUpdate({
          target: [schema.workout_analyses.user_id, schema.workout_analyses.hk_uuid],
          set: {
            workout_date: entry.workoutDate,
            content_fingerprint: entry.fingerprint,
            input_payload: entry.workout,
            status: 'pending',
            retry_count: 0,
            next_attempt_at: receivedAt,
            lease_expires_at: null,
            result: null,
            deleted_at: null,
            updated_at: receivedAt,
            notification_state: sql`case when ${schema.workout_analyses.notification_sent_at} is not null or ${schema.workout_analyses.notification_state} = 'sent' then 'sent' else 'pending' end`,
          },
        });
      }

      for (const day of days.filter((candidate) => candidate.sleep !== undefined)) {
        const sleep = day.sleep!;
        const candidate = sleepAnalysisCandidate(day.date, sleep, receivedAt);
        await tx.insert(schema.sleep_analyses).values({
          user_id: userId,
          wake_date: candidate.wakeDate,
          content_fingerprint: candidate.fingerprint,
          input_payload: sleep,
          analyze_after: candidate.analyzeAfter,
          next_attempt_at: candidate.analyzeAfter,
        }).onConflictDoUpdate({
          target: [schema.sleep_analyses.user_id, schema.sleep_analyses.wake_date],
          set: {
            content_fingerprint: candidate.fingerprint,
            input_payload: sleep,
            analyze_after: candidate.analyzeAfter,
            next_attempt_at: candidate.analyzeAfter,
            status: 'pending',
            retry_count: 0,
            lease_expires_at: null,
            result: null,
            updated_at: receivedAt,
            notification_state: sql`case when ${schema.sleep_analyses.notification_sent_at} is not null or ${schema.sleep_analyses.notification_state} = 'sent' then 'sent' else 'pending' end`,
          },
          setWhere: ne(schema.sleep_analyses.content_fingerprint, candidate.fingerprint),
        });
      }
    });

    await recomputeBaselines(userId, Array.from(touchedMetrics));

    return NextResponse.json({ upserted: rows.length });
  } catch (err) {
    console.error('[ingest/daily] DB error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
