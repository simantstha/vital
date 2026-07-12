import { localDayKey } from './localDay';

export type AnalysisKind = 'workout' | 'sleep';
export interface CoachAnalysis { headline: string; shortInsight: string; narrative: string; observations: string[]; nextSteps: string[] }
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

const unitAliases: Record<string, string> = { milliseconds: 'ms', millisecond: 'ms', bpm: 'bpm', '%': '%', kg: 'kg', km: 'km', mi: 'mi', kcal: 'kcal', calorie: 'kcal', calories: 'kcal', step: 'steps', steps: 'steps', minute: 'minutes', minutes: 'minutes', min: 'minutes', mins: 'minutes', hour: 'hours', hours: 'hours', hr: 'hours', hrs: 'hours' };
function inferredUnit(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (lower.includes('hrv') || lower.endsWith('_ms')) return 'ms';
  if (lower.includes('heart_rate') || lower === 'rhr' || lower.includes('resting_hr') || lower.includes('avg_hr')) return 'bpm';
  if (lower.includes('percent') || lower.includes('efficiency')) return '%';
  if (lower.includes('weight') || lower.endsWith('_kg')) return 'kg';
  if (lower.includes('calorie') || lower.includes('kcal') || lower.includes('energy')) return 'kcal';
  if (lower.includes('step')) return 'steps';
  if (lower.includes('minute')) return 'minutes';
}
export function validateGroundedAnalysis(result: CoachAnalysis, evidence: unknown): CoachAnalysis {
  const values = new Map<string, Set<string>>();
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'number' && Number.isFinite(value)) { const normalized = String(value); const units = values.get(normalized) ?? new Set<string>(); const unit = inferredUnit(key); if (unit) units.add(unit); values.set(normalized, units); }
    else if (typeof value === 'string') { for (const match of value.matchAll(/\b(\d+(?:\.\d+)?)\s*(%|ms|bpm|kg|km|mi|kcal|calories?|steps?|minutes?|mins?|hours?|hrs?)?/gi)) { const units = values.get(match[1]) ?? new Set<string>(); if (match[2]) units.add(unitAliases[match[2].toLowerCase()] ?? match[2].toLowerCase()); values.set(match[1], units); } }
    else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (typeof object.value === 'number' && typeof object.metric === 'string') visit(object.value, object.metric);
      for (const [childKey, child] of Object.entries(object)) if (childKey !== 'value' || typeof object.metric !== 'string') visit(child, childKey);
    }
  };
  visit(evidence);
  const text = [result.headline, result.shortInsight, result.narrative, ...result.observations, ...result.nextSteps].join(' ');
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(%|ms|bpm|kg|km|mi|kcal|calories?|steps?|minutes?|mins?|hours?|hrs?)?/gi)) {
    const supported = values.get(match[1]);
    if (!supported) throw new Error(`unsupported numeric claim: ${match[1]}`);
    if (match[2]) { const unit = unitAliases[match[2].toLowerCase()] ?? match[2].toLowerCase(); if (!supported.has(unit)) throw new Error(`unsupported unit claim: ${match[1]} ${unit}`); }
  }
  return result;
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
    if (!await repository.renewAnalysisLease(job, now)) return;
    const context = await repository.getContext(job);
    if (!context.enabled) { await repository.suppress(job); return; }
    const result = validateGroundedAnalysis(parseCoachAnalysis(await analyze(job, context)), { input: job.input, context });
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
