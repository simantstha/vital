import { type AnalysisKind } from './proactiveHealthWorker';

export interface RawSqlTimeBindings {
  now: string;
  lease: string;
}

export interface AnalysisAlert { title: string; body: string }

/** Static, LLM-free push copy for workout/sleep jobs — the analysis content lives behind the tap, not on the lock screen. */
export function analysisAlert(kind: AnalysisKind, input: unknown): AnalysisAlert {
  if (kind === 'sleep') return { title: 'Sleep logged', body: "Last night's sleep has been logged." };
  const type = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).type : undefined;
  if (typeof type === 'string' && type.trim()) return { title: 'Workout logged', body: `Your ${type.trim().toLowerCase()} workout has been logged.` };
  return { title: 'Workout logged', body: 'Your workout has been logged.' };
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
  if (isError) {
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
