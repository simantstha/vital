/**
 * GET /api/trends/drivers?metric=<raw daily_metrics outcome name>
 *
 * Feeds the iOS metric detail screen's "What moves your HRV" section.
 *
 * IMPORTANT: this route computes NOTHING new. It only reads `cross_lag`
 * findings the proactive insight engine (lib/insights/*) already certified —
 * findings that survived that engine's FDR-corrected hypothesis family
 * (lib/insights/evidence.ts) and were confirmed across two consecutive daily
 * runs (lib/insights/confirmation.ts). These are ASSOCIATIONS the engine
 * stood behind, NOT causes, and re-running any test here would bypass the
 * correction the engine already paid for. `pairs` in each driver is the
 * sample size behind its correlation — the client MUST show it alongside
 * any driver it renders.
 *
 * Response: { metric, computedFor: 'YYYY-MM-DD'|null, drivers: Driver[] }
 * — see lib/insights/drivers.ts for the Driver shape. `drivers` is empty
 * (never a 400) when `metric` isn't a recognized outcome metric, or when the
 * engine has no recent-enough run for this user.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { localDayKey, pickTimeZone } from '@/lib/localDay';
import { loadSeries } from '@/lib/insights/series';
import { computeDrivers, findingsForDay, latestComputedFor } from '@/lib/insights/drivers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const metric = searchParams.get('metric');
  if (!metric) {
    return NextResponse.json({ error: 'Missing required "metric" query param.' }, { status: 400 });
  }

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const [row] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const tz = pickTimeZone(searchParams.get('tz'), row?.timezone);
  const localToday = localDayKey(new Date(), tz);

  const result = await computeDrivers(
    { latestComputedFor, findingsForDay, loadSeries },
    userId,
    metric,
    localToday,
  );

  return NextResponse.json(result);
}
