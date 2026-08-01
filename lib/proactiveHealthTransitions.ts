import { localDayKey } from './localDay';

export const MAX_DELIVERY_RETRIES = 5;
export function reservedSleepCapacity(limit: number): number { return limit <= 0 ? 0 : Math.max(1, Math.floor(limit / 4)); }
export function shouldPersistDefaultPreferences(registrationResult: string): boolean { return registrationResult === 'registered'; }

/**
 * Freshness gate — see docs plan "Fix notification timing + metric precision".
 * A push only fires for something that genuinely just happened; late-syncing
 * events (Apple Watch → iPhone → app lag, background-delivery starvation,
 * retry backoff) still get a stored, viewable analysis, just no push.
 */
export const NOTIFICATION_FRESHNESS_MS = 6 * 60 * 60_000;
export type FreshnessBasis = 'event_end' | 'local_date';
export interface FreshnessVerdict { fresh: boolean; basis: FreshnessBasis; ageMs: number | null }

/**
 * Workout end instant from the raw HealthKit-shaped input payload, or `null`
 * when it can't be derived (missing/malformed `startTime`). Duration is
 * treated as zero when absent, non-finite, or negative, so a workout with a
 * real start but no duration still resolves to an end instant.
 */
export function workoutEndedAt(input: unknown): Date | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const startTime = (input as Record<string, unknown>).startTime;
  if (typeof startTime !== 'string') return null;
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  const durationRaw = (input as Record<string, unknown>).durationMin;
  const durationMin = typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : 0;
  return new Date(startMs + durationMin * 60_000);
}

/**
 * Reads `PROACTIVE_NOTIFICATION_FRESHNESS_HOURS` (default 6h); `0` disables
 * the gate entirely (the production kill switch — flip via a Fly secret,
 * no redeploy). Malformed/negative values fall back to the default rather
 * than silently disabling the gate.
 */
export function freshnessWindowMs(env: NodeJS.ProcessEnv): number {
  const raw = env.PROACTIVE_NOTIFICATION_FRESHNESS_HOURS;
  if (raw === undefined) return NOTIFICATION_FRESHNESS_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return NOTIFICATION_FRESHNESS_MS;
  return hours * 60 * 60_000;
}

/**
 * Workout: fresh iff it ended within `windowMs` of `now` (a negative age —
 * an in-progress workout, or clock skew — reads as fresh). Sleep, or a
 * workout whose `startTime` can't be parsed, falls back to one rule: fresh
 * iff `localDate` is still the user's current local calendar day.
 * `windowMs <= 0` disables the gate outright (always fresh).
 */
export function notificationFresh(args: {
  kind: 'workout' | 'sleep';
  input: unknown;
  localDate: string;
  timezone: string;
  now: Date;
  windowMs?: number;
}): FreshnessVerdict {
  const windowMs = args.windowMs ?? NOTIFICATION_FRESHNESS_MS;
  const end = args.kind === 'workout' ? workoutEndedAt(args.input) : null;
  if (end) {
    const ageMs = args.now.getTime() - end.getTime();
    return { fresh: windowMs <= 0 || ageMs <= windowMs, basis: 'event_end', ageMs };
  }
  return { fresh: windowMs <= 0 || localDayKey(args.now, args.timezone) === args.localDate, basis: 'local_date', ageMs: null };
}

export interface RetryTransition { retryCount: number; terminal: boolean; nextAttemptAt: Date }
export function retryTransition(retryCount: number, now: Date, maxRetries = MAX_DELIVERY_RETRIES): RetryTransition {
  const next = retryCount + 1;
  return { retryCount: next, terminal: next >= maxRetries, nextAttemptAt: new Date(now.getTime() + Math.min(360, 2 ** retryCount) * 60_000) };
}

export function ownsLease(actual: string | null, expected: string): boolean { return actual === expected; }
export function notificationClaimable(state: string, leaseExpiresAt: Date | null, nextAttemptAt: Date, now: Date): boolean {
  return nextAttemptAt <= now && (state === 'pending' || (state === 'sending' && leaseExpiresAt !== null && leaseExpiresAt <= now));
}

export interface DueCandidate { overdueMinutes: number; updatedAt: Date }
export function compareDueCandidates(a: DueCandidate, b: DueCandidate): number {
  return b.overdueMinutes - a.overdueMinutes || a.updatedAt.getTime() - b.updatedAt.getTime();
}

export interface MorningClaimAdapter<T> {
  tryInsert(actor: 'sleep' | 'brief'): Promise<T | null>;
  tryRecover(actor: 'sleep' | 'brief'): Promise<T | null>;
}
export async function claimMorningSlot<T>(adapter: MorningClaimAdapter<T>, actor: 'sleep' | 'brief'): Promise<T | null> {
  return await adapter.tryInsert(actor) ?? adapter.tryRecover(actor);
}

export interface MorningFailureAdapter { apply(ownerToken: string, transition: RetryTransition): Promise<boolean> }
export async function failOwnedMorningSlot(adapter: MorningFailureAdapter, ownerToken: string, retryCount: number, now: Date): Promise<boolean> {
  return adapter.apply(ownerToken, retryTransition(retryCount, now));
}
