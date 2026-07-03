/**
 * GET /api/trends?metric=hrv|sleep|weight|steps&days=30
 *
 * Returns a time series for one metric aggregated by calendar day (UTC).
 *
 * Response:
 * {
 *   metric: "hrv" | "sleep" | "weight" | "steps",
 *   points: [{ date: "YYYY-MM-DD", value: number }],   // oldest → newest
 * }
 *
 * Aggregation strategy per metric:
 *   hrv    — average of all hrv_reading values for the day (ms)
 *   sleep  — latest sleep_session duration for the day (hours)
 *   weight — latest weight_logged value for the day (kg)
 *   steps  — max steps_recorded value for the day (HealthKit cumulative deltas)
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, gte, desc } from 'drizzle-orm';
import { getOrCreateDevUser } from '@/lib/brain/user';

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

// ── Metric config ───────────────────────────────────────────────────────────

const VALID_METRICS = new Set(['hrv', 'sleep', 'weight', 'steps']);

const EVENT_TYPE: Record<string, string> = {
  hrv:    'hrv_reading',
  sleep:  'sleep_session',
  weight: 'weight_logged',
  steps:  'steps_recorded',
};

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const metric = searchParams.get('metric') ?? '';
  const days   = Math.max(1, Math.min(365, Number(searchParams.get('days') ?? '30')));

  if (!VALID_METRICS.has(metric)) {
    return NextResponse.json(
      { error: `Invalid metric. Must be one of: ${[...VALID_METRICS].join(', ')}` },
      { status: 400 },
    );
  }

  let userId: string;
  try {
    userId = await getOrCreateDevUser();
  } catch (err) {
    return NextResponse.json({ error: `DB error resolving user: ${String(err)}` }, { status: 500 });
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  since.setUTCHours(0, 0, 0, 0);

  const events = await db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, EVENT_TYPE[metric]),
        gte(schema.events.timestamp, since),
      ),
    )
    .orderBy(desc(schema.events.timestamp));

  // ── Aggregate by calendar day (UTC) ────────────────────────────────────

  // day key → accumulator
  const buckets = new Map<string, number[]>();

  for (const e of events) {
    const key = e.timestamp.toISOString().split('T')[0];
    if (!buckets.has(key)) buckets.set(key, []);

    const p = pl(e.payload);
    let v: number | null = null;

    if (metric === 'hrv') {
      v = num(p.value) ?? num(p.hrv) ?? num(p.valueMs) ?? num(p.sdnn) ?? null;
    } else if (metric === 'sleep') {
      const durMs = num(p.duration_ms) ?? (num(p.duration_s) != null ? num(p.duration_s)! * 1_000 : null);
      v = durMs != null ? Math.round((durMs / 3_600_000) * 10) / 10 : null;
    } else if (metric === 'weight') {
      let w = num(p.value) ?? num(p.weight);
      if (w != null) {
        const unit = typeof p.unit === 'string' ? p.unit : '';
        if (unit === 'lbs' || unit === 'lb') w *= 0.453592;
        v = Math.round(w * 10) / 10;
      }
    } else if (metric === 'steps') {
      v = num(p.count) ?? num(p.steps) ?? null;
    }

    if (v != null) buckets.get(key)!.push(v);
  }

  // ── Reduce each bucket to a single point ───────────────────────────────

  const points: Array<{ date: string; value: number }> = [];

  for (const [date, values] of buckets.entries()) {
    if (values.length === 0) continue;
    let value: number;

    if (metric === 'hrv') {
      // average
      value = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    } else if (metric === 'steps') {
      // max (HealthKit may send cumulative deltas throughout the day)
      value = Math.max(...values);
    } else {
      // sleep, weight — take the first (latest, since we fetched desc)
      value = values[0];
    }

    points.push({ date, value });
  }

  // Sort oldest → newest for charting
  points.sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({ metric, points });
}
