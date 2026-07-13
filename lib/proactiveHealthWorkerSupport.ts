export interface RawSqlTimeBindings {
  now: string;
  lease: string;
}

export function rawSqlTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid raw SQL timestamp.');
  return date.toISOString();
}

export function rawSqlTimeBindings(now: Date, leaseMs: number): RawSqlTimeBindings {
  return {
    now: rawSqlTimestamp(now),
    lease: rawSqlTimestamp(new Date(now.getTime() + leaseMs)),
  };
}

export const WORKER_STAGES = [
  'ensure-default-preferences',
  'claim-analysis-jobs',
  'process-analysis-job',
  'list-notification-candidates',
  'deliver-notification',
  'claim-morning-briefs',
  'process-morning-brief',
] as const;

export type WorkerStage = (typeof WORKER_STAGES)[number];

export interface WorkerErrorEvent {
  event: 'proactive_worker_error';
  stage: WorkerStage;
  errorName: string;
  code?: string | number;
}

const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'PostgresError', 'DrizzleQueryError']);
const SAFE_STRING_CODE = /^(?:ERR_[A-Z0-9_]{1,59}|[0-9A-Z]{5})$/;

export function workerErrorEvent(stage: WorkerStage, error: unknown): WorkerErrorEvent {
  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    // Hostile proxies can throw during prototype inspection.
  }

  let errorName = isError ? 'Error' : 'UnknownError';
  if (isError) {
    try {
      const candidateName = (error as Error).name;
      if (SAFE_ERROR_NAMES.has(candidateName)) errorName = candidateName;
    } catch {
      // Error metadata is untrusted and must never break worker recovery.
    }
  }

  let code: unknown;
  if (typeof error === 'object' && error !== null) {
    try {
      code = (error as { code?: unknown }).code;
    } catch {
      // Omit inaccessible codes rather than exposing or propagating them.
    }
  }
  const base: WorkerErrorEvent = { event: 'proactive_worker_error', stage, errorName };
  if (typeof code === 'string' && SAFE_STRING_CODE.test(code)) return { ...base, code };
  if (typeof code === 'number' && Number.isFinite(code)) return { ...base, code };
  return base;
}
