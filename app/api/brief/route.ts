/**
 * GET /api/brief  — return cached brief (or generate if stale)
 * POST /api/brief — force-regenerate brief
 *
 * Biometrics sourced from Postgres HealthKit events via lib/brain/brief.ts.
 * Whoop / Strava / MFP integrations have been removed.
 */

import { NextResponse } from 'next/server';
import { getCachedBrief, cacheBrief } from '@/lib/briefCache';
import { generateDailyBriefFromDb } from '@/lib/brain/brief';
import { getOrCreateDevUser } from '@/lib/brain/user';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cached = getCachedBrief();
  if (cached) return NextResponse.json(cached);
  return generate();
}

export async function POST() {
  return generate();
}

async function generate() {
  try {
    const userId = await getOrCreateDevUser();
    const brief  = await generateDailyBriefFromDb(userId);
    cacheBrief(brief);
    return NextResponse.json(brief);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
