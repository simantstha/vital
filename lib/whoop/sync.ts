/**
 * WHOOP sync orchestration (see
 * docs/superpowers/plans/2026-07-19-whoop-integration.md, Task 4/5).
 *
 * `syncWhoopWindow()` is the pure-repository half: map already-fetched WHOOP
 * records and upsert them, given an injected `WhoopSyncRepository` — same
 * split as lib/healthAnalysisIngest.ts (repository interface in, no `@/db`
 * import in this file at all), so it's fully testable with a fake repo.
 *
 * `runWhoopSync()` is the end-to-end orchestration named in the plan: given a
 * connection + time window, it fetches via lib/whoop/client.ts (serializing
 * any needed token refresh through withValidToken), maps + upserts via
 * syncWhoopWindow(), then recomputes baselines for whatever metrics were
 * touched — the same recomputeBaselines() call POST /api/ingest/daily makes.
 * On success it also stamps `whoop_connections.last_synced_at = windowEnd` —
 * this is the one shared success path both the webhook handler and the
 * hourly reconciliation pass (lib/whoop/workerPass.ts) funnel through, so a
 * healthy webhook keeps the timestamp fresh without waiting for the pass.
 *
 * `createWhoopSyncRepository()` is the Drizzle-backed WhoopSyncRepository for
 * production use (Task 3/5 wiring, not part of this stage) — takes
 * `database`/`schema` as plain parameters, matching
 * lib/calendarIngestStore.ts's createCalendarIngestStore.
 */

import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type * as WhoopSchema from '../../db/schema';
import {
  dayKeysAround,
  isSameSession,
  resolveSessionConflict,
  type SessionCandidate,
  type SessionIdentity,
} from '../analysisSession';
import { recomputeBaselines } from '../brain/baselines';
import { fingerprintHealthPayload } from '../healthAnalysisReconciliation';
import { localDayKey } from '../localDay';
import { buildWhoopSleepInput, buildWhoopWorkoutInput } from './analysisPayloads';
import { shouldCreateWhoopAnalysis } from './analysisGate';
import {
  getCycles,
  getRecoveries,
  getSleeps,
  getWorkouts,
  withValidToken,
  type WhoopConnectionHandle,
  type WhoopSleep,
  type WhoopWorkout,
} from './client';
import { mapWhoopWindow, type WhoopSyncWindowInput } from './mapping';

/** A same-session candidate from ANY source (healthkit or whoop) within the queried day-key window — feeds the overlap/priority check in lib/analysisSession.ts. */
export interface WorkoutSessionCandidate {
  hkUuid: string;
  source: 'healthkit' | 'whoop';
  sourceBundleId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  notified: boolean;
}

export interface WhoopWorkoutAnalysisUpsert {
  hkUuid: string;
  workoutDate: string;
  startedAt: Date;
  endedAt: Date;
  input: Record<string, unknown>;
  fingerprint: string;
  nextAttemptAt: Date;
}

export interface PersistedWhoopSleepAnalysis {
  source: 'healthkit' | 'whoop';
  notified: boolean;
  fingerprint: string;
}

export interface WhoopSleepAnalysisUpsert {
  wakeDate: string;
  input: Record<string, unknown>;
  fingerprint: string;
  analyzeAfter: Date;
}

/**
 * The DB surface available inside the per-user advisory lock (see
 * WhoopSyncRepository.withUserAnalysisLock below) — one transaction, so a
 * WHOOP sync's analysis reads/writes for a user are atomic with respect to a
 * concurrent phone upload taking the same lock (app/api/ingest/daily/route.ts).
 */
export interface WhoopAnalysisTransaction {
  listWorkoutSessionCandidates(dayKeys: string[]): Promise<WorkoutSessionCandidate[]>;
  upsertWhoopWorkoutAnalysis(entry: WhoopWorkoutAnalysisUpsert): Promise<void>;
  getSleepAnalysisForWakeDate(wakeDate: string): Promise<PersistedWhoopSleepAnalysis | null>;
  upsertWhoopSleepAnalysis(entry: WhoopSleepAnalysisUpsert): Promise<void>;
}

export interface WhoopSyncRepository {
  upsertDailyMetrics(userId: string, rows: Array<{ date: string; metric: string; value: number; payload: unknown }>): Promise<void>;
  /** Scoped to [windowStart, windowEnd] — matches events_user_type_timestamp_idx. */
  listExistingWorkoutIds(userId: string, windowStart: Date, windowEnd: Date, whoopIds: string[]): Promise<Set<string>>;
  insertWorkoutEvents(userId: string, events: Array<{ timestamp: Date; payload: unknown }>): Promise<void>;
  markSynced(connectionId: string, syncedAt: Date): Promise<void>;
  /**
   * Runs `fn` inside one transaction holding the SAME per-user advisory lock
   * ingest uses (pg_advisory_xact_lock(hashtextextended(userId, 0)) — see
   * app/api/ingest/daily/route.ts), so a WHOOP sync's analysis writes and a
   * phone upload's HealthKit reconciliation for the same user always
   * serialize against each other.
   */
  withUserAnalysisLock<T>(userId: string, fn: (tx: WhoopAnalysisTransaction) => Promise<T>): Promise<T>;
}

export interface WhoopSyncResult {
  touchedMetrics: string[];
  dailyMetricsWritten: number;
  workoutEventsWritten: number;
}

/**
 * Creates a WHOOP workout analysis for each workout in `workouts` that
 * passes the 24h/first-sync gate (lib/whoop/analysisGate.ts) and has no
 * surviving same-session row already (lib/analysisSession.ts) — see the
 * multi-device-analyses contract's "Creating WHOOP analyses" section. WHOOP
 * is always the lowest-priority source, so a same-session match here always
 * means "skip"; the resolveSessionConflict call is still made for
 * defensiveness/symmetry with the ingest-side check
 * (lib/healthAnalysisIngest.ts), which runs the same function with WHOOP as
 * the *existing* side.
 */
async function createWhoopWorkoutAnalyses(
  tx: WhoopAnalysisTransaction,
  timezone: string | null | undefined,
  now: Date,
  isFirstSync: boolean,
  workouts: WhoopWorkout[],
): Promise<void> {
  const eligible = workouts
    .map((workout) => {
      const startedAt = new Date(workout.start);
      const endedAt = new Date(workout.end);
      return { workout, startedAt, endedAt };
    })
    .filter(({ startedAt, endedAt }) => (
      !Number.isNaN(startedAt.getTime())
      && !Number.isNaN(endedAt.getTime())
      && endedAt > startedAt
      && shouldCreateWhoopAnalysis({ endedAt, now, isFirstSync })
    ));
  if (eligible.length === 0) return;

  const dayKeys = Array.from(new Set(
    eligible.flatMap(({ startedAt }) => dayKeysAround(localDayKey(startedAt, timezone))),
  ));
  const candidates = await tx.listWorkoutSessionCandidates(dayKeys);

  for (const { workout, startedAt, endedAt } of eligible) {
    const hkUuid = `whoop:${workout.id}`;
    const incomingIdentity: SessionIdentity = { startedAt, endedAt, source: 'whoop', whoopId: workout.id };
    const match = candidates.find((candidate) => {
      if (candidate.hkUuid === hkUuid) return false; // same WHOOP row re-syncing — handled by the upsert's own idempotency below, not a conflict
      if (candidate.startedAt == null || candidate.endedAt == null) return false;
      const candidateIdentity: SessionIdentity = { startedAt: candidate.startedAt, endedAt: candidate.endedAt, source: candidate.source };
      return isSameSession(candidateIdentity, incomingIdentity);
    });

    if (match) {
      const existingCandidate: SessionCandidate = { key: match.hkUuid, source: match.source, sourceBundleId: match.sourceBundleId, notified: match.notified };
      const incomingCandidate: SessionCandidate = { key: hkUuid, source: 'whoop', sourceBundleId: null, notified: false };
      const resolution = resolveSessionConflict(existingCandidate, incomingCandidate);
      if (resolution.outcome === 'existing_wins') continue; // a surviving row already covers this session — skip the insert entirely
    }

    const input = buildWhoopWorkoutInput(workout) as unknown as Record<string, unknown>;
    await tx.upsertWhoopWorkoutAnalysis({
      hkUuid,
      workoutDate: localDayKey(startedAt, timezone),
      startedAt,
      endedAt,
      input,
      fingerprint: fingerprintHealthPayload(input),
      nextAttemptAt: new Date(endedAt.getTime() + 20 * 60_000), // 20-min grace lets the Apple Watch's own copy arrive first and win
    });
  }
}

/**
 * Creates/updates a WHOOP sleep analysis for each scored, non-nap sleep in
 * `sleeps` that passes the 24h/first-sync gate — "WHOOP owns the night" (see
 * the multi-device-analyses contract): it upserts over an existing
 * source='healthkit' row for that wake_date unless that row is already
 * notified (never un-sends a notification), and a WHOOP row is always safe
 * to re-upsert (idempotent re-sync).
 */
async function createWhoopSleepAnalysis(
  tx: WhoopAnalysisTransaction,
  timezone: string | null | undefined,
  now: Date,
  isFirstSync: boolean,
  sleeps: WhoopSleep[],
): Promise<void> {
  for (const sleep of sleeps) {
    if (sleep.nap) continue;
    const endedAt = new Date(sleep.end);
    if (Number.isNaN(endedAt.getTime())) continue;
    if (!shouldCreateWhoopAnalysis({ endedAt, now, isFirstSync })) continue;

    const built = buildWhoopSleepInput(sleep);
    if (!built) continue; // not scored yet — nothing true to write
    const input = built as unknown as Record<string, unknown>;

    const wakeDate = localDayKey(endedAt, timezone);
    const fingerprint = fingerprintHealthPayload(input);
    const persisted = await tx.getSleepAnalysisForWakeDate(wakeDate);
    if (persisted?.source === 'healthkit' && persisted.notified) continue; // WHOOP owns the night, but never un-sends a notification
    if (persisted?.source === 'whoop' && persisted.fingerprint === fingerprint) continue; // idempotent re-sync, no-op

    await tx.upsertWhoopSleepAnalysis({
      wakeDate,
      input,
      fingerprint,
      analyzeAfter: new Date(now.getTime() + 30 * 60_000), // same 30-min quiet period as the HealthKit path (sleepAnalysisCandidate)
    });
  }
}

/**
 * Maps already-fetched WHOOP records and upserts them via `repository`.
 * Workouts are inserted append-only into `events`, deduped by `whoopId`
 * against whatever already exists in [windowStart, windowEnd] for this user
 * (idempotent re-sync — the same workout arriving twice is a no-op, not a
 * duplicate event row).
 *
 * Also creates workout/sleep analyses for this connection's owner —
 * `lastSyncedAt` is the connection's `last_synced_at` value BEFORE this sync
 * (null means this is the connection's first-ever sync, which must never
 * create analyses — see lib/whoop/analysisGate.ts).
 */
export async function syncWhoopWindow(
  repository: WhoopSyncRepository,
  userId: string,
  timezone: string | null | undefined,
  windowStart: Date,
  windowEnd: Date,
  data: WhoopSyncWindowInput,
  lastSyncedAt: Date | null,
): Promise<WhoopSyncResult> {
  const mapped = mapWhoopWindow(data, timezone);

  if (mapped.dailyMetrics.length > 0) {
    await repository.upsertDailyMetrics(userId, mapped.dailyMetrics);
  }

  let workoutEventsWritten = 0;
  if (mapped.workoutEvents.length > 0) {
    const existingIds = await repository.listExistingWorkoutIds(
      userId,
      windowStart,
      windowEnd,
      mapped.workoutEvents.map((e) => e.whoopId),
    );
    const fresh = mapped.workoutEvents.filter((e) => !existingIds.has(e.whoopId));
    if (fresh.length > 0) {
      await repository.insertWorkoutEvents(userId, fresh.map((e) => ({ timestamp: e.timestamp, payload: e.payload })));
      workoutEventsWritten = fresh.length;
    }
  }

  const isFirstSync = lastSyncedAt == null;
  if (data.workouts.length > 0 || data.sleeps.length > 0) {
    await repository.withUserAnalysisLock(userId, async (tx) => {
      await createWhoopWorkoutAnalyses(tx, timezone, windowEnd, isFirstSync, data.workouts);
      await createWhoopSleepAnalysis(tx, timezone, windowEnd, isFirstSync, data.sleeps);
    });
  }

  return {
    touchedMetrics: Array.from(new Set(mapped.dailyMetrics.map((m) => m.metric))),
    dailyMetricsWritten: mapped.dailyMetrics.length,
    workoutEventsWritten,
  };
}

export interface WhoopSyncTarget {
  connectionId: string;
  userId: string;
  timezone: string | null | undefined;
  /** The connection's last_synced_at BEFORE this sync — null means this is its first-ever sync (see lib/whoop/analysisGate.ts). */
  lastSyncedAt: Date | null;
}

/**
 * Full sync for one connection over [windowStart, windowEnd]: fetch (with
 * serialized token refresh) → map → upsert → recompute baselines for touched
 * metrics. `tokenStore` is the same WhoopTokenStore withValidToken() needs
 * (see lib/whoop/client.ts createWhoopTokenStore).
 */
export async function runWhoopSync(
  target: WhoopSyncTarget,
  tokenStore: WhoopConnectionHandle['store'],
  repository: WhoopSyncRepository,
  windowStart: Date,
  windowEnd: Date,
): Promise<WhoopSyncResult> {
  const data = await withValidToken({ id: target.connectionId, store: tokenStore }, async (accessToken) => {
    const [cycles, recoveries, sleeps, workouts] = await Promise.all([
      getCycles(accessToken, windowStart, windowEnd),
      getRecoveries(accessToken, windowStart, windowEnd),
      getSleeps(accessToken, windowStart, windowEnd),
      getWorkouts(accessToken, windowStart, windowEnd),
    ]);
    return { cycles, recoveries, sleeps, workouts };
  });

  const result = await syncWhoopWindow(repository, target.userId, target.timezone, windowStart, windowEnd, data, target.lastSyncedAt);

  if (result.touchedMetrics.length > 0) {
    await recomputeBaselines(target.userId, result.touchedMetrics);
  }

  await repository.markSynced(target.connectionId, windowEnd);

  return result;
}

// ─── Drizzle-backed repository (production wiring for Task 3/5) ─────────────
// Minimal chain typing, same approach as lib/calendarIngestStore.ts: narrow
// enough for what this module calls, so a fake `database` in tests doesn't
// need to satisfy drizzle-orm's full generic surface.

interface DrizzleWhoopSyncDatabase {
  insert(table: unknown): {
    values(rows: Array<Record<string, unknown>>): {
      onConflictDoUpdate(config: { target: unknown[]; set: Record<string, unknown>; setWhere?: unknown }): Promise<unknown>;
    } & Promise<unknown>;
  };
  select(fields: Record<string, unknown>): {
    from(table: unknown): {
      where(predicate: unknown): Promise<Array<Record<string, unknown>>>;
    };
  };
  update(table: unknown): {
    set(values: Record<string, unknown>): {
      where(predicate: unknown): Promise<unknown>;
    };
  };
}

interface DrizzleWhoopSyncTx extends DrizzleWhoopSyncDatabase {
  execute(query: unknown): Promise<unknown>;
}

interface DrizzleWhoopSyncDatabaseWithTx extends DrizzleWhoopSyncDatabase {
  transaction<T>(fn: (tx: DrizzleWhoopSyncTx) => Promise<T>): Promise<T>;
}

export function createWhoopSyncRepository(database: unknown, schema: typeof WhoopSchema): WhoopSyncRepository {
  const db = database as DrizzleWhoopSyncDatabase;
  return {
    async upsertDailyMetrics(userId, rows) {
      if (rows.length === 0) return;
      // Defense-in-depth: filter out any row with non-finite value to prevent NOT NULL constraint violations
      const validRows = rows.filter((r) => Number.isFinite(r.value));
      if (validRows.length === 0) return;

      // Dedupe rows by (date, metric) — PostgreSQL rejects ON CONFLICT when a single INSERT
      // contains multiple rows with the same conflict key. Use last-wins semantics (consistent
      // with onConflictDoUpdate overwriting): later rows replace earlier ones with the same key.
      const deduped = new Map<string, (typeof validRows)[number]>();
      for (const row of validRows) {
        const key = `${row.date} ${row.metric}`;
        deduped.set(key, row);
      }

      await db.insert(schema.daily_metrics).values([...deduped.values()].map((r) => ({
        user_id: userId,
        date: r.date,
        metric: r.metric,
        value: r.value,
        payload: r.payload ?? null,
        source: 'whoop',
      }))).onConflictDoUpdate({
        target: [schema.daily_metrics.user_id, schema.daily_metrics.date, schema.daily_metrics.metric],
        set: {
          value: sql`excluded.value`,
          payload: sql`excluded.payload`,
          source: sql`excluded.source`,
          updated_at: sql`now()`,
        },
      });
    },
    async listExistingWorkoutIds(userId, windowStart, windowEnd, whoopIds) {
      if (whoopIds.length === 0) return new Set();
      const rows = await db.select({ payload: schema.events.payload }).from(schema.events).where(and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, 'workout_completed'),
        eq(schema.events.source, 'whoop'),
        gte(schema.events.timestamp, windowStart),
        lte(schema.events.timestamp, windowEnd),
      ));
      const ids = new Set<string>();
      for (const row of rows) {
        const whoopId = (row.payload as Record<string, unknown> | null)?.whoopId;
        if (typeof whoopId === 'string' && whoopIds.includes(whoopId)) ids.add(whoopId);
      }
      return ids;
    },
    async insertWorkoutEvents(userId, events) {
      if (events.length === 0) return;
      await db.insert(schema.events).values(events.map((e) => ({
        user_id: userId,
        timestamp: e.timestamp,
        type: 'workout_completed',
        payload: e.payload,
        source: 'whoop',
      })));
    },
    async markSynced(connectionId, syncedAt) {
      await db.update(schema.whoop_connections).set({ last_synced_at: syncedAt, updated_at: new Date() }).where(eq(schema.whoop_connections.id, connectionId));
    },
    async withUserAnalysisLock(userId, fn) {
      const database = db as unknown as DrizzleWhoopSyncDatabaseWithTx;
      return database.transaction(async (tx) => {
        // Same per-user advisory lock ingest uses (app/api/ingest/daily/route.ts)
        // — held for the lifetime of this transaction, so a WHOOP sync and a
        // phone upload for the same user always serialize.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);

        return fn({
          async listWorkoutSessionCandidates(dayKeys) {
            if (dayKeys.length === 0) return [];
            const rows = await tx.select({
              hkUuid: schema.workout_analyses.hk_uuid,
              source: schema.workout_analyses.source,
              inputPayload: schema.workout_analyses.input_payload,
              startedAt: schema.workout_analyses.started_at,
              endedAt: schema.workout_analyses.ended_at,
              notificationState: schema.workout_analyses.notification_state,
              notificationSentAt: schema.workout_analyses.notification_sent_at,
            }).from(schema.workout_analyses).where(and(
              eq(schema.workout_analyses.user_id, userId),
              inArray(schema.workout_analyses.workout_date, dayKeys),
              ne(schema.workout_analyses.status, 'deleted'),
            ));
            return rows.map((row) => {
              const payload = row.inputPayload as Record<string, unknown> | null;
              const sourceBundleId = payload && typeof payload.sourceBundleId === 'string' ? payload.sourceBundleId : null;
              return {
                hkUuid: row.hkUuid as string,
                source: row.source as 'healthkit' | 'whoop',
                sourceBundleId,
                startedAt: row.startedAt as Date | null,
                endedAt: row.endedAt as Date | null,
                notified: Boolean(row.notificationSentAt) || row.notificationState === 'sent',
              };
            });
          },
          async upsertWhoopWorkoutAnalysis(entry) {
            // notification_state: preserved as 'sent' on conflict rather than
            // reset to 'pending' — the same "never un-send a notification"
            // rule as app/api/ingest/daily/route.ts's upsertWorkout, for the
            // (rare) case this exact WHOOP workout was already analyzed and
            // notified before a later re-sync brought updated score data.
            const preserveSentState = sql`case when ${schema.workout_analyses.notification_state} = 'sent' then 'sent' else 'pending' end`;
            await tx.insert(schema.workout_analyses).values([{
              user_id: userId,
              hk_uuid: entry.hkUuid,
              workout_date: entry.workoutDate,
              content_fingerprint: entry.fingerprint,
              input_payload: entry.input,
              source: 'whoop',
              started_at: entry.startedAt,
              ended_at: entry.endedAt,
              next_attempt_at: entry.nextAttemptAt,
            }]).onConflictDoUpdate({
              target: [schema.workout_analyses.user_id, schema.workout_analyses.hk_uuid],
              set: {
                workout_date: entry.workoutDate,
                content_fingerprint: entry.fingerprint,
                input_payload: entry.input,
                source: 'whoop',
                started_at: entry.startedAt,
                ended_at: entry.endedAt,
                status: 'pending',
                retry_count: 0,
                next_attempt_at: entry.nextAttemptAt,
                lease_expires_at: null,
                deleted_at: null,
                updated_at: sql`now()`,
                notification_state: preserveSentState,
              },
              setWhere: ne(schema.workout_analyses.content_fingerprint, entry.fingerprint),
            });
          },
          async getSleepAnalysisForWakeDate(wakeDate) {
            const rows = await tx.select({
              source: schema.sleep_analyses.source,
              notificationState: schema.sleep_analyses.notification_state,
              notificationSentAt: schema.sleep_analyses.notification_sent_at,
              contentFingerprint: schema.sleep_analyses.content_fingerprint,
            }).from(schema.sleep_analyses).where(and(
              eq(schema.sleep_analyses.user_id, userId),
              eq(schema.sleep_analyses.wake_date, wakeDate),
            ));
            const row = rows[0];
            if (!row) return null;
            return {
              source: row.source as 'healthkit' | 'whoop',
              notified: Boolean(row.notificationSentAt) || row.notificationState === 'sent',
              fingerprint: row.contentFingerprint as string,
            };
          },
          async upsertWhoopSleepAnalysis(entry) {
            // Same "preserve 'sent', never reset it" rule as the workout upsert above.
            const preserveSentState = sql`case when ${schema.sleep_analyses.notification_state} = 'sent' then 'sent' else 'pending' end`;
            await tx.insert(schema.sleep_analyses).values([{
              user_id: userId,
              wake_date: entry.wakeDate,
              content_fingerprint: entry.fingerprint,
              input_payload: entry.input,
              source: 'whoop',
              analyze_after: entry.analyzeAfter,
              next_attempt_at: entry.analyzeAfter,
            }]).onConflictDoUpdate({
              target: [schema.sleep_analyses.user_id, schema.sleep_analyses.wake_date],
              set: {
                content_fingerprint: entry.fingerprint,
                input_payload: entry.input,
                source: 'whoop',
                analyze_after: entry.analyzeAfter,
                next_attempt_at: entry.analyzeAfter,
                status: 'pending',
                retry_count: 0,
                lease_expires_at: null,
                updated_at: sql`now()`,
                notification_state: preserveSentState,
              },
            });
          },
        });
      });
    },
  };
}
