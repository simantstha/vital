/**
 * Owner-run, one-off: re-queue workout/sleep analyses that were stored as the
 * static fallback ("Coach's take: ... couldn't put together a proper read ...")
 * because the model call failed, so the worker regenerates them — WITHOUT
 * sending a second push notification.
 *
 * Why those rows are wrong: scripts/proactive-health-worker.ts called Sonnet 5
 * without `thinking: { type: 'disabled' }`, adaptive thinking ate max_tokens,
 * and both the first call and the repair call returned truncated JSON.
 *
 *   npx tsx scripts/requeue-fallback-analyses.ts                  # dry run: counts only
 *   npx tsx scripts/requeue-fallback-analyses.ts --days 7         # narrower window (default 14)
 *   npx tsx scripts/requeue-fallback-analyses.ts --apply          # write
 *
 * Run it ONLY after the worker with the thinking fix is deployed — otherwise
 * the re-run fails the same way and just rewrites the fallback. It needs
 * DATABASE_URL (it connects with the same client as the app); nothing here
 * calls Anthropic or APNs.
 *
 * What it matches: status 'ready' rows created or updated in the last N days
 * whose result->>'narrative' is exactly the old or the new fallback narrative
 * (workout and sleep variants), skipping soft-deleted workouts and rows whose
 * push is mid-send. What it writes is documented on requeueFieldValues
 * (lib/requeueFallbackAnalyses.ts): status 'pending', retry_count 0,
 * next_attempt_at now, lease cleared, notification_state 'suppressed'. The
 * stored result is left in place so the analysis screen keeps rendering the
 * old copy until the worker overwrites it. A user who has switched these
 * notifications off is handled by the worker as usual (their row is marked
 * suppressed and keeps the fallback copy).
 *
 * Output is counts per table only — never user ids, row ids or health data.
 */
import {
  fallbackNarratives,
  formatRequeueReport,
  parseRequeueArgs,
  requeueCutoff,
  requeueFieldValues,
  type RequeueCounts,
} from '../lib/requeueFallbackAnalyses';

async function main(argv: string[]): Promise<void> {
  const options = parseRequeueArgs(argv);
  const now = new Date();
  const cutoff = requeueCutoff(now, options.days);
  const { db, schema } = await import('../db');
  const { and, eq, gte, inArray, isNull, ne, or, sql } = await import('drizzle-orm');

  const workoutWhere = and(
    eq(schema.workout_analyses.status, 'ready'),
    // A push in flight owns notification_state; leave that row for a later run.
    ne(schema.workout_analyses.notification_state, 'sending'),
    inArray(sql<string>`${schema.workout_analyses.result} ->> 'narrative'`, fallbackNarratives('workout')),
    or(gte(schema.workout_analyses.created_at, cutoff), gte(schema.workout_analyses.updated_at, cutoff)),
    // claimAnalysisJobs ignores soft-deleted workouts, so requeueing one would strand it.
    isNull(schema.workout_analyses.deleted_at),
  );
  const sleepWhere = and(
    eq(schema.sleep_analyses.status, 'ready'),
    ne(schema.sleep_analyses.notification_state, 'sending'),
    inArray(sql<string>`${schema.sleep_analyses.result} ->> 'narrative'`, fallbackNarratives('sleep')),
    or(gte(schema.sleep_analyses.created_at, cutoff), gte(schema.sleep_analyses.updated_at, cutoff)),
  );

  const values = requeueFieldValues(now);
  let counts: RequeueCounts;
  if (options.apply) {
    // One transaction: both tables requeue together or not at all.
    counts = await db.transaction(async (tx) => {
      const workouts = await tx.update(schema.workout_analyses).set(values).where(workoutWhere).returning({ id: schema.workout_analyses.id });
      const sleeps = await tx.update(schema.sleep_analyses).set(values).where(sleepWhere).returning({ id: schema.sleep_analyses.id });
      return { workout_analyses: workouts.length, sleep_analyses: sleeps.length };
    });
  } else {
    const [workouts] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.workout_analyses).where(workoutWhere);
    const [sleeps] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.sleep_analyses).where(sleepWhere);
    counts = { workout_analyses: workouts?.n ?? 0, sleep_analyses: sleeps?.n ?? 0 };
  }

  console.log(formatRequeueReport(options, counts));
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'requeue failed');
    process.exit(1);
  },
);
