import { db, schema } from '@/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { morningKey, notificationKey, type AnalysisJob, type CoachAnalysis, type PushDevice, type PushOutcome, type WorkerRepository } from './proactiveHealthWorker';
import { claimMorningSlot, compareDueCandidates, failOwnedMorningSlot, notificationClaimable } from './proactiveHealthTransitions';

const LEASE_MS = 5 * 60_000;
type RawJob = { id: string; user_id: string; local_date: string; input_payload: unknown; retry_count: number; kind: 'workout' | 'sleep'; lease_token: string; result?: unknown; notification_state?: string; notification_lease_expires_at?: Date | null; notification_next_attempt_at?: Date };

export async function claimAnalysisJobs(now: Date, limit = 20): Promise<AnalysisJob[]> {
  const lease = new Date(now.getTime() + LEASE_MS);
  return db.transaction(async (tx) => {
    const workoutToken = randomUUID();
    const workouts = await tx.execute(sql<RawJob>`
      with eligible as (
        select id from ${schema.workout_analyses}
        where deleted_at is null and next_attempt_at <= ${now}
          and (status = 'pending' or (status = 'processing' and lease_expires_at <= ${now}))
        order by next_attempt_at limit ${limit} for update skip locked
      ) update ${schema.workout_analyses} w set status='processing', lease_token=${workoutToken}, lease_expires_at=${lease}, updated_at=${now}
        from eligible e where w.id=e.id
        returning w.id,w.user_id,w.workout_date::text local_date,w.input_payload,w.retry_count,w.lease_token,'workout'::text kind`);
    const remaining = Math.max(0, limit - workouts.length);
    const sleepToken = randomUUID();
    const sleeps = remaining ? await tx.execute(sql<RawJob>`
      with eligible as (
        select id from ${schema.sleep_analyses}
        where analyze_after <= ${now} and next_attempt_at <= ${now}
          and (status = 'pending' or (status = 'processing' and lease_expires_at <= ${now}))
        order by next_attempt_at limit ${remaining} for update skip locked
      ) update ${schema.sleep_analyses} s set status='processing', lease_token=${sleepToken}, lease_expires_at=${lease}, updated_at=${now}
        from eligible e where s.id=e.id
        returning s.id,s.user_id,s.wake_date::text local_date,s.input_payload,s.retry_count,s.lease_token,'sleep'::text kind`) : [];
    return ([...(workouts as unknown as RawJob[]), ...(sleeps as unknown as RawJob[])]).map((row) => ({ id: row.id, kind: row.kind, userId: row.user_id, localDate: row.local_date, input: row.input_payload, retryCount: row.retry_count, notificationRetryCount: 0, leaseToken: row.lease_token }));
  });
}

function table(job: AnalysisJob) { return job.kind === 'workout' ? schema.workout_analyses : schema.sleep_analyses; }
export const workerRepository: WorkerRepository = {
  async getContext(job) {
    const [preference] = await db.select().from(schema.notification_preferences).where(eq(schema.notification_preferences.user_id, job.userId)).limit(1);
    const enabled = job.kind === 'workout' ? preference?.workout_notifications_enabled !== false : preference?.sleep_notifications_enabled !== false;
    const baselines = await db.select({ metric: schema.baselines.metric, stats: schema.baselines.stats, established: schema.baselines.established }).from(schema.baselines).where(eq(schema.baselines.user_id, job.userId));
    const metrics = await db.select({ date: schema.daily_metrics.date, metric: schema.daily_metrics.metric, value: schema.daily_metrics.value, payload: schema.daily_metrics.payload }).from(schema.daily_metrics).where(and(eq(schema.daily_metrics.user_id, job.userId), eq(schema.daily_metrics.date, job.localDate)));
    const [user] = await db.select({ name: schema.users.name, goal: schema.users.goal, targetKcal: schema.users.target_kcal, proteinTargetG: schema.users.protein_target_g, carbsTargetG: schema.users.carbs_target_g, fatTargetG: schema.users.fat_target_g }).from(schema.users).where(eq(schema.users.id, job.userId)).limit(1);
    const profileFacts = await db.select({ type: schema.nodes.type, label: schema.nodes.label, properties: schema.nodes.properties }).from(schema.nodes).where(eq(schema.nodes.user_id, job.userId));
    return { enabled, timezone: preference?.timezone ?? 'UTC', baselines, metrics, profile: { user, facts: profileFacts } };
  },
  async renewAnalysisLease(job, now) { const t = table(job); const rows = await db.update(t).set({ lease_expires_at: new Date(now.getTime() + LEASE_MS), updated_at: now }).where(and(eq(t.id, job.id), eq(t.status, 'processing'), eq(t.lease_token, job.leaseToken))).returning({ id: t.id }); return rows.length === 1; },
  async storeReady(job, result) { const t = table(job); const rows = await db.update(t).set({ status: 'ready', result, lease_token: null, lease_expires_at: null, updated_at: new Date() }).where(and(eq(t.id, job.id), eq(t.status, 'processing'), eq(t.lease_token, job.leaseToken))).returning({ id: t.id }); return rows.length === 1; },
  async markRetry(job, nextAt) { const t = table(job); const rows = await db.update(t).set({ status: 'pending', retry_count: sql`${t.retry_count} + 1`, next_attempt_at: nextAt, lease_token: null, lease_expires_at: null, notification_state: 'pending', updated_at: new Date() }).where(and(eq(t.id, job.id), eq(t.lease_token, job.leaseToken))).returning({ id: t.id }); return rows.length === 1; },
  async markFailed(job) { const t = table(job); const rows = await db.update(t).set({ status: 'failed', notification_state: 'failed', lease_token: null, lease_expires_at: null, updated_at: new Date() }).where(and(eq(t.id, job.id), eq(t.lease_token, job.leaseToken))).returning({ id: t.id }); return rows.length === 1; },
  async suppress(job) { const t = table(job); const rows = await db.update(t).set({ status: 'ready', notification_state: 'suppressed', lease_token: null, lease_expires_at: null, updated_at: new Date() }).where(and(eq(t.id, job.id), eq(t.lease_token, job.leaseToken))).returning({ id: t.id }); return rows.length === 1; },
  async suppressNotification(job, now) { const t = table(job); const rows = await db.update(t).set({ notification_state: 'suppressed', notification_lease_token: null, notification_lease_expires_at: null, updated_at: now }).where(and(eq(t.id, job.id), eq(t.status, 'ready'), sql`(${t.notification_state} = 'pending' or (${t.notification_state} = 'sending' and ${t.notification_lease_expires_at} <= ${now}))`)).returning({ id: t.id }); return rows.length === 1; },
  async claimNotification(job, now) {
    const token = randomUUID();
    const [preference] = await db.select().from(schema.notification_preferences).where(eq(schema.notification_preferences.user_id, job.userId)).limit(1);
    const enabled = job.kind === 'workout' ? preference?.workout_notifications_enabled !== false : preference?.sleep_notifications_enabled !== false;
    if (!enabled) { await this.suppressNotification(job, now); return null; }
    if (job.kind === 'sleep') {
      const minutes = localMinute(now, preference?.timezone ?? 'UTC');
      if (minutes >= (preference?.morning_brief_time_minutes ?? 450)) { await this.suppressNotification(job, now); return null; }
      const lease = new Date(now.getTime() + LEASE_MS);
      const inserted = await db.insert(schema.morning_notification_slots).values({ user_id: job.userId, local_date: job.localDate, claimed_by: 'sleep', idempotency_key: morningKey(job.userId, job.localDate), claimed_at: now, lease_token: token, lease_expires_at: lease, next_attempt_at: now }).onConflictDoNothing().returning({ id: schema.morning_notification_slots.id });
      const recovered = inserted.length ? inserted : await db.update(schema.morning_notification_slots).set({ status: 'claimed', lease_token: token, lease_expires_at: lease, claimed_at: now }).where(and(eq(schema.morning_notification_slots.idempotency_key, morningKey(job.userId, job.localDate)), eq(schema.morning_notification_slots.claimed_by, 'sleep'), sql`${schema.morning_notification_slots.retry_count} < 5`, sql`${schema.morning_notification_slots.next_attempt_at} <= ${now}`, sql`(${schema.morning_notification_slots.status} = 'failed' or (${schema.morning_notification_slots.status} = 'claimed' and ${schema.morning_notification_slots.lease_expires_at} <= ${now}))`)).returning({ id: schema.morning_notification_slots.id });
      if (!recovered.length) { await this.suppressNotification(job, now); return null; }
    }
    const t = table(job);
    const rows = await db.update(t).set({ notification_state: 'sending', notification_lease_token: token, notification_lease_expires_at: new Date(now.getTime() + LEASE_MS), updated_at: now }).where(and(eq(t.id, job.id), eq(t.status, 'ready'), sql`${t.notification_next_attempt_at} <= ${now}`, sql`(${t.notification_state} = 'pending' or (${t.notification_state} = 'sending' and ${t.notification_lease_expires_at} <= ${now}))`)).returning({ id: t.id });
    return rows.length ? token : null;
  },
  async renewNotificationLease(job, token, now) { const t = table(job); const rows = await db.update(t).set({ notification_lease_expires_at: new Date(now.getTime() + LEASE_MS), updated_at: now }).where(and(eq(t.id, job.id), eq(t.notification_state, 'sending'), eq(t.notification_lease_token, token))).returning({ id: t.id }); return rows.length === 1; },
  async markNotificationRetry(job, token, nextAt) { const t = table(job); await db.update(t).set({ notification_state: 'pending', notification_retry_count: sql`${t.notification_retry_count} + 1`, notification_next_attempt_at: nextAt, notification_lease_token: null, notification_lease_expires_at: null, updated_at: new Date() }).where(and(eq(t.id, job.id), eq(t.notification_state, 'sending'), eq(t.notification_lease_token, token))); if (job.kind === 'sleep') await db.update(schema.morning_notification_slots).set({ status: 'failed', retry_count: sql`${schema.morning_notification_slots.retry_count} + 1`, next_attempt_at: nextAt, lease_token: null, lease_expires_at: null }).where(and(eq(schema.morning_notification_slots.idempotency_key, morningKey(job.userId, job.localDate)), eq(schema.morning_notification_slots.lease_token, token))); },
  async markNotificationFailed(job, token) { const t = table(job); await db.update(t).set({ notification_state: 'failed', notification_lease_token: null, notification_lease_expires_at: null, updated_at: new Date() }).where(and(eq(t.id, job.id), eq(t.notification_state, 'sending'), eq(t.notification_lease_token, token))); if (job.kind === 'sleep') await db.update(schema.morning_notification_slots).set({ status: 'failed', retry_count: 5, lease_token: null, lease_expires_at: null }).where(and(eq(schema.morning_notification_slots.idempotency_key, morningKey(job.userId, job.localDate)), eq(schema.morning_notification_slots.lease_token, token))); },
  async listDevices(userId) { const rows = await db.select().from(schema.push_devices).where(and(eq(schema.push_devices.user_id, userId), isNull(schema.push_devices.invalidated_at))); return rows.map((r) => ({ id: r.id, token: r.device_token, environment: r.environment as PushDevice['environment'] })); },
  async recordPushAttempt(job, device, attempt, result) { await db.insert(schema.push_attempts).values({ user_id: job.userId, push_device_id: device.id, idempotency_key: notificationKey(job), notification_type: job.kind, target_id: job.id, attempt_number: job.notificationRetryCount * 100 + attempt, status: result.outcome === 'sent' ? 'sent' : `${result.outcome}_failure`, apns_status: result.status, failure_category: result.category, latency_ms: result.latencyMs }).onConflictDoNothing(); },
  async retireDevice(deviceId, now) { await db.update(schema.push_devices).set({ invalidated_at: now, updated_at: now }).where(eq(schema.push_devices.id, deviceId)); },
  async markNotificationSent(job, token, now) { const t = table(job); await db.update(t).set({ notification_state: 'sent', notification_sent_at: now, notification_lease_token: null, notification_lease_expires_at: null, updated_at: now }).where(and(eq(t.id, job.id), eq(t.notification_state, 'sending'), eq(t.notification_lease_token, token))); if (job.kind === 'sleep') await db.update(schema.morning_notification_slots).set({ status: 'sent', sent_at: now, lease_token: null, lease_expires_at: null }).where(and(eq(schema.morning_notification_slots.idempotency_key, morningKey(job.userId, job.localDate)), eq(schema.morning_notification_slots.lease_token, token))); },
};

function localMinute(date: Date, timezone: string): number { try { const values = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date); return Number(values.find((x) => x.type === 'hour')?.value) * 60 + Number(values.find((x) => x.type === 'minute')?.value); } catch { return date.getUTCHours() * 60 + date.getUTCMinutes(); } }

export async function listReadyNotificationCandidates(now: Date, limit = 40): Promise<Array<{ job: AnalysisJob; result: CoachAnalysis }>> {
  const rows = await db.execute(sql<RawJob>`
    select id,user_id,workout_date::text local_date,input_payload,notification_retry_count retry_count,'workout'::text kind,result,notification_state,notification_lease_expires_at,notification_next_attempt_at
    from ${schema.workout_analyses} where status='ready' and result is not null and notification_next_attempt_at <= ${now}
      and (notification_state='pending' or (notification_state='sending' and notification_lease_expires_at <= ${now}))
    union all
    select id,user_id,wake_date::text local_date,input_payload,notification_retry_count retry_count,'sleep'::text kind,result,notification_state,notification_lease_expires_at,notification_next_attempt_at
    from ${schema.sleep_analyses} where status='ready' and result is not null and notification_next_attempt_at <= ${now}
      and (notification_state='pending' or (notification_state='sending' and notification_lease_expires_at <= ${now}))
    order by local_date,id limit ${limit}`);
  return (rows as unknown as RawJob[]).filter((row) => notificationClaimable(row.notification_state ?? '', row.notification_lease_expires_at ?? null, row.notification_next_attempt_at ?? now, now)).map((row) => ({ job: { id: row.id, userId: row.user_id, localDate: row.local_date, input: row.input_payload, retryCount: 0, notificationRetryCount: row.retry_count, kind: row.kind, leaseToken: randomUUID() }, result: row.result as CoachAnalysis }));
}

export interface MorningBriefClaim { slotId: string; userId: string; localDate: string; timezone: string; idempotencyKey: string; leaseToken: string; retryCount: number }
export async function claimDueMorningBriefs(now: Date, limit = 20): Promise<MorningBriefClaim[]> {
  const candidates = await db.execute(sql<{ user_id: string; timezone: string; local_date: string; overdue_minutes: number; updated_at: Date }>`
    select p.user_id, p.timezone, (${now} at time zone p.timezone)::date::text local_date,
      ((extract(hour from (${now} at time zone p.timezone))::int * 60 + extract(minute from (${now} at time zone p.timezone))::int) - p.morning_brief_time_minutes) overdue_minutes, p.updated_at
    from ${schema.notification_preferences} p
    where p.morning_brief_enabled = true
      and exists (select 1 from ${schema.push_devices} d where d.user_id=p.user_id and d.invalidated_at is null)
      and (extract(hour from (${now} at time zone p.timezone))::int * 60 + extract(minute from (${now} at time zone p.timezone))::int) >= p.morning_brief_time_minutes`);
  const due = (candidates as unknown as Array<{ user_id: string; timezone: string; local_date: string; overdue_minutes: number; updated_at: Date }>).sort((a, b) => compareDueCandidates({ overdueMinutes: Number(a.overdue_minutes), updatedAt: a.updated_at }, { overdueMinutes: Number(b.overdue_minutes), updatedAt: b.updated_at })).map((row) => ({ userId: row.user_id, timezone: row.timezone, localDate: row.local_date, idempotencyKey: morningKey(row.user_id, row.local_date) }));
  const claims: MorningBriefClaim[] = [];
  for (const candidate of due) {
    const token = randomUUID(); const lease = new Date(now.getTime() + LEASE_MS);
    const row = await claimMorningSlot({
      async tryInsert() { const rows = await db.insert(schema.morning_notification_slots).values({ user_id: candidate.userId, local_date: candidate.localDate, claimed_by: 'brief', idempotency_key: candidate.idempotencyKey, claimed_at: now, lease_token: token, lease_expires_at: lease, next_attempt_at: now }).onConflictDoNothing().returning({ id: schema.morning_notification_slots.id, retryCount: schema.morning_notification_slots.retry_count }); return rows[0] ?? null; },
      async tryRecover(actor) { const rows = await db.update(schema.morning_notification_slots).set({ status: 'claimed', lease_token: token, lease_expires_at: lease, claimed_at: now }).where(and(eq(schema.morning_notification_slots.idempotency_key, candidate.idempotencyKey), eq(schema.morning_notification_slots.claimed_by, actor), sql`${schema.morning_notification_slots.retry_count} < 5`, sql`${schema.morning_notification_slots.next_attempt_at} <= ${now}`, sql`(${schema.morning_notification_slots.status} = 'failed' or (${schema.morning_notification_slots.status} = 'claimed' and ${schema.morning_notification_slots.lease_expires_at} <= ${now}))`)).returning({ id: schema.morning_notification_slots.id, retryCount: schema.morning_notification_slots.retry_count }); return rows[0] ?? null; },
    }, 'brief');
    if (row) claims.push({ ...candidate, slotId: row.id, leaseToken: token, retryCount: row.retryCount });
    if (claims.length >= limit) break;
  }
  return claims;
}

export async function failMorningBrief(claim: MorningBriefClaim, now: Date): Promise<boolean> {
  return failOwnedMorningSlot({ async apply(ownerToken, transition) {
    const rows = await db.update(schema.morning_notification_slots).set({ status: 'failed', retry_count: transition.retryCount, next_attempt_at: transition.nextAttemptAt, lease_token: null, lease_expires_at: null }).where(and(eq(schema.morning_notification_slots.id, claim.slotId), eq(schema.morning_notification_slots.lease_token, ownerToken), eq(schema.morning_notification_slots.status, 'claimed'))).returning({ id: schema.morning_notification_slots.id });
    return rows.length === 1;
  } }, claim.leaseToken, claim.retryCount, now);
}

export async function completeMorningBrief(claim: MorningBriefClaim, result: CoachAnalysis, send: (device: PushDevice, result: CoachAnalysis) => Promise<PushOutcome>, now: Date): Promise<void> {
  const devices = await workerRepository.listDevices(claim.userId);
  let sent = false; let transient = false; let attempt = claim.retryCount * 100;
  for (const device of devices) {
    for (let retry = 0; retry < 3; retry++) {
      const renewed = await db.update(schema.morning_notification_slots).set({ lease_expires_at: new Date(Date.now() + LEASE_MS) }).where(and(eq(schema.morning_notification_slots.id, claim.slotId), eq(schema.morning_notification_slots.lease_token, claim.leaseToken), eq(schema.morning_notification_slots.status, 'claimed'))).returning({ id: schema.morning_notification_slots.id });
      if (!renewed.length) return;
      const outcome = await send(device, result); sent ||= outcome.outcome === 'sent'; transient ||= outcome.outcome === 'transient';
      await db.insert(schema.push_attempts).values({ user_id: claim.userId, push_device_id: device.id, idempotency_key: claim.idempotencyKey, notification_type: 'brief', attempt_number: ++attempt, status: outcome.outcome === 'sent' ? 'sent' : `${outcome.outcome}_failure`, apns_status: outcome.status, failure_category: outcome.category, latency_ms: outcome.latencyMs }).onConflictDoNothing();
      if (outcome.retireToken) await workerRepository.retireDevice(device.id, now);
      if (outcome.outcome !== 'transient') break;
    }
  }
  if (!sent && transient) { await failMorningBrief(claim, now); return; }
  await db.update(schema.morning_notification_slots).set({ status: sent ? 'sent' : 'failed', sent_at: sent ? now : null, retry_count: sent ? claim.retryCount : 5, next_attempt_at: now, lease_token: null, lease_expires_at: null }).where(and(eq(schema.morning_notification_slots.id, claim.slotId), eq(schema.morning_notification_slots.lease_token, claim.leaseToken)));
}
