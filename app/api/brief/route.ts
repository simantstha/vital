/**
 * GET /api/brief  — return cached brief (or generate if stale)
 * POST /api/brief — force-regenerate brief
 *
 * Biometrics sourced from Postgres HealthKit events via lib/brain/brief.ts.
 * Whoop / Strava / MFP integrations have been removed.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { setCachedBrief, briefCacheKey } from '@/lib/brain/briefCache';
import { generateDailyBriefFromDb } from '@/lib/brain/brief';
import { getUserIdFromRequest } from '@/lib/auth';
import { localDayKey } from '@/lib/localDay';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }
  return generate(userId);
}

async function generate(userId: string) {
  try {
    const brief = await generateDailyBriefFromDb(userId);
    // Warm the shared per-user brief cache (also read by /api/today) so it
    // doesn't have to regenerate again for the rest of the day. Key by the
    // user's local day (from their stored tz) so it matches /api/today and
    // rolls over at local midnight, not UTC midnight.
    const [user] = await db
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const dayKey = localDayKey(new Date(), user?.timezone);
    setCachedBrief(briefCacheKey(userId, dayKey), {
      insight: brief.body,
      plan: brief.meals.map(m => ({ name: m.k, kcal: m.kcal, why: m.why })),
    });
    return NextResponse.json(brief);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
