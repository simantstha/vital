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
}

export interface PersistedSleepAnalysis {
  wakeDate: string;
  contentFingerprint: string;
  notificationState?: string;
  notificationSentAt?: Date | null;
}

export interface WorkoutAnalysisUpsert {
  workoutDate: string;
  workout: HealthKitWorkout;
  fingerprint: string;
  notificationState: 'pending' | 'sent';
  receivedAt: Date;
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
  listWorkoutAnalyses(
    userId: string,
    workoutDates: string[],
    currentHkUuids: string[],
  ): Promise<PersistedWorkoutAnalysis[]>;
  markWorkoutsDeleted(userId: string, hkUuids: string[], receivedAt: Date): Promise<void>;
  upsertWorkout(userId: string, entry: WorkoutAnalysisUpsert): Promise<void>;
  listSleepAnalyses(userId: string, wakeDates: string[]): Promise<PersistedSleepAnalysis[]>;
  upsertSleep(userId: string, entry: SleepAnalysisUpsert): Promise<void>;
}

function notificationState(
  persisted?: { notificationState?: string; notificationSentAt?: Date | null },
): 'pending' | 'sent' {
  return persisted?.notificationSentAt || persisted?.notificationState === 'sent' ? 'sent' : 'pending';
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
    await repository.upsertWorkout(userId, {
      ...entry,
      notificationState: notificationState(workoutsById.get(entry.workout.hkUuid)),
      receivedAt,
    });
  }

  for (const day of sleepDays) {
    const candidate = sleepAnalysisCandidate(day.wakeDate, day.sleep, receivedAt);
    const persisted = sleepsByDate.get(day.wakeDate);
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
