/**
 * Vital — weekly review worker pass (pure; all I/O injected)
 *
 * On Monday morning (the user's local time, at/after their morning-brief
 * time — the send TIME reuses the morning brief time, but the on/off switch is
 * the separate weekly_review_enabled preference, applied by listCandidates), generate the review for the week that
 * just ended and send exactly ONE push. The pass is wired to the real
 * database / APNs client in scripts/proactive-health-worker.ts.
 *
 * At-most-once: `claimPush` stamps weekly_reviews.pushed_at before anything is
 * sent, so a restart, a second worker or the next 15 s tick never re-sends.
 * A review with too little data is claimed (so it isn't recomputed every
 * tick) but never pushed — an empty "Your week" notification is noise.
 */

import type { PushDevice, PushOutcome } from './proactiveHealthWorker';
import { lastCompletedWeekStart, type WeeklyReview } from './weeklyReview';
import { localDayKey } from './localDay';

export interface WeeklyReviewCandidate {
  userId: string;
  /** Notification-preferences timezone (IANA). */
  timezone: string;
  /** morning_brief_time_minutes (send time only; enablement is weekly_review_enabled). */
  morningMinutes: number;
  /** notification_preferences.weekly_review_enabled; false skips the user entirely. Defaults to true when omitted. */
  weeklyReviewEnabled?: boolean;
}

export interface WeeklyReviewPassDeps {
  /** Should already exclude users whose current-week review has pushed_at set. */
  listCandidates(): Promise<WeeklyReviewCandidate[]>;
  /** Computes + stores the last completed week's review when missing. */
  getOrCreate(userId: string, timezone: string, now: Date): Promise<{ id: string; review: WeeklyReview } | null>;
  /** True only for the caller that flips pushed_at from null — the at-most-once guard. */
  claimPush(reviewId: string, now: Date): Promise<boolean>;
  /** Undo a claim (pushed_at back to null) when nothing could be sent, so the review can still go once a device registers. Optional. */
  releaseClaim?(reviewId: string): Promise<void>;
  listDevices(userId: string): Promise<PushDevice[]>;
  /** Best-effort notification-inbox record; never throws. Optional so tests/other callers can omit it. */
  recordInbox?(userId: string, alert: { title: string; body: string }, route: { type: 'weekly_review'; id: string; deepLink: string }): Promise<void>;
  send(device: PushDevice, alert: { title: string; body: string }, route: { type: 'weekly_review'; id: string; deepLink: string }): Promise<PushOutcome>;
  retireDevice(deviceId: string, now: Date): Promise<void>;
  onError?(userId: string, error: unknown): void;
}

function localParts(now: Date, timezone: string): { weekday: string; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return { weekday: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
  } catch {
    const d = new Date(now);
    return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()], minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}

/** True on a local Monday at/after the user's morning time. */
export function isWeeklyReviewDue(now: Date, timezone: string, morningMinutes: number): boolean {
  const { weekday, minutes } = localParts(now, timezone);
  return weekday === 'Mon' && minutes >= morningMinutes;
}

export function weeklyReviewAlert(review: WeeklyReview): { title: string; body: string } {
  return { title: 'Your week', body: review.headline };
}

export type WeeklyReviewOutcome = 'sent' | 'no_devices' | 'insufficient_data' | 'already_pushed' | 'no_review';

/** Max review computations (getOrCreate calls) per tick; the rest wait for the next tick. */
export const WEEKLY_REVIEW_MAX_PER_TICK = 25;
/** After a failure, leave the user alone this long so a broken user can't cost ~25 queries every 15 s tick. */
export const WEEKLY_REVIEW_ERROR_BACKOFF_MS = 5 * 60_000;

/** In-memory, per-process progress. Pass the same object on every tick. */
export interface WeeklyReviewPassState {
  /** `${userId}|${reviewedWeekStart}` of reviews finished for this process (pushed / claimed / nothing to do). */
  done: Set<string>;
  /** Same key -> epoch ms before which the user is not retried after an error. */
  retryAt: Map<string, number>;
}

export function createWeeklyReviewPassState(): WeeklyReviewPassState {
  return { done: new Set(), retryAt: new Map() };
}

export async function runWeeklyReviewPass(
  now: Date,
  deps: WeeklyReviewPassDeps,
  state: WeeklyReviewPassState = createWeeklyReviewPassState(),
  opts: { maxPerTick?: number } = {},
): Promise<Array<{ userId: string; outcome: WeeklyReviewOutcome }>> {
  const maxPerTick = opts.maxPerTick ?? WEEKLY_REVIEW_MAX_PER_TICK;
  const results: Array<{ userId: string; outcome: WeeklyReviewOutcome }> = [];
  const candidates = await deps.listCandidates();
  let computed = 0;
  for (const candidate of candidates) {
    if (candidate.weeklyReviewEnabled === false) continue;
    if (!isWeeklyReviewDue(now, candidate.timezone, candidate.morningMinutes)) continue;
    const key = `${candidate.userId}|${lastCompletedWeekStart(localDayKey(now, candidate.timezone))}`;
    if (state.done.has(key)) continue;
    if ((state.retryAt.get(key) ?? 0) > now.getTime()) continue;
    if (computed >= maxPerTick) break; // bounded work per tick; the rest go next tick
    computed++;

    let stage = 'getOrCreate';
    let reviewId: string | null = null;
    let claimed = false;
    try {
      const stored = await deps.getOrCreate(candidate.userId, candidate.timezone, now);
      if (!stored) { state.done.add(key); results.push({ userId: candidate.userId, outcome: 'no_review' }); continue; }
      reviewId = stored.id;
      stage = 'claimPush';
      if (!(await deps.claimPush(stored.id, now))) { state.done.add(key); results.push({ userId: candidate.userId, outcome: 'already_pushed' }); continue; }
      claimed = true;
      if (!stored.review.dataSufficiency.sufficient) { state.done.add(key); results.push({ userId: candidate.userId, outcome: 'insufficient_data' }); continue; }
      stage = 'listDevices';
      const devices = await deps.listDevices(candidate.userId);
      if (devices.length === 0) {
        // Nothing was (or could be) sent: hand the claim back so the review can
        // still go if a device registers later today. Not marked done.
        stage = 'releaseClaim';
        await deps.releaseClaim?.(stored.id);
        claimed = false;
        results.push({ userId: candidate.userId, outcome: 'no_devices' });
        continue;
      }
      const alert = weeklyReviewAlert(stored.review);
      const route = { type: 'weekly_review' as const, id: stored.id, deepLink: `vital://weekly-review/${stored.id}` };
      stage = 'recordInbox';
      await deps.recordInbox?.(candidate.userId, alert, route);
      stage = 'send';
      for (const device of devices) {
        const outcome = await deps.send(device, alert, route);
        if (outcome.retireToken) await deps.retireDevice(device.id, now);
      }
      state.done.add(key);
      results.push({ userId: candidate.userId, outcome: 'sent' });
    } catch (error) {
      state.retryAt.set(key, now.getTime() + WEEKLY_REVIEW_ERROR_BACKOFF_MS);
      const detail = error instanceof Error ? error.message : String(error);
      const where = `weekly review ${reviewId ?? '(none)'} failed at ${stage} (user ${candidate.userId}, tz ${candidate.timezone})`;
      deps.onError?.(
        candidate.userId,
        new Error(claimed ? `${where} AFTER claim; at-most-once, will not be re-sent: ${detail}` : `${where}: ${detail}`, { cause: error }),
      );
    }
  }
  return results;
}
