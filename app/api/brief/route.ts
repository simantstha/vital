/**
 * GET /api/brief  — return cached brief (or generate if stale)
 * POST /api/brief — force-regenerate brief
 *
 * Biometrics sourced from Postgres HealthKit events via lib/brain/brief.ts.
 * Whoop / Strava / MFP integrations have been removed.
 */

import { NextResponse } from 'next/server';
import { setCachedBrief, briefCacheKey, todayKey } from '@/lib/brain/briefCache';
import { generateDailyBriefFromDb } from '@/lib/brain/brief';
import { getUserIdFromRequest } from '@/lib/auth';

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
    // doesn't have to regenerate again for the rest of the day.
    setCachedBrief(briefCacheKey(userId, todayKey()), {
      insight: brief.body,
      plan: brief.meals.map(m => ({ name: m.k, kcal: m.kcal, why: m.why })),
    });
    return NextResponse.json(brief);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
