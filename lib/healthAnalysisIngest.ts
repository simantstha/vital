import {
  dayKeysAround,
  parseWorkoutWindow,
  resolveSessionConflict,
  isSameSession,
  type SessionCandidate,
  type SessionIdentity,
  type WorkoutDevicePreference,
} from './analysisSession';
import {
  reconcilePersistedWorkouts,
  shouldRefreshSleepAnalysis,
  sleepAnalysisCandidate,
  type HealthKitWorkout,
} from './healthAnalysisReconciliation';
import { resolveSleepWrite, type SleepDevicePreference, type SleepSource } from './sleepOwnership';

export interface PersistedWorkoutAnalysis {
  hkUuid: string;
  workoutDate: string;
  contentFingerprint: string;
  status: string;
  notificationState?: string;
  notificationSentAt?: Date | null;
  /** Present on rows returned by a source-scoped query; absent means "assume healthkit" (see healthAnalysisReconciliation.ts). */
  source?: string;
}

export interface PersistedSleepAnalysis {
  wakeDate: string;
  contentFingerprint: string;
  notificationState?: string;
  notificationSentAt?: Date | null;
  /** 'healthkit' | 'whoop' — the source that currently owns this night's primary row (see reconcileAnalysisIngest below). */
  source?: string;
  /**
   * The persisted row's own input_payload — only needed when an ownership
   * swap (phase 2 PR A) must archive it into secondary_payload before being
   * overwritten. Optional so older callers/test doubles that never select it
   * keep working (a swap simply can't archive without it, which is no worse
   * than today's behavior of not swapping at all).
   */
  inputPayload?: unknown;
}

/**
 * A same-session candidate from ANY source (healthkit or whoop), used only
 * for the cross-source overlap/priority check (lib/analysisSession.ts) — a
 * broader read than listWorkoutAnalyses's source='healthkit' scope, which
 * exists purely to protect the vanished-hkUuid deletion path (see the guard
 * comment on reconcilePersistedWorkouts).
 */
export interface WorkoutSessionCandidate {
  hkUuid: string;
  source: 'healthkit' | 'whoop';
  sourceBundleId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  notified: boolean;
}

export interface WorkoutAnalysisUpsert {
  workoutDate: string;
  workout: HealthKitWorkout;
  fingerprint: string;
  notificationState: 'pending' | 'sent';
  receivedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface SleepAnalysisUpsert {
  wakeDate: string;
  sleep: { minutes: number; stages?: unknown };
  fingerprint: string;
  analyzeAfter: Date;
  notificationState: 'pending' | 'sent';
  receivedAt: Date;
  /**
   * Set when this primary write is taking over the night from a persisted
   * row of the OTHER source (an ownership swap) — that row's payload must be
   * archived into secondary_source/secondary_payload rather than overwritten
   * and lost. `null`/absent means no archiving is needed.
   */
  archiveSecondary?: { source: SleepSource; payload: unknown } | null;
}

export interface SecondarySleepWrite {
  wakeDate: string;
  secondarySource: SleepSource;
  secondaryPayload: unknown;
}

export interface AnalysisIngestRepository {
  lockUser(userId: string): Promise<void>;
  /** Scoped to source='healthkit' — see reconcilePersistedWorkouts's guard comment. */
  listWorkoutAnalyses(
    userId: string,
    workoutDates: string[],
    currentHkUuids: string[],
  ): Promise<PersistedWorkoutAnalysis[]>;
  /** Source-agnostic (healthkit + whoop) — feeds the same-session conflict check. */
  listWorkoutSessionCandidates(userId: string, dayKeys: string[]): Promise<WorkoutSessionCandidate[]>;
  markWorkoutsDeleted(userId: string, hkUuids: string[], receivedAt: Date): Promise<void>;
  upsertWorkout(userId: string, entry: WorkoutAnalysisUpsert): Promise<void>;
  /**
   * Marks a same-session loser: status='deleted', notification_state='suppressed',
   * deleted_at=receivedAt, merged_into_id=<the survivor's row id, looked up by
   * survivorHkUuid>. Never called on an already-notified row (see
   * resolveSessionConflict). `survivorHkUuid` must already be a persisted row
   * by the time this is called — never set for a HealthKit deletion, only for
   * a same-session suppression (see db/schema.ts's merged_into_id doc).
   */
  suppressWorkout(userId: string, hkUuid: string, survivorHkUuid: string, receivedAt: Date): Promise<void>;
  listSleepAnalyses(userId: string, wakeDates: string[]): Promise<PersistedSleepAnalysis[]>;
  upsertSleep(userId: string, entry: SleepAnalysisUpsert): Promise<void>;
  /** Stores the non-owning source's payload without touching the owning row's primary fields — see lib/sleepOwnership.ts. */
  writeSecondarySleep(userId: string, entry: SecondarySleepWrite): Promise<void>;
  /** `users.primary_workout_device` / `users.primary_sleep_device` (phase 2 "both devices" contract, PR A). Optional: absent means "no preference support" (treated as null/auto), keeping older test doubles compiling unchanged. */
  getWorkoutDevicePreference?(userId: string): Promise<'apple' | 'whoop' | null>;
  getSleepDevicePreference?(userId: string): Promise<'apple' | 'whoop' | null>;
}

function notificationState(
  persisted?: { notificationState?: string; notificationSentAt?: Date | null },
): 'pending' | 'sent' {
  return persisted?.notificationSentAt || persisted?.notificationState === 'sent' ? 'sent' : 'pending';
}

function extractSourceBundleId(workout: HealthKitWorkout): string | null {
  const value = (workout as Record<string, unknown>).sourceBundleId;
  return typeof value === 'string' ? value : null;
}

/**
 * Resolves a new/changed HealthKit workout against any already-persisted
 * same-session row (HealthKit or WHOOP) using the overlap + priority rules in
 * lib/analysisSession.ts. Returns the full survivor/loser resolution, or null
 * when there's no conflict at all.
 */
function resolveWorkoutSessionConflict(
  candidates: WorkoutSessionCandidate[],
  incoming: { hkUuid: string; workout: HealthKitWorkout; startedAt: Date; endedAt: Date },
  preferredDevice: WorkoutDevicePreference,
): { loserHkUuid: string; survivorHkUuid: string } | null {
  const incomingIdentity: SessionIdentity = { startedAt: incoming.startedAt, endedAt: incoming.endedAt, source: 'healthkit' };
  const match = candidates.find((candidate) => {
    if (candidate.hkUuid === incoming.hkUuid) return false;
    if (candidate.startedAt == null || candidate.endedAt == null) return false;
    const candidateIdentity: SessionIdentity = {
      startedAt: candidate.startedAt,
      endedAt: candidate.endedAt,
      source: candidate.source,
    };
    return isSameSession(candidateIdentity, incomingIdentity);
  });
  if (!match) return null;

  const existingCandidate: SessionCandidate = {
    key: match.hkUuid,
    source: match.source,
    sourceBundleId: match.sourceBundleId,
    notified: match.notified,
  };
  const incomingCandidate: SessionCandidate = {
    key: incoming.hkUuid,
    source: 'healthkit',
    sourceBundleId: extractSourceBundleId(incoming.workout),
    notified: false, // a workout we're inserting/updating this tick has never been notified yet
  };
  const resolution = resolveSessionConflict(existingCandidate, incomingCandidate, preferredDevice);
  return { loserHkUuid: resolution.loserKey, survivorHkUuid: resolution.survivorKey };
}

function isNotified(persisted?: { notificationState?: string; notificationSentAt?: Date | null }): boolean {
  return Boolean(persisted?.notificationSentAt) || persisted?.notificationState === 'sent';
}

export async function reconcileAnalysisIngest(
  repository: AnalysisIngestRepository,
  userId: string,
  workoutDays: Array<{ workoutDate: string; workouts: HealthKitWorkout[] }>,
  sleepDays: Array<{ wakeDate: string; sleep: { minutes: number; stages?: unknown } }>,
  receivedAt: Date,
): Promise<void> {
  await repository.lockUser(userId);

  const [workoutPreference, sleepPreference]: [WorkoutDevicePreference, SleepDevicePreference] = await Promise.all([
    repository.getWorkoutDevicePreference ? repository.getWorkoutDevicePreference(userId) : Promise.resolve(null),
    repository.getSleepDevicePreference ? repository.getSleepDevicePreference(userId) : Promise.resolve(null),
  ]);

  const persistedWorkouts = await repository.listWorkoutAnalyses(
    userId,
    workoutDays.map((day) => day.workoutDate),
    workoutDays.flatMap((day) => day.workouts.map((workout) => workout.hkUuid)),
  );
  const sessionDayKeys = Array.from(new Set(workoutDays.flatMap((day) => dayKeysAround(day.workoutDate))));
  // Keyed by hkUuid and kept current through the upsert loop below (see its
  // comment): two same-session HealthKit workouts arriving in the SAME
  // upload (e.g. the Watch's own run plus WHOOP's copy written into Apple
  // Health, both brand new) must still resolve against EACH OTHER, not just
  // against whatever was already persisted before this call started.
  const sessionCandidates = new Map<string, WorkoutSessionCandidate>(
    sessionDayKeys.length > 0
      ? (await repository.listWorkoutSessionCandidates(userId, sessionDayKeys)).map((c) => [c.hkUuid, c])
      : [],
  );
  const persistedSleeps = await repository.listSleepAnalyses(
    userId,
    sleepDays.map((day) => day.wakeDate),
  );
  const workoutsById = new Map(persistedWorkouts.map((entry) => [entry.hkUuid, entry]));
  const sleepsByDate = new Map(persistedSleeps.map((entry) => [entry.wakeDate, entry]));
  const workoutReconciliation = reconcilePersistedWorkouts(
    persistedWorkouts,
    workoutDays.flatMap((day) => day.workouts.map((workout) => ({
      workoutDate: day.workoutDate,
      workout,
    }))),
  );

  if (workoutReconciliation.removedHkUuids.length > 0) {
    await repository.markWorkoutsDeleted(userId, workoutReconciliation.removedHkUuids, receivedAt);
  }
  for (const entry of workoutReconciliation.upserts) {
    const window = parseWorkoutWindow(entry.workout);
    await repository.upsertWorkout(userId, {
      ...entry,
      notificationState: notificationState(workoutsById.get(entry.workout.hkUuid)),
      receivedAt,
      startedAt: window?.startedAt ?? null,
      endedAt: window?.endedAt ?? null,
    });

    if (!window) continue; // nothing to compare against without a parseable window
    const conflict = resolveWorkoutSessionConflict(Array.from(sessionCandidates.values()), {
      hkUuid: entry.workout.hkUuid,
      workout: entry.workout,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
    }, workoutPreference);
    const loserHkUuid = conflict?.loserHkUuid ?? null;
    if (conflict) {
      await repository.suppressWorkout(userId, conflict.loserHkUuid, conflict.survivorHkUuid, receivedAt);
      // Gone for good within this batch — a later entry in the same upload
      // must never match a row that's already been suppressed.
      sessionCandidates.delete(conflict.loserHkUuid);
    }
    if (loserHkUuid !== entry.workout.hkUuid) {
      // The incoming row survived (whether by winning a conflict or by
      // having none) — make it visible to any later entry in this same
      // batch, so order within the batch can never change the outcome.
      sessionCandidates.set(entry.workout.hkUuid, {
        hkUuid: entry.workout.hkUuid,
        source: 'healthkit',
        sourceBundleId: extractSourceBundleId(entry.workout),
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        notified: false,
      });
    }
  }

  for (const day of sleepDays) {
    const persisted = sleepsByDate.get(day.wakeDate);
    const persistedSource: SleepSource = (persisted?.source as SleepSource | undefined) ?? 'healthkit';

    // Sleep ownership (phase 2 "both devices" contract, PR A) — see
    // lib/sleepOwnership.ts. null preference reproduces today's "WHOOP owns
    // the night" behavior exactly; 'apple' makes HealthKit own it instead.
    const decision = resolveSleepWrite({
      persisted: persisted ? { source: persistedSource, notified: isNotified(persisted) } : null,
      incomingSource: 'healthkit',
      preferredDevice: sleepPreference,
    });

    if (decision.action === 'secondary') {
      // The owning row (a different source) is untouched; this device's
      // payload for the same night is preserved rather than dropped.
      await repository.writeSecondarySleep(userId, {
        wakeDate: day.wakeDate,
        secondarySource: 'healthkit',
        secondaryPayload: day.sleep,
      });
      continue;
    }

    const candidate = sleepAnalysisCandidate(day.wakeDate, day.sleep, receivedAt);
    // The "unchanged content, skip the write" shortcut only makes sense when
    // the persisted row was already ours (same source) — a persisted row
    // from the OTHER source (an ownership swap) never matches our
    // fingerprint space and must always proceed to the upsert below.
    if (persisted && persistedSource === 'healthkit'
      && !shouldRefreshSleepAnalysis(persisted.contentFingerprint, candidate.fingerprint)) {
      continue;
    }
    await repository.upsertSleep(userId, {
      ...candidate,
      sleep: day.sleep,
      notificationState: notificationState(persisted),
      receivedAt,
      archiveSecondary: decision.archivePersistedAsSecondary && persisted
        ? { source: persistedSource, payload: persisted.inputPayload }
        : null,
    });
  }
}
