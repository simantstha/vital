import { localDayKey } from './localDay';

export type AnalysisKind = 'workout' | 'sleep';
export interface CoachAnalysis { headline: string; shortInsight: string; narrative: string; observations: string[]; nextSteps: string[] }
export interface AnalysisJob { id: string; kind: AnalysisKind; userId: string; localDate: string; input: unknown; retryCount: number }
export interface AnalysisContext { enabled: boolean; timezone: string; baselines: unknown; profile: unknown; metrics: unknown }
export interface PushDevice { id: string; token: string; environment: 'sandbox' | 'production' }
export type PushOutcome = { outcome: 'sent' | 'transient' | 'permanent'; retireToken: boolean; status?: number; category?: string; latencyMs?: number };

export interface WorkerRepository {
  getContext(job: AnalysisJob): Promise<AnalysisContext>;
  storeReady(job: AnalysisJob, result: CoachAnalysis): Promise<void>;
  markRetry(job: AnalysisJob, nextAt: Date): Promise<void>;
  markFailed(job: AnalysisJob): Promise<void>;
  suppress(job: AnalysisJob): Promise<void>;
  claimNotification(job: AnalysisJob, now: Date): Promise<boolean>;
  listDevices(userId: string): Promise<PushDevice[]>;
  recordPushAttempt(job: AnalysisJob, device: PushDevice, attempt: number, result: PushOutcome): Promise<void>;
  retireDevice(deviceId: string, now: Date): Promise<void>;
  markNotificationSent(job: AnalysisJob, now: Date): Promise<void>;
}

const limits: Record<keyof CoachAnalysis, number> = { headline: 120, shortInsight: 240, narrative: 1200, observations: 6, nextSteps: 5 };
export function parseCoachAnalysis(value: unknown): CoachAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coach output must be an object');
  const row = value as Record<string, unknown>;
  const expected = Object.keys(limits);
  for (const key of Object.keys(row)) if (!expected.includes(key)) throw new Error(`unexpected field: ${key}`);
  for (const key of ['headline', 'shortInsight', 'narrative'] as const) {
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > limits[key]) throw new Error(`invalid ${key}`);
  }
  for (const key of ['observations', 'nextSteps'] as const) {
    if (!Array.isArray(row[key]) || row[key].length > limits[key] || row[key].some((x) => typeof x !== 'string' || !x.trim() || x.length > 240)) throw new Error(`invalid ${key}`);
  }
  return row as unknown as CoachAnalysis;
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

export async function runClaimedAnalysis(
  job: AnalysisJob,
  repository: WorkerRepository,
  analyze: (job: AnalysisJob, context: AnalysisContext) => Promise<unknown>,
  push: (device: PushDevice, analysis: CoachAnalysis) => Promise<PushOutcome>,
  now: Date,
  maxRetries = 5,
): Promise<void> {
  try {
    const context = await repository.getContext(job);
    if (!context.enabled) { await repository.suppress(job); return; }
    const result = parseCoachAnalysis(await analyze(job, context));
    await repository.storeReady(job, result);
    if (!await repository.claimNotification(job, now)) return;
    const devices = await repository.listDevices(job.userId);
    let sent = false;
    let transient = false;
    let attempt = 0;
    for (const device of devices) {
      const outcome = await push(device, result);
      await repository.recordPushAttempt(job, device, ++attempt, outcome);
      if (outcome.retireToken) await repository.retireDevice(device.id, now);
      sent ||= outcome.outcome === 'sent';
      transient ||= outcome.outcome === 'transient';
    }
    if (sent) await repository.markNotificationSent(job, now);
    else if (transient && job.retryCount < maxRetries) await repository.markRetry(job, nextRetryAt(now, job.retryCount));
    else await repository.markFailed(job);
  } catch {
    if (job.retryCount < maxRetries) await repository.markRetry(job, nextRetryAt(now, job.retryCount));
    else await repository.markFailed(job);
  }
}
