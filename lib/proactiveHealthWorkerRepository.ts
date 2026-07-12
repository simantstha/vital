import { db, schema } from '@/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { readMemoryFile } from './memory';
import { parseProfileDetails } from './profileDetails';
import { morningKey, notificationKey, type AnalysisJob, type CoachAnalysis, type PushDevice, type PushOutcome, type WorkerRepository } from './proactiveHealthWorker';

const LEASE_MS = 5 * 60_000;
type RawJob = { id: string; user_id: string; local_date: string; input_payload: unknown; retry_count: number; kind: 'workout' | 'sleep' };

export async function claimAnalysisJobs(now: Date, limit = 20): Promise<AnalysisJob[]> {
  const lease = new Date(now.getTime() + LEASE_MS);
  return db.transaction(async (tx) => {
    const workouts = await tx.execute(sql<RawJob>`
      with eligible as (
        select id from ${schema.workout_analyses}
        where deleted_at is null and next_attempt_at <= ${now}
          and (status = 'pending' or (status = 'processing' and lease_expires_at <= ${now}))
        order by next_attempt_at limit ${limit} for update skip locked
      ) update ${schema.workout_analyses} w set status='processing', lease_expires_at=${lease}, updated_at=${now}
        from eligible e where w.id=e.id
        returning w.id,w.user_id,w.workout_date::text local_date,w.input_payload,w.retry_count,'workout'::text kind`);
    const remaining = Math.max(0, limit - workouts.length);
    const sleeps = remaining ? await tx.execute(sql<RawJob>`
      with eligible as (
        select id from ${schema.sleep_analyses}
        where analyze_after <= ${now} and next_attempt_at <= ${now}
          and (status = 'pending' or (status = 'processing' and lease_expires_at <= ${now}))
        order by next_attempt_at limit ${remaining} for update skip locked
      ) update ${schema.sleep_analyses} s set status='processing', lease_expires_at=${lease}, updated_at=${now}
        from eligible e where s.id=e.id
        returning s.id,s.user_id,s.wake_date::text local_date,s.input_payload,s.retry_count,'sleep'::text kind`) : [];
    return ([...(workouts as unknown as RawJob[]), ...(sleeps as unknown as RawJob[])]).map((row) => ({ id: row.id, kind: row.kind, userId: row.user_id, localDate: row.local_date, input: row.input_payload, retryCount: row.retry_count }));
  });
}

function table(job: AnalysisJob) { return job.kind === 'workout' ? schema.workout_analyses : schema.sleep_analyses; }
export const workerRepository: WorkerRepository = {
  async getContext(job) {
    const [preference] = await db.select().from(schema.notification_preferences).where(eq(schema.notification_preferences.user_id, job.userId)).limit(1);
    const enabled = job.kind === 'workout' ? preference?.workout_notifications_enabled !== false : preference?.sleep_notifications_enabled !== false;
    const baselines = await db.select({ metric: schema.baselines.metric, stats: schema.baselines.stats, established: schema.baselines.established }).from(schema.baselines).where(eq(schema.baselines.user_id, job.userId));
    const metrics = await db.select({ date: schema.daily_metrics.date, metric: schema.daily_metrics.metric, value: schema.daily_metrics.value, payload: schema.daily_metrics.payload }).from(schema.daily_metrics).where(and(eq(schema.daily_metrics.user_id, job.userId), eq(schema.daily_metrics.date, job.localDate)));
    return { enabled, timezone: preference?.timezone ?? 'UTC', baselines, metrics, profile: parseProfileDetails(readMemoryFile(job.userId, 'core-profile.md')) };
  },
  async storeReady(job, result) { await db.update(table(job)).set({ status: 'ready', result, lease_expires_at: null, updated_at: new Date() }).where(and(eq(table(job).id, job.id), eq(table(job).status, 'processing'))); },
  async markRetry(job, nextAt) { await db.update(table(job)).set({ status: 'pending', retry_count: sql`${table(job).retry_count} + 1`, next_attempt_at: nextAt, lease_expires_at: null, notification_state: 'pending', updated_at: new Date() }).where(eq(table(job).id, job.id)); },
  async markFailed(job) { await db.update(table(job)).set({ status: 'failed', notification_state: 'failed', lease_expires_at: null, updated_at: new Date() }).where(eq(table(job).id, job.id)); },
  async suppress(job) { await db.update(table(job)).set({ status: 'ready', notification_state: 'suppressed', lease_expires_at: null, updated_at: new Date() }).where(eq(table(job).id, job.id)); },
  async claimNotification(job, now) {
    if (job.kind === 'sleep') {
      const [preference] = await db.select().from(schema.notification_preferences).where(eq(schema.notification_preferences.user_id, job.userId)).limit(1);
      const minutes = localMinute(now, preference?.timezone ?? 'UTC');
      if (minutes >= (preference?.morning_brief_time_minutes ?? 450)) { await this.suppress(job); return false; }
      const inserted = await db.insert(schema.morning_notification_slots).values({ user_id: job.userId, local_date: job.localDate, claimed_by: 'sleep', idempotency_key: morningKey(job.userId, job.localDate), claimed_at: now }).onConflictDoNothing().returning({ id: schema.morning_notification_slots.id });
      if (!inserted.length) { await this.suppress(job); return false; }
    }
    const rows = await db.update(table(job)).set({ notification_state: 'sending', updated_at: now }).where(and(eq(table(job).id, job.id), eq(table(job).notification_state, 'pending'))).returning({ id: table(job).id });
    return rows.length > 0;
  },
  async listDevices(userId) { const rows = await db.select().from(schema.push_devices).where(and(eq(schema.push_devices.user_id, userId), isNull(schema.push_devices.invalidated_at))); return rows.map((r) => ({ id: r.id, token: r.device_token, environment: r.environment as PushDevice['environment'] })); },
  async recordPushAttempt(job, device, attempt, result) { await db.insert(schema.push_attempts).values({ user_id: job.userId, push_device_id: device.id, idempotency_key: notificationKey(job), notification_type: job.kind, target_id: job.id, attempt_number: job.retryCount * 100 + attempt, status: result.outcome === 'sent' ? 'sent' : `${result.outcome}_failure`, apns_status: result.status, failure_category: result.category, latency_ms: result.latencyMs }).onConflictDoNothing(); },
  async retireDevice(deviceId, now) { await db.update(schema.push_devices).set({ invalidated_at: now, updated_at: now }).where(eq(schema.push_devices.id, deviceId)); },
  async markNotificationSent(job, now) { await db.update(table(job)).set({ notification_state: 'sent', notification_sent_at: now, updated_at: now }).where(and(eq(table(job).id, job.id), eq(table(job).notification_state, 'sending'))); if (job.kind === 'sleep') await db.update(schema.morning_notification_slots).set({ status: 'sent', sent_at: now }).where(eq(schema.morning_notification_slots.idempotency_key, morningKey(job.userId, job.localDate))); },
};

function localMinute(date: Date, timezone: string): number { try { const values = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date); return Number(values.find((x) => x.type === 'hour')?.value) * 60 + Number(values.find((x) => x.type === 'minute')?.value); } catch { return date.getUTCHours() * 60 + date.getUTCMinutes(); } }

export interface MorningBriefClaim { userId: string; localDate: string; timezone: string; idempotencyKey: string }
export async function claimDueMorningBriefs(now: Date, limit = 20): Promise<MorningBriefClaim[]> {
  const candidates = await db.execute(sql<{ user_id: string; timezone: string }>`
    select p.user_id, p.timezone from ${schema.notification_preferences} p
    where p.morning_brief_enabled = true
      and exists (select 1 from ${schema.push_devices} d where d.user_id=p.user_id and d.invalidated_at is null)
    order by p.user_id limit ${limit * 4}`);
  const due = (candidates as unknown as Array<{ user_id: string; timezone: string }>).map((row) => {
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(row.timezone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    return { userId: row.user_id, timezone: row.timezone, localDate, idempotencyKey: morningKey(row.user_id, localDate) };
  });
  const claims: MorningBriefClaim[] = [];
  for (const candidate of due) {
    const [preference] = await db.select().from(schema.notification_preferences).where(eq(schema.notification_preferences.user_id, candidate.userId)).limit(1);
    if (!preference || localMinute(now, preference.timezone) < preference.morning_brief_time_minutes) continue;
    const inserted = await db.insert(schema.morning_notification_slots).values({ user_id: candidate.userId, local_date: candidate.localDate, claimed_by: 'brief', idempotency_key: candidate.idempotencyKey, claimed_at: now }).onConflictDoNothing().returning({ id: schema.morning_notification_slots.id });
    if (inserted.length) claims.push(candidate);
    if (claims.length >= limit) break;
  }
  return claims;
}

export async function completeMorningBrief(claim: MorningBriefClaim, result: CoachAnalysis, send: (device: PushDevice, result: CoachAnalysis) => Promise<PushOutcome>, now: Date): Promise<void> {
  const devices = await workerRepository.listDevices(claim.userId);
  let sent = false; let attempt = 0;
  for (const device of devices) {
    for (let retry = 0; retry < 3; retry++) {
      const outcome = await send(device, result); sent ||= outcome.outcome === 'sent';
      await db.insert(schema.push_attempts).values({ user_id: claim.userId, push_device_id: device.id, idempotency_key: claim.idempotencyKey, notification_type: 'brief', attempt_number: ++attempt, status: outcome.outcome === 'sent' ? 'sent' : `${outcome.outcome}_failure`, apns_status: outcome.status, failure_category: outcome.category, latency_ms: outcome.latencyMs }).onConflictDoNothing();
      if (outcome.retireToken) await workerRepository.retireDevice(device.id, now);
      if (outcome.outcome !== 'transient') break;
    }
  }
  await db.update(schema.morning_notification_slots).set({ status: sent ? 'sent' : 'failed', sent_at: sent ? now : null }).where(eq(schema.morning_notification_slots.idempotency_key, claim.idempotencyKey));
}

function safeZone(zone: string): string { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } catch { return 'UTC'; } }
