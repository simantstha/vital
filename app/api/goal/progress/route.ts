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
 *   distance: { targetKm, thisWeekKm, avg4wKm, weekStart, stepTargetKm, text, plan? } | null,   // endurance + distance target only; stepTargetKm = THIS WEEK's target from the one week plan
 *                                                //   (lib/enduranceProgression.ts): the safe step, a hold / restart number, or a taper / race-week / recovery
 *                                                //   target (== targetKm when no step applies, and in a baseline week); avg4wKm = mean of the last 4 FINISHED
 *                                                //   training weeks (race and recovery weeks left out); plan? (additive) = { kind: baseline | build | hold |
 *                                                //   restart | maintain | taper | race_week | recovery | rebuild, targetKm | null, longRunKm | null, purpose,
 *                                                //   and, only when true (additive): cutback, lightWeek, strides, longRunHeld, upTo }; on the race eve
 *                                                //   thisWeekKm is null and text is "Race tomorrow" (the week's km are not on the card); on race day thisWeekKm is
 *                                                //   null too (wave 22e) and text is "Race done — 21.1 km" once the race is logged, else "Race day" (iOS decodes
 *                                                //   thisWeekKm as optional)
 *   race: { date, distanceKm, label, weeksToGo, daysToGo, phase?, daysSince?, completed? } | null,   // endurance + upcoming race, or within the recovery weeks;
 *                                                //   phase is read on the Monday of this calendar week (a Sunday 7 days out is still the taper week);
 *                                                //   completed? (additive) = { km, durationMin | null } once a race-length run is logged
 *   longRun: { lastKm, peakKm, targetPeakKm | null, nextKm? } | null,       // endurance; km; lastKm = longest run of the last 14 days, peakKm of the last 28;
 *                                                //   nextKm? (additive) = this week's long run from the plan; capNoteDue? / oversized? (additive, only when
 *                                                //   true) = the long-run cap note is due this week / the peak was over 55% of its week
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
