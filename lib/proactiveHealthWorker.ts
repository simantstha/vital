import { localDayKey } from './localDay';
import { type CoachAnalysis } from './proactiveAnalysisSchema';
import { consumeGroundedAnalysisProof, type GroundedAnalysisProof, type ProactiveAnalysisSource } from './proactiveAnalysisGrounding';

export { parseCoachAnalysis, type CoachAnalysis } from './proactiveAnalysisSchema';

export type AnalysisKind = 'workout' | 'sleep';
export interface AnalysisJob { id: string; kind: AnalysisKind; userId: string; localDate: string; input: unknown; retryCount: number; notificationRetryCount: number; leaseToken: string }
export interface AnalysisContext { enabled: boolean; timezone: string; baselines: unknown; profile: unknown; metrics: unknown }
export interface PushDevice { id: string; token: string; environment: 'sandbox' | 'production' }
export type PushOutcome = { outcome: 'sent' | 'transient' | 'permanent'; retireToken: boolean; status?: number; category?: string; latencyMs?: number };

export interface WorkerRepository {
  getContext(job: AnalysisJob): Promise<AnalysisContext>;
  renewAnalysisLease(job: AnalysisJob, now: Date): Promise<boolean>;
  storeReady(job: AnalysisJob, result: CoachAnalysis): Promise<boolean>;
  markRetry(job: AnalysisJob, nextAt: Date): Promise<boolean>;
  markFailed(job: AnalysisJob): Promise<boolean>;
  suppress(job: AnalysisJob): Promise<boolean>;
  suppressNotification(job: AnalysisJob, now: Date): Promise<boolean>;
  claimNotification(job: AnalysisJob, now: Date): Promise<string | null>;
  renewNotificationLease(job: AnalysisJob, token: string, now: Date): Promise<boolean>;
  markNotificationRetry(job: AnalysisJob, token: string, nextAt: Date): Promise<void>;
  markNotificationFailed(job: AnalysisJob, token: string): Promise<void>;
  listDevices(userId: string): Promise<PushDevice[]>;
  recordPushAttempt(job: AnalysisJob, device: PushDevice, attempt: number, result: PushOutcome): Promise<void>;
  retireDevice(deviceId: string, now: Date): Promise<void>;
  markNotificationSent(job: AnalysisJob, token: string, now: Date): Promise<void>;
}

export function nextRetryAt(now: Date, retryCount: number): Date {
  const minutes = Math.min(360, 2 ** Math.max(0, retryCount));
  return new Date(now.getTime() + minutes * 60_000);
}

export function classifyApnsResponse(status: number, reason?: string): PushOutcome {
  if (status === 200) return { outcome: 'sent', retireToken: false };
  if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') return { outcome: 'permanent', retireToken: true };
  if (status === 429 || status >= 500) return { outcome: 'transient', retireToken: false };
  return { outcome: 'permanent', retireToken: false };
}

function localParts(now: Date, timezone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    return { hour: Number(parts.find((p) => p.type === 'hour')?.value), minute: Number(parts.find((p) => p.type === 'minute')?.value) };
  } catch { return { hour: now.getUTCHours(), minute: now.getUTCMinutes() }; }
}

export function shouldRunMorningBrief(now: Date, timezone: string, configuredMinutes: number): boolean {
  const { hour, minute } = localParts(now, timezone);
  return hour * 60 + minute >= configuredMinutes;
}

export function notificationKey(job: AnalysisJob): string { return `${job.kind}:${job.id}`; }
export function morningKey(userId: string, date: string): string { return `morning:${userId}:${date}`; }
export function currentLocalDate(now: Date, timezone: string): string { return localDayKey(now, timezone); }

export function consumeMorningAnalysisProof(proof: GroundedAnalysisProof, expectedSource: ProactiveAnalysisSource): CoachAnalysis {
  return consumeGroundedAnalysisProof(proof, expectedSource);
}

export async function runClaimedAnalysis(
  job: AnalysisJob,
  repository: WorkerRepository,
  analyze: (job: AnalysisJob, context: AnalysisContext) => Promise<GroundedAnalysisProof>,
  push: (device: PushDevice, analysis: CoachAnalysis) => Promise<PushOutcome>,
  now: Date,
  maxRetries = 5,
): Promise<void> {
  try {
    if (!await repository.renewAnalysisLease(job, now)) return;
    const context = await repository.getContext(job);
    if (!context.enabled) { await repository.suppress(job); return; }
    const proof = await analyze(job, context);
    const result = consumeGroundedAnalysisProof(proof, {
      kind: job.kind,
      date: job.localDate,
      input: job.input,
      availableContext: context,
    });
    if (!await repository.renewAnalysisLease(job, new Date())) return;
    if (!await repository.storeReady(job, result)) return;
    const notificationToken = await repository.claimNotification(job, now);
    if (!notificationToken) return;
    await deliverNotification(job, result, notificationToken, repository, push, now, maxRetries);
  } catch {
    if (job.retryCount < maxRetries) await repository.markRetry(job, nextRetryAt(now, job.retryCount));
    else await repository.markFailed(job);
  }
}

/** APNs has no idempotency key: a crash after Apple accepts but before our CAS may duplicate once on lease recovery. */
export async function deliverNotification(job: AnalysisJob, result: CoachAnalysis, notificationToken: string, repository: WorkerRepository, push: (device: PushDevice, analysis: CoachAnalysis) => Promise<PushOutcome>, now: Date, maxRetries = 5): Promise<void> {
    const devices = await repository.listDevices(job.userId);
    let sent = false;
    let transient = false;
    let attempt = 0;
    for (const device of devices) {
      if (!await repository.renewNotificationLease(job, notificationToken, new Date())) return;
      const outcome = await push(device, result);
      if (!await repository.renewNotificationLease(job, notificationToken, new Date())) return;
      await repository.recordPushAttempt(job, device, ++attempt, outcome);
      if (outcome.retireToken) await repository.retireDevice(device.id, now);
      sent ||= outcome.outcome === 'sent';
      transient ||= outcome.outcome === 'transient';
    }
    if (sent) await repository.markNotificationSent(job, notificationToken, now);
    else if (transient && job.notificationRetryCount < maxRetries) await repository.markNotificationRetry(job, notificationToken, nextRetryAt(now, job.notificationRetryCount));
    else await repository.markNotificationFailed(job, notificationToken);
}
