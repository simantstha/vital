import { FALLBACK_NARRATIVE, type AnalysisKind } from './proactiveHealthWorker';

/**
 * Pure helpers for scripts/requeue-fallback-analyses.ts (the owner-run script
 * that re-queues workout/sleep analyses that were stored as the static
 * fallback because the model call failed). Kept free of any DB or env access so
 * the row filter and the update payload are unit-testable.
 */

export const DEFAULT_REQUEUE_DAYS = 14;
const MAX_REQUEUE_DAYS = 365;
const DAY_MS = 24 * 60 * 60_000;

/**
 * The narrative `fallbackAnalysis` stored before the copy was reworded
 * (the version users saw while the adaptive-thinking truncation bug was live).
 * Frozen here on purpose: the current copy lives in FALLBACK_NARRATIVE and may
 * change again, but rows written under this wording still need recognising.
 */
export const LEGACY_FALLBACK_NARRATIVE: Record<AnalysisKind, string> = {
  workout: "We've saved this workout and it counts toward your trends. I couldn't put together a proper read on it this time.",
  sleep: "We've saved last night's sleep and it counts toward your trends. I couldn't put together a proper read on it this time.",
};

/** Every narrative a fallback row of this kind may carry: the legacy wording and the current one. */
export function fallbackNarratives(kind: AnalysisKind): string[] {
  return [LEGACY_FALLBACK_NARRATIVE[kind], FALLBACK_NARRATIVE[kind]];
}

/** Exact-match test mirroring the SQL filter `result->>'narrative' in (...)`. */
export function isFallbackNarrative(kind: AnalysisKind, narrative: unknown): boolean {
  return typeof narrative === 'string' && fallbackNarratives(kind).includes(narrative);
}

export interface RequeueOptions {
  apply: boolean;
  days: number;
}

/** `--apply` writes (default is a dry run); `--days N` (default 14) bounds how far back to look. Anything else is rejected. */
export function parseRequeueArgs(argv: string[]): RequeueOptions {
  let apply = false;
  let days = DEFAULT_REQUEUE_DAYS;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') { apply = true; continue; }
    const inline = arg.startsWith('--days=') ? arg.slice('--days='.length) : undefined;
    if (arg === '--days' || inline !== undefined) {
      const raw = inline ?? argv[++index];
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error('--days needs a whole number of days.');
      days = Number(raw);
      if (days < 1 || days > MAX_REQUEUE_DAYS) throw new Error(`--days must be between 1 and ${MAX_REQUEUE_DAYS}.`);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}. Usage: requeue-fallback-analyses.ts [--apply] [--days N]`);
  }
  return { apply, days };
}

/** Rows created or updated at or after this instant are in scope. */
export function requeueCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * The exact columns written to put a fallback row back on the worker queue:
 *
 *  - status 'pending' + next_attempt_at now + lease cleared: claimAnalysisJobs
 *    (lib/proactiveHealthWorkerRepository.ts) picks up `status = 'pending'`
 *    rows whose next_attempt_at has passed. The stored `result` is left alone,
 *    so the analysis screen keeps showing the fallback copy until storeReady
 *    overwrites it (the API gates on `result`, not status — see
 *    lib/proactiveHealthHttp.ts).
 *  - retry_count 0: a full retry budget for the regeneration.
 *  - notification_state 'suppressed': claimNotification and
 *    listReadyNotificationCandidates only act on 'pending' (or an expired
 *    'sending'), and storeReady never touches this column, so the regenerated
 *    analysis is stored without a second push. markRetry preserves 'suppressed'
 *    too. notification_sent_at is untouched, so "was this ever pushed" stays
 *    answerable.
 */
export function requeueFieldValues(now: Date) {
  return {
    status: 'pending' as const,
    retry_count: 0,
    next_attempt_at: now,
    lease_token: null,
    lease_expires_at: null,
    notification_state: 'suppressed' as const,
  };
}

export interface RequeueCounts {
  workout_analyses: number;
  sleep_analyses: number;
}

/** Counts only — never ids, user ids or health data. */
export function formatRequeueReport(options: RequeueOptions, counts: RequeueCounts): string {
  const verb = options.apply ? 'requeued' : 'matched';
  return [
    `mode=${options.apply ? 'apply' : 'dry-run'}`,
    `days=${options.days}`,
    `workout_analyses_${verb}=${counts.workout_analyses}`,
    `sleep_analyses_${verb}=${counts.sleep_analyses}`,
    ...(options.apply ? [] : ['Dry run: nothing was written. Re-run with --apply to requeue.']),
  ].join('\n');
}
