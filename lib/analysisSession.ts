/**
 * Same-session detection for workout analyses (see the multi-device-analyses
 * contract, section A "Same-session rule"). Pure, DB-free — no `@/db`
 * import — so it's fully unit-testable with plain objects, same split as
 * lib/healthAnalysisReconciliation.ts.
 *
 * Goal 2 of that contract: one physical session (a run, a lift, a ride)
 * produces exactly one analysis and one notification, even when the Apple
 * Watch, WHOOP, and/or WHOOP's own copy written back into Apple Health all
 * recorded it. Two rows are "the same session" (isSameSession) when their
 * time ranges overlap by at least 50% of the shorter one's duration, or —
 * when both are WHOOP rows — when they share a `whoopId`. Which one survives
 * is decided by resolveSessionConflict's fixed priority order:
 *   1. a healthkit row whose sourceBundleId starts with 'com.apple.health',
 *      or a healthkit row with no sourceBundleId at all (older app builds
 *      that predate the field)
 *   2. any other healthkit row (e.g. a third-party app, or WHOOP's own copy
 *      written into Apple Health via its bundle id)
 *   3. a WHOOP row (source='whoop', written directly from the WHOOP API)
 *
 * The loser is deleted (`status='deleted'`, `notification_state='suppressed'`,
 * `deleted_at=now`) — but never a row that's already been notified: once a
 * notification has gone out for one candidate, that candidate is untouchable
 * (a duplicate must never un-send a notification), so the *other* candidate
 * becomes the loser instead, regardless of what the priority order would
 * otherwise say.
 */

export interface SessionWindow {
  startedAt: Date;
  endedAt: Date;
}

/**
 * Fraction of the shorter session's duration that the two windows overlap,
 * in [0, 1]. Zero-or-negative-duration windows (a malformed row) never
 * overlap with anything — better to miss a dedupe than divide by zero or
 * treat a degenerate window as matching everything.
 */
export function overlapRatio(a: SessionWindow, b: SessionWindow): number {
  const aDurationMs = a.endedAt.getTime() - a.startedAt.getTime();
  const bDurationMs = b.endedAt.getTime() - b.startedAt.getTime();
  const shorterMs = Math.min(aDurationMs, bDurationMs);
  if (!(shorterMs > 0)) return 0;

  const overlapStart = Math.max(a.startedAt.getTime(), b.startedAt.getTime());
  const overlapEnd = Math.min(a.endedAt.getTime(), b.endedAt.getTime());
  const overlapMs = Math.max(0, overlapEnd - overlapStart);
  return overlapMs / shorterMs;
}

export const SAME_SESSION_OVERLAP_THRESHOLD = 0.5;

export interface SessionIdentity extends SessionWindow {
  /** WHOOP's own record id — only meaningful when source === 'whoop'. */
  whoopId?: string | null;
  source: 'healthkit' | 'whoop';
}

/**
 * True when `a` and `b` are the same physical session: their windows overlap
 * by at least 50% of the shorter one's duration, OR both are WHOOP rows that
 * share a `whoopId` (defensive — in practice a duplicate whoopId is already
 * caught by the (user_id, hk_uuid) unique index before this function is ever
 * consulted, since WHOOP rows use hk_uuid = 'whoop:' + whoopId).
 */
export function isSameSession(a: SessionIdentity, b: SessionIdentity): boolean {
  if (a.source === 'whoop' && b.source === 'whoop' && a.whoopId && b.whoopId && a.whoopId === b.whoopId) {
    return true;
  }
  return overlapRatio(a, b) >= SAME_SESSION_OVERLAP_THRESHOLD;
}

export interface SessionCandidate {
  /** Row identifier (hk_uuid) — carried through so callers can act on the result. */
  key: string;
  source: 'healthkit' | 'whoop';
  /** Only meaningful for source === 'healthkit'. */
  sourceBundleId?: string | null;
  /** Already delivered a push for this row — makes it untouchable (see module doc). */
  notified: boolean;
}

/**
 * `users.primary_workout_device` — the "both devices" contract's preference
 * override (phase 2, PR A). null/undefined and 'apple' both mean "current
 * order" (Apple Health first); only 'whoop' changes the ranking.
 */
export type WorkoutDevicePreference = 'apple' | 'whoop' | null | undefined;

/**
 * 1 = highest priority (survives first), 3 = lowest. With no preference (or
 * 'apple'), this is the original fixed order: Apple Health bundle (or no
 * bundle) > other HealthKit > WHOOP. With preference 'whoop', WHOOP moves to
 * rank 1 and the two HealthKit ranks shift down by one, keeping their
 * relative order (native Apple Health beats a third-party HealthKit write).
 */
export function priorityRank(
  candidate: Pick<SessionCandidate, 'source' | 'sourceBundleId'>,
  preferredDevice?: WorkoutDevicePreference,
): 1 | 2 | 3 {
  const isNativeOrUnknownHealthKit = !candidate.sourceBundleId || candidate.sourceBundleId.startsWith('com.apple.health');
  if (preferredDevice === 'whoop') {
    if (candidate.source === 'whoop') return 1;
    return isNativeOrUnknownHealthKit ? 2 : 3;
  }
  if (candidate.source === 'whoop') return 3;
  return isNativeOrUnknownHealthKit ? 1 : 2;
}

export interface SessionConflictResolution {
  survivorKey: string;
  loserKey: string;
  /**
   * 'incoming_wins': existing must be deleted/suppressed, incoming proceeds normally.
   * 'existing_wins': incoming must be written as suppressed-on-arrival (or not written at all,
   *   for a source like WHOOP that only ever inserts once it knows it has won).
   */
  outcome: 'incoming_wins' | 'existing_wins';
}

/**
 * Decides which of two same-session candidates survives. `existing` is
 * already-persisted; `incoming` is the row about to be written. A
 * already-notified `existing` always wins, regardless of priority — the
 * incoming row is the one suppressed in that case (see module doc). This
 * also means an already-notified row is never demoted by a preference change
 * (phase 2, PR A: "An already-notified row is never demoted").
 */
export function resolveSessionConflict(
  existing: SessionCandidate,
  incoming: SessionCandidate,
  preferredDevice?: WorkoutDevicePreference,
): SessionConflictResolution {
  const incomingOutranks = !existing.notified
    && priorityRank(incoming, preferredDevice) < priorityRank(existing, preferredDevice);
  return incomingOutranks
    ? { survivorKey: incoming.key, loserKey: existing.key, outcome: 'incoming_wins' }
    : { survivorKey: existing.key, loserKey: incoming.key, outcome: 'existing_wins' };
}

/**
 * `dayKey` plus its immediate neighbors ("YYYY-MM-DD" each) — cheap insurance
 * against a session that crosses local midnight and ends up keyed to a
 * different local day on the other source's side (e.g. lib/whoop/mapping.ts
 * day-keys a sleep by its `start`, while a HealthKit workout's `workoutDate`
 * is whatever the phone bucketed it under). Used to widen the DB query for
 * same-session candidates a day in each direction rather than trying to
 * derive the exact matching day analytically.
 */
export function dayKeysAround(dayKey: string): string[] {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return [dayKey];
  const keys = [-1, 0, 1].map((offset) => new Date(date.getTime() + offset * 86_400_000).toISOString().slice(0, 10));
  return Array.from(new Set(keys));
}

/**
 * Parses a workout's `{ startTime, durationMin }` input_payload shape into a
 * `SessionWindow`, the same shape both the migration backfill and ongoing
 * ingest/WHOOP-sync writes use to populate started_at/ended_at. Returns null
 * when either field is missing or unparseable — "rows that can't be parsed
 * stay null" (multi-device-analyses contract), never a guessed window.
 */
export function parseWorkoutWindow(input: unknown): SessionWindow | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { startTime, durationMin } = input as Record<string, unknown>;
  if (typeof startTime !== 'string' || typeof durationMin !== 'number' || !Number.isFinite(durationMin)) return null;
  const startedAt = new Date(startTime);
  if (Number.isNaN(startedAt.getTime())) return null;
  const endedAt = new Date(startedAt.getTime() + durationMin * 60_000);
  if (endedAt <= startedAt) return null;
  return { startedAt, endedAt };
}
