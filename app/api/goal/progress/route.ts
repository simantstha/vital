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
 *   distance: { targetKm, thisWeekKm, avg4wKm, weekStart, stepTargetKm, text } | null,   // endurance + distance target only; stepTargetKm = this week's safe step from last week's km (== targetKm when no step applies)
 *   race: { date, distanceKm, label, weeksToGo, daysToGo } | null,          // endurance + upcoming race only
 *   longRun: { lastKm, peakKm, targetPeakKm | null } | null,                // endurance + running distances in the last 28 days; km
 *   current: { weightKg, startWeightKg, changeKg, progressPct },
 *   ratePerWeek: { kg, pctBodyweight },          // signed: negative = losing
 *   safeBand: { minPct, maxPct } | null,
 *   eta: 'YYYY-MM-DD' | null,
 *   onPaceForTargetDate: boolean | null,
 *   verdict: 'reached' | 'on_track' | 'ahead' | 'too_fast' | 'behind' | 'stalled' |
 *            'progressing' | 'building' | 'holding' | 'needs_target' | 'insufficient_data',
 *            // 'reached': weight target met (weight_loss <= target, muscle >= target) with a weigh-in
 *            // <= 14 days old. Muscle only reads 'reached' after sessions-behind -> 'behind' and
 *            // stalled lifts -> 'stalled' have been ruled out. current.progressPct is 100 and there
 *            // is no eta.
 *   headline: string,                            // plain English, <= 70 chars; reached: "Goal reached — 72 kg (Sep 20)"
 *   reasons: [{ kind, text, tone: 'good' | 'watch' | 'neutral' }],   // max 3; kinds include 'next_step'
 *                                                //   ("Set a new target or switch to maintenance", neutral, last when reached),
 *                                                //   'reached', 'position' and 'weigh_in_age' ("Based on a weigh-in N days ago")
 *   reachedAt: 'YYYY-MM-DD' | null,              // weight goals only: day of the first trend point that crossed the target
 *                                                //   since the goal began; null when not reached, the weigh-in is stale or unknown
 *   lastWeighInDaysAgo: number | null,           // staleness: > 14 -> verdict 'insufficient_data' ("Last weigh-in N days ago —
 *                                                //   weigh in to update your progress"), no eta; 7-14 -> verdict kept, eta and
 *                                                //   onPaceForTargetDate null. The eta is never moved forward to today.
 *   lastSessionDaysAgo: number | null,           // newest session in the trailing 28 days (strength sessions for muscle); null if none
 *   adherence: { done, planned, weeklyTarget, pct, windowDays } | null,   // muscle + weekly sessions target only; the window is
 *                                                //   28 days, or the goal's age (min 7) while it is newer: planned = weeklyTarget x windowDays / 7
 *   dataSufficiency: { weighIns, needed, sessionsLast28d }
 * }
 *
 * "Last 4 weeks" stats shrink to the goal's age for a new goal and say so in their text ("… in 10 days",
 * "Active on 4 of the last 6 days", weight rate "over 9 days").
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
