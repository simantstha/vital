import {
  dayKeysAround,
  parseWorkoutWindow,
  resolveSessionConflict,
  isSameSession,
  type SessionCandidate,
  type SessionIdentity,
} from './analysisSession';
import {
  reconcilePersistedWorkouts,
  shouldRefreshSleepAnalysis,
  sleepAnalysisCandidate,
  type HealthKitWorkout,
} from './healthAnalysisReconciliation';

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
  /** 'healthkit' | 'whoop' — WHOOP owns the night once it's written one (see reconcileAnalysisIngest below). */
  source?: string;
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
  /** Marks a same-session loser: status='deleted', notification_state='suppressed', deleted_at=receivedAt. Never called on an already-notified row (see resolveSessionConflict). */
  suppressWorkout(userId: string, hkUuid: string, receivedAt: Date): Promise<void>;
  listSleepAnalyses(userId: string, wakeDates: string[]): Promise<PersistedSleepAnalysis[]>;
  upsertSleep(userId: string, entry: SleepAnalysisUpsert): Promise<void>;
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
 * lib/analysisSession.ts. Returns the hkUuid that must end up suppressed
 * (deleted + notification_state='suppressed'), which is either the
 * newly-written incoming row itself, an existing candidate, or null when
 * there's no conflict at all.
 */
function resolveWorkoutSessionConflict(
  candidates: WorkoutSessionCandidate[],
  incoming: { hkUuid: string; workout: HealthKitWorkout; startedAt: Date; endedAt: Date },
): string | null {
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
  const resolution = resolveSessionConflict(existingCandidate, incomingCandidate);
  return resolution.loserKey;
}

export async function reconcileAnalysisIngest(
  repository: AnalysisIngestRepository,
  userId: string,
  workoutDays: Array<{ workoutDate: string; workouts: HealthKitWorkout[] }>,
  sleepDays: Array<{ wakeDate: string; sleep: { minutes: number; stages?: unknown } }>,
  receivedAt: Date,
): Promise<void> {
  await repository.lockUser(userId);

  const persistedWorkouts = await repository.listWorkoutAnalyses(
    userId,
    workoutDays.map((day) => day.workoutDate),
    workoutDays.flatMap((day) => day.workouts.map((workout) => workout.hkUuid)),
  );
  const sessionDayKeys = Array.from(new Set(workoutDays.flatMap((day) => dayKeysAround(day.workoutDate))));
  const sessionCandidates = sessionDayKeys.length > 0
    ? await repository.listWorkoutSessionCandidates(userId, sessionDayKeys)
    : [];
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
    const loserHkUuid = resolveWorkoutSessionConflict(sessionCandidates, {
      hkUuid: entry.workout.hkUuid,
      workout: entry.workout,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
    });
    if (loserHkUuid) await repository.suppressWorkout(userId, loserHkUuid, receivedAt);
  }

  for (const day of sleepDays) {
    const persisted = sleepsByDate.get(day.wakeDate);
    // WHOOP owns the night: once a source='whoop' row exists for this
    // wake_date, a later HealthKit upsert must never overwrite it (see the
    // multi-device-analyses contract's "WHOOP owns the night" rule).
    if (persisted?.source === 'whoop') continue;

    const candidate = sleepAnalysisCandidate(day.wakeDate, day.sleep, receivedAt);
    if (persisted && !shouldRefreshSleepAnalysis(persisted.contentFingerprint, candidate.fingerprint)) {
      continue;
    }
    await repository.upsertSleep(userId, {
      ...candidate,
      sleep: day.sleep,
      notificationState: notificationState(persisted),
      receivedAt,
    });
  }
}
