/**
 * GET /api/trends?metric=hrv|sleep|weight|steps&days=30
 *
 * Day-keyed time series for one metric, sourced from the `daily_metrics` store
 * — the same store the 1-year backfill + background sync write to, and that the
 * Today screen reads. `daily_metrics` is already unique per (user, date, metric),
 * so no bucketing is needed. Weight additionally merges manual weight-log.json
 * entries (manual wins per day).
 *
 * Response: { metric, points: [{ date: "YYYY-MM-DD", value }] }  // oldest → newest
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { queryMetricPoints } from '@/lib/brain/tools';
import { readWeightLog } from '@/lib/weightLog';

export const dynamic = 'force-dynamic';

const VALID_METRICS = new Set(['hrv', 'sleep', 'weight', 'steps']);

// Trends metric name → daily_metrics metric name
const DAILY_METRIC: Record<string, string> = {
  hrv:    'hrv_sdnn',
  sleep:  'sleep_minutes',
  weight: 'body_mass_kg',
  steps:  'steps',
};

function transform(metric: string, value: number): number {
  switch (metric) {
    case 'sleep':  return Math.round((value / 60) * 10) / 10; // minutes → hours (1dp)
    case 'weight': return Math.round(value * 10) / 10;        // kg (1dp)
    case 'hrv':    return Math.round(value);                  // ms
    case 'steps':  return Math.round(value);
    default:       return value;
  }
}

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
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const raw = await queryMetricPoints(userId, DAILY_METRIC[metric], days);
  const byDate = new Map<string, number>();
  for (const p of raw) byDate.set(p.date, transform(metric, p.value));

  // Weight: overlay manual entries (manual wins per day), normalized to kg.
  if (metric === 'weight') {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const sinceStr = since.toISOString().split('T')[0];
    for (const e of readWeightLog(userId)) {
      if (e.date < sinceStr) continue;
      const kg = e.unit === 'lbs' ? e.weight * 0.453592 : e.weight;
      byDate.set(e.date, Math.round(kg * 10) / 10);
    }
  }

  const points = [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({ metric, points });
}
