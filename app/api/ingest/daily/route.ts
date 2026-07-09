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
import { sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { recomputeBaselines } from '@/lib/brain/baselines';

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
  if (o.workouts !== undefined && !Array.isArray(o.workouts)) return false;
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
    await db
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

    await recomputeBaselines(userId, Array.from(touchedMetrics));

    return NextResponse.json({ upserted: rows.length });
  } catch (err) {
    console.error('[ingest/daily] DB error:', err);
    return NextResponse.json({ error: 'Database error.' }, { status: 500 });
  }
}
