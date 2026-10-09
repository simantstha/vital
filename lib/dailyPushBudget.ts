/**
 * Shared per-user daily budget for server-initiated, non-brief pushes.
 *
 * Besides the morning brief, a user gets at most ONE of: weekly review, coach
 * nudge, workout/sleep analysis push, per local day. The weekly review wins on
 * its day: on a user's local Monday (review enabled) coach nudges stand down
 * entirely, even before the review has gone out, so the review never loses a
 * race to a nudge. Pure; the worker feeds it timestamps from existing tables
 * (pending_nudges.sent_at, weekly_reviews.pushed_at, notification_inbox).
 */

import { localDayKey, weekStartKeyForDay } from './localDay';

/** How far back the worker needs to look to cover any timezone's "today". */
export const PUSH_BUDGET_LOOKBACK_MS = 48 * 60 * 60_000;

export function countPushesOnLocalDay(stamps: Array<Date | null | undefined>, tz: string, now: Date): number {
  const today = localDayKey(now, tz);
  let n = 0;
  for (const s of stamps) if (s && localDayKey(s, tz) === today) n++;
  return n;
}

export function isLocalMonday(now: Date, tz: string): boolean {
  const day = localDayKey(now, tz);
  return weekStartKeyForDay(day) === day;
}

/** True when a coach nudge must not be sent right now for this user. */
export function nudgeBlockedByDailyBudget(input: {
  now: Date;
  tz: string;
  weeklyReviewEnabled: boolean;
  /** Timestamps of non-brief pushes already sent (any day within the lookback). */
  nonBriefPushStamps: Array<Date | null | undefined>;
}): boolean {
  if (input.weeklyReviewEnabled && isLocalMonday(input.now, input.tz)) return true;
  return countPushesOnLocalDay(input.nonBriefPushStamps, input.tz, input.now) >= 1;
}
