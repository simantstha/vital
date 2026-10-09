/**
 * One-off backfill: rewrite workout_sets.exercise / exercise_display through
 * canonicalExercise() so legacy rows ("Bench", "DB bench", ...) join the same
 * history as new logs.
 *
 * Idempotent (rows already canonical are skipped) and DRY-RUN by default.
 *
 *   npx tsx scripts/backfill-exercise-canonical.ts            # report only
 *   npx tsx scripts/backfill-exercise-canonical.ts --apply    # write changes
 *
 * Not a schema migration: no DDL, no unique index involves `exercise`, so
 * rewriting values cannot conflict. Run against production only deliberately,
 * after reviewing the dry-run output.
 */

import { canonicalExercise } from '../lib/exerciseCanonical';

export interface BackfillChange {
  from: { exercise: string; display: string };
  to: { exercise: string; display: string };
}

/** Pure planning step (unit-testable): which distinct (exercise, display) pairs change. */
export function planBackfill(pairs: Array<{ exercise: string; exercise_display: string }>): BackfillChange[] {
  const seen = new Set<string>();
  const changes: BackfillChange[] = [];
  for (const p of pairs) {
    const id = `${p.exercise}\u0000${p.exercise_display}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // Prefer the stored key; fall back to display if the key is empty.
    const canon = canonicalExercise(p.exercise || p.exercise_display);
    if (!canon.key) continue;
    if (canon.key !== p.exercise || canon.display !== p.exercise_display) {
      changes.push({
        from: { exercise: p.exercise, display: p.exercise_display },
        to: { exercise: canon.key, display: canon.display },
      });
    }
  }
  return changes;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { db, schema } = await import('@/db');
  const { and, eq, sql } = await import('drizzle-orm');

  const pairs = await db
    .select({
      exercise: schema.workout_sets.exercise,
      exercise_display: schema.workout_sets.exercise_display,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.workout_sets)
    .groupBy(schema.workout_sets.exercise, schema.workout_sets.exercise_display);

  const changes = planBackfill(pairs);
  console.log(`${pairs.length} distinct (exercise, display) pairs; ${changes.length} need rewriting.`);
  for (const c of changes) {
    console.log(`  "${c.from.exercise}" / "${c.from.display}"  ->  "${c.to.exercise}" / "${c.to.display}"`);
  }

  if (!apply) {
    console.log('Dry run — pass --apply to write.');
    return;
  }

  for (const c of changes) {
    await db
      .update(schema.workout_sets)
      .set({ exercise: c.to.exercise, exercise_display: c.to.display })
      .where(and(
        eq(schema.workout_sets.exercise, c.from.exercise),
        eq(schema.workout_sets.exercise_display, c.from.display),
      ));
  }
  console.log(`Applied ${changes.length} rewrites.`);
}

if (process.argv[1] && process.argv[1].endsWith('backfill-exercise-canonical.ts')) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
