/**
 * Vital Brain — learned-expenditure persistence
 *
 * computeLearnedExpenditure (lib/brain/learnedExpenditure.ts) is pure and
 * stateless — it caps how far a new estimate can move from a *previous*
 * applied value, but has no memory of its own. Something has to durably
 * remember "the last TDEE we actually applied, and when" between calls, or
 * the movement cap does nothing (dietBudget.ts would recompute from scratch
 * on every request with no anchor to cap against).
 *
 * Storage choice: nutrition-habits.json under a new top-level
 * `learnedExpenditure` key, not a new table/column — same reasoning as
 * lib/nutrition/portionMemory.ts (see that file's header): this per-user,
 * Postgres-backed (`users.memory_files`) JSON document already has the
 * read/write/backfill/legacy-disk-cache plumbing this needs, and one more
 * small numeric+timestamp field doesn't justify a migration (AI_COMMON.md:
 * prefer no schema change when an existing store already fits).
 *
 * Same read-modify-write caveat as portionMemory.ts: this is a shallow
 * whole-FILE read-modify-write, so two concurrent writers for the same user
 * (e.g. two nearly-simultaneous /api/today requests) could race and one
 * could clobber the other's `learnedExpenditure` key. Acceptable here for
 * the same reason portionMemory.ts accepts it: dietBudget.ts only writes
 * when the value moved >= 1 kcal (rare relative to read volume), and a lost
 * write in that rare race just means one call's movement isn't recorded —
 * the next call recomputes from the same trend/intake data and tries again.
 */

import { readMemoryFile, writeMemoryFile } from '@/lib/memory';

export interface LearnedExpenditureMemory {
  /** The last TDEE this user was actually shown (post-blend, post-clamp, post-cap). */
  tdee: number;
  /** ISO 8601 instant that value was applied — the anchor computeLearnedExpenditure's movement cap scales against. */
  at: string;
}

interface NutritionHabits {
  learnedExpenditure?: LearnedExpenditureMemory;
  [key: string]: unknown;
}

function parseHabits(raw: string | null): NutritionHabits {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as NutritionHabits) : {};
  } catch {
    return {};
  }
}

function isValidMemory(v: unknown): v is LearnedExpenditureMemory {
  if (v == null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return typeof m.tdee === 'number' && Number.isFinite(m.tdee) && typeof m.at === 'string' && !Number.isNaN(Date.parse(m.at));
}

/**
 * The last applied learned TDEE + when, or null if never recorded (or the
 * stored shape is malformed — treated the same as "never recorded" rather
 * than thrown, since a corrupt anchor should just make the caller start
 * fresh, not break the budget path). Callers must NOT write a new value
 * when this read itself failed (threw) — see dietBudget.ts's
 * computeLearnedExpenditureSummary for that rule; a thrown read is
 * deliberately NOT caught here so the caller can tell the difference
 * between "nothing stored" (null) and "couldn't check" (throws).
 */
export async function loadLearnedExpenditureMemory(userId: string): Promise<LearnedExpenditureMemory | null> {
  const habits = parseHabits(await readMemoryFile(userId, 'nutrition-habits.json'));
  const memory = habits.learnedExpenditure;
  return isValidMemory(memory) ? memory : null;
}

/**
 * Records the newly-applied learned TDEE + timestamp, merged into
 * nutrition-habits.json alongside any sibling keys (e.g. portionMemory,
 * onboarding's `diet`) it doesn't touch. Never throws on a malformed
 * existing file — falls back to treating it as empty, same as
 * portionMemory.ts's parseHabits.
 */
export async function saveLearnedExpenditureMemory(userId: string, tdee: number, at: Date = new Date()): Promise<void> {
  const habits = parseHabits(await readMemoryFile(userId, 'nutrition-habits.json'));
  const learnedExpenditure: LearnedExpenditureMemory = { tdee: Math.round(tdee), at: at.toISOString() };
  await writeMemoryFile(userId, 'nutrition-habits.json', JSON.stringify({ ...habits, learnedExpenditure }, null, 2));
}
