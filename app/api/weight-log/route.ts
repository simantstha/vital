/**
 * POST /api/weight-log
 *
 * Logs a manual weigh-in. Request/response shape is unchanged from the
 * legacy file-backed version (lib/weightLog.ts) — the iOS audit found zero
 * callers, but the shape is kept compatible anyway since nothing about the
 * wire contract needed to change.
 *
 * Request body: { weight: number, unit?: 'lbs' | 'kg', date: 'YYYY-MM-DD' }
 * Response: { ok: true }
 * 400 when weight or date is missing, 401 if unauthenticated.
 *
 * Storage: writes a `weight_logged` event (source: 'manual') via
 * lib/weightRepository.ts — see that file for the storage/dedup design.
 * `date` (today) uses the actual current instant as the reading's
 * measuredAt; `date` (a backfilled day) is anchored to local noon so it
 * lands on the right calendar day.
 *
 * GET /api/weight-log?days=90&tz=America/Chicago
 *
 * Returns the user's weigh-in history merged with HealthKit body-mass
 * readings, plus a smoothed trend (lib/weightTrend.ts — EWMA, MacroFactor/
 * Happy Scale style).
 *
 * Response: {
 *   entries: [{ date: 'YYYY-MM-DD', weight: number (kg), unit: 'kg', source: 'manual'|'healthkit'|'coach' }],
 *   trend: {
 *     days: [{ day, rawKg, trendKg }],
 *     delta7dKgPerWeek: number | null,
 *     delta30dKgPerWeek: number | null,
 *     established: boolean,   // >= 3 weigh-ins spanning >= 5 days (docs/ux-spec-v4.md §4)
 *   }
 * }
 *
 * Both handlers lazily import any legacy per-user weight-log.json into
 * Postgres on first call for that user (see
 * lib/weightRepository.ts#importLegacyWeightLogIfPresent) — a SQL migration
 * can't read a file that only exists on the app machine's disk volume, and
 * the worker process (which needs this data for the coach) has no volume at
 * all. The file itself is left in place, never deleted.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { localDayKey, pickTimeZone } from '@/lib/localDay';
import { LB_PER_KG } from '@/lib/metricFormat';
import {
  getWeightReadings,
  importLegacyWeightLogIfPresent,
  logWeightEntry,
} from '@/lib/weightRepository';
import { computeWeightTrend } from '@/lib/weightTrend';

export const dynamic = 'force-dynamic';

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

async function resolveTimezone(userId: string, paramTz: string | null): Promise<string | undefined> {
  const [row] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return pickTimeZone(paramTz, row?.timezone);
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = getUserIdFromRequest(req);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const { weight, unit, date } = await req.json() as { weight: number; unit: 'lbs' | 'kg'; date: string };

  if (!weight || !date) {
    return NextResponse.json({ error: 'weight and date required' }, { status: 400 });
  }

  const tz = await resolveTimezone(userId, null);
  await importLegacyWeightLogIfPresent(userId, tz);

  const resolvedUnit = unit ?? 'lbs';
  const valueKg = resolvedUnit === 'kg' ? weight : weight / LB_PER_KG;

  const now = new Date();
  const today = localDayKey(now, tz);
  // Backfilled (non-today) dates get a synthetic local-noon timestamp, same
  // convention as the legacy-import path, so they land on the requested
  // calendar day regardless of timezone.
  const measuredAt = date === today ? now : new Date(`${date}T12:00:00.000Z`);

  await logWeightEntry(userId, { valueKg, measuredAt, source: 'manual', timezone: tz });

  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = getUserIdFromRequest(req);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const days = Math.max(1, Math.min(365, Number(searchParams.get('days') ?? '90')));
  const paramTz = searchParams.get('tz');

  const tz = await resolveTimezone(userId, paramTz);
  await importLegacyWeightLogIfPresent(userId, tz);

  const readings = await getWeightReadings(userId, days, tz);
  const trend = computeWeightTrend(readings);

  const entries = readings
    .slice()
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt))
    .map((r) => ({ date: r.localDay, weight: round1(r.valueKg), unit: 'kg' as const, source: r.source }));

  return NextResponse.json({ entries, trend });
}
