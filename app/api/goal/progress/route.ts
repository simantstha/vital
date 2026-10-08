/**
 * GET /api/goal/progress[?tz=<IANA zone>]
 *
 * "Am I getting where I want to go?" — the user's progress toward their goal
 * target (users.goal + target_weight_kg / target_date / weekly_sessions_target),
 * computed by lib/goalProgress.ts from the existing weight trend, intake,
 * lifts, sessions and vitals. Day math is in the user's timezone (request `tz`
 * param, else users.timezone, else UTC).
 *
 * Response (camelCase; every unknown value is null, never guessed):
 * {
 *   goal: 'weight_loss' | 'muscle' | 'endurance' | 'general',
 *   target:  { weightKg, date, weeklySessions, weeklyDistanceKm },
 *   distance: { targetKm, thisWeekKm, avg4wKm, weekStart, text } | null,   // endurance + distance target only
 *   race: { date, distanceKm, label, weeksToGo, daysToGo } | null,          // endurance + upcoming race only
 *   longRun: { lastKm, peakKm, targetPeakKm | null } | null,                // endurance + running distances in the last 28 days; km
 *   current: { weightKg, startWeightKg, changeKg, progressPct },
 *   ratePerWeek: { kg, pctBodyweight },          // signed: negative = losing
 *   safeBand: { minPct, maxPct } | null,
 *   eta: 'YYYY-MM-DD' | null,
 *   onPaceForTargetDate: boolean | null,
 *   verdict: 'on_track' | 'ahead' | 'too_fast' | 'behind' | 'stalled' |
 *            'progressing' | 'building' | 'holding' | 'needs_target' | 'insufficient_data',
 *   headline: string,                            // plain English, <= 70 chars
 *   reasons: [{ kind, text, tone: 'good' | 'watch' | 'neutral' }],   // max 3
 *   adherence: { done, planned, weeklyTarget, pct } | null,        // muscle + weekly sessions target only (28 days: done of weeklyTarget x 4)
 *   dataSufficiency: { weighIns, needed, sessionsLast28d }
 * }
 *
 * Auth: session JWT via middleware -> x-user-id (401 otherwise); 404 if the user row is gone.
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { loadGoalProgress } from '@/lib/goalProgressLoader';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  try {
    const tz = new URL(request.url).searchParams.get('tz');
    const progress = await loadGoalProgress(userId, { tz });
    if (!progress) return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    return NextResponse.json(progress);
  } catch (err) {
    console.error('[/api/goal/progress] failed:', err);
    return NextResponse.json({ error: 'Failed to compute goal progress' }, { status: 500 });
  }
}
