/**
 * GET /api/training/summary?tz=
 *
 * Feeds the Today-screen muscle/endurance "training" hero (PR #199), which
 * had to omit last-lift, this-week session dots, and weekly endurance
 * volume because no REST endpoint exposed them. This route is read-only and
 * adds no schema — it composes existing repositories:
 *   - lib/workoutRepository.ts  (logged workout_sets — completed sessions, lastLift)
 *   - lib/brain/tools.ts's queryWorkouts (HealthKit `workouts` daily_metrics — distance)
 *   - plan_items (kind='move')  (planned training sessions)
 * See lib/trainingSummary.ts for the aggregation and its honesty-rule notes.
 *
 * Week semantics: the *local* week (Monday..Sunday) containing the caller's
 * current local day, computed the same way every other route resolves "now"
 * — `?tz=` (freshest, tracks travel) else the user's stored `users.timezone`
 * else UTC (see lib/localDay.ts pickTimeZone/localDayKey). A day's activity
 * is bucketed by its own local_day column (workout_sets, plan_items), so a
 * late-Sunday-night workout in the caller's zone lands in that Sunday, not
 * the following Monday, regardless of server clock.
 *
 * Response:
 * {
 *   week: {
 *     start: "YYYY-MM-DD",              // local Monday
 *     plannedSessions: number | null,   // distinct days this week with a 'move' plan item; null when none exist (no plan data, not zero)
 *     completedSessions: number,        // distinct days this week with a logged (non-warmup) set OR a real (>=10min) HealthKit workout — a union, so a day with both counts once
 *     days: [{ date, planned, completed }]  // Mon..Sun, for the "● ● ○ ○" dots
 *   },
 *   volume: { unit: "km", done: number | null, target: number | null }, // done: null when no workout this week carries a distance reading; target: always null today (no plan/goal in this schema defines one)
 *   lastLift: { exercise, date, sets, reps, weightKg } | null,
 * }
 *
 * lastLift is NOT "today's planned main lift" — plan_items 'move' rows are
 * free-text and user-added only, with no reliable mapping to a
 * workout_sets.exercise value, so it can't be matched against the plan.
 * It's defined instead as the top (heaviest) working set of the user's most
 * recent strength session, whichever exercise that was — see
 * lib/workoutRepository.ts's getLastLift/computeLastLift.
 *
 * Weight stays in kg on the wire, like every other route; iOS converts.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { localDayKey, pickTimeZone } from '@/lib/localDay';
import { resolveTrainingSummary } from '@/lib/trainingSummary';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const paramTz = new URL(request.url).searchParams.get('tz');

  let userRow: (typeof schema.users.$inferSelect) | undefined;
  try {
    [userRow] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  } catch (err) {
    return NextResponse.json({ error: `DB read error: ${String(err)}` }, { status: 500 });
  }

  const tz = pickTimeZone(paramTz, userRow?.timezone);
  const todayKey = localDayKey(new Date(), tz);

  const summary = await resolveTrainingSummary(userId, todayKey);

  return NextResponse.json(summary);
}
