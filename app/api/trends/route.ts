/**
 * GET /api/trends?metric=hrv|sleep|weight|steps|vo2|distance|rhr&days=30
 *
 * Day-keyed time series for one metric, sourced from the `daily_metrics`
 * store — the same store the 1-year backfill + background sync write to, and
 * that the Today screen reads. `daily_metrics` is already unique per (user,
 * date, metric), so no bucketing is needed. Weight additionally merges
 * manual `weight_logged` events (lib/weightRepository.ts, manual wins per
 * day). Also returns the
 * same calibration status as `/api/today` (cheap GROUP BY, computed on every
 * call) so the client can show a "still calibrating" banner alongside the
 * series.
 *
 * Response: { metric, points: [{ date: "YYYY-MM-DD", value }], calibration }  // points oldest → newest
 *
 * GET /api/trends?metrics=hrv_sdnn,resting_hr,...&days=30
 *
 * Batch variant for the Trends grid index — one round trip for however many
 * of the 19 raw `daily_metrics` names the client wants, each with its
 * baseline stats attached (see lib/trendsResponse.ts for the full response
 * shape/contract). Four DB queries total regardless of how many metrics are
 * requested. Unknown metric names are dropped from `series` and echoed in
 * `unknownMetrics` — never a 400, so a newer client asking for an unknown
 * metric loses a tile, not the whole screen.
 *
 * Response: { days, series: { [metric]: {...} }, unknownMetrics: [], calibration }
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import {
  queryMetricPoints,
  queryMetricPointsMulti,
  queryMetricDataDays,
  queryAllBaselines,
} from '@/lib/brain/tools';
import { importLegacyWeightLogIfPresent, queryManualWeightOverlay } from '@/lib/weightRepository';
import { getCalibration } from '@/lib/brain/baselines';
import { toDisplay } from '@/lib/metricCatalog';
import { buildTrendsBatch } from '@/lib/trendsResponse';
import { pickTimeZone } from '@/lib/localDay';

export const dynamic = 'force-dynamic';

const VALID_METRICS = new Set(['hrv', 'sleep', 'weight', 'steps', 'vo2', 'distance', 'rhr']);

// Trends metric name → daily_metrics metric name (legacy ?metric= branch
// only; the ?metrics= batch branch below uses raw daily_metrics names
// directly — see lib/trendsResponse.ts's contract notes).
const DAILY_METRIC: Record<string, string> = {
  hrv:      'hrv_sdnn',
  sleep:    'sleep_minutes',
  weight:   'body_mass_kg',
  steps:    'steps',
  vo2:      'vo2_max',
  distance: 'distance_m',
  rhr:      'resting_hr',
};

const MAX_BATCH_METRICS = 24;
const DEFAULT_BATCH_DAYS = 30;

/** Only queried when a weight overlay is actually needed (see both GET branches below). */
async function resolveUserTimezone(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return pickTimeZone(null, row?.timezone);
}

/**
 * Ensures any legacy weight-log.json for this user has been imported into
 * Postgres before reading the manual-weight overlay — iOS has zero callers
 * of POST/GET /api/weight-log (lib/weightRepository.ts's lazy-import call
 * site), so without this, a user who never opens that route would never see
 * their legacy manual weigh-ins here. importLegacyWeightLogIfPresent() is a
 * cheap no-op (no DB round trip) when the file doesn't exist — see its
 * lib/weightRepository.ts header and lib/weightRepository.test.ts.
 */
async function ensureLegacyWeightImported(userId: string): Promise<void> {
  const tz = await resolveUserTimezone(userId);
  await importLegacyWeightLogIfPresent(userId, tz);
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  // Batch branch is purely additive — checked first so the legacy ?metric=
  // path below is untouched in both order and behavior for every existing
  // request shape.
  if (searchParams.has('metrics')) {
    return handleBatch(request, searchParams);
  }

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
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const rawMetric = DAILY_METRIC[metric];
  const [raw, calibration] = await Promise.all([
    queryMetricPoints(userId, rawMetric, days),
    getCalibration(userId),
  ]);
  const byDate = new Map<string, number>();
  for (const p of raw) byDate.set(p.date, toDisplay(rawMetric, p.value));

  // Weight: overlay manual entries (manual wins per day), normalized to kg.
  if (metric === 'weight') {
    await ensureLegacyWeightImported(userId);
    for (const [date, kg] of await queryManualWeightOverlay(userId, days)) {
      byDate.set(date, toDisplay('body_mass_kg', kg));
    }
  }

  const points = [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({ metric, points, calibration });
}

async function handleBatch(request: Request, searchParams: URLSearchParams): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const days = Math.max(1, Math.min(365, Number(searchParams.get('days') ?? String(DEFAULT_BATCH_DAYS))));
  const requested = [
    ...new Set(
      (searchParams.get('metrics') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_BATCH_METRICS);

  const [points, baselines, dayCounts, calibration] = await Promise.all([
    queryMetricPointsMulti(userId, requested, days),
    queryAllBaselines(userId),
    queryMetricDataDays(userId, requested),
    getCalibration(userId),
  ]);

  let manualWeight: Map<string, number> | undefined;
  if (requested.includes('body_mass_kg')) {
    await ensureLegacyWeightImported(userId);
    manualWeight = await queryManualWeightOverlay(userId, days);
  }

  const { series, unknownMetrics } = buildTrendsBatch({ requested, points, baselines, dayCounts, manualWeight });

  return NextResponse.json({ days, series, unknownMetrics, calibration });
}

