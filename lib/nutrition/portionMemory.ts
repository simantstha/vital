/**
 * Vital — portion memory
 *
 * Stores a user's own portion corrections ("white rice, cooked" → 380 g
 * typical) so lib/nutrition/estimator.ts's step-1 parse can lean on what
 * THIS user actually eats instead of a generic guess, and a scale/grams
 * correction (see app/api/meals/scale/route.ts) teaches the estimator over
 * time instead of repeating the same wrong portion every time.
 *
 * Storage choice: nutrition-habits.json under a new top-level `portionMemory`
 * map, not a new table. This file (lib/memory.ts / lib/memoryFilesStore.ts)
 * is already a per-user, Postgres-backed (`users.memory_files`) JSON document
 * that onboarding (app/api/onboarding/route.ts's mergeJsonMemoryFile) and the
 * coach's write_memory tool both read/write — the read/write/backfill/legacy-
 * disk-cache plumbing for exactly this shape already exists and is exercised
 * in production. The alternatives in db/schema.ts don't fit as well: `events`
 * is an append-only per-meal log, not a per-food key/value lookup; `nodes`
 * (lib/brain/memoryTiers.ts's ontology) tracks qualitative facts about the
 * user with a source/weight/confirmation lifecycle built for the coach's
 * remember_fact flow, which is more machinery than one numeric field needs.
 * Only if this file didn't exist would a new additive migration make sense.
 *
 * Read-modify-write is shallow at the FILE level (nutrition-habits.json as a
 * whole) — see lib/memoryFilesStore.ts's setMemoryFileEntry for why that's
 * atomic against a *sibling* file (e.g. `diet` in the same file written by
 * onboarding) is a SQL-level jsonb merge, not a JS spread. Two concurrent
 * portionMemory writes for two different foods on the same user could still
 * race and one could clobber the other; this is the same tradeoff already
 * accepted by app/api/onboarding/route.ts's mergeJsonMemoryFile for this
 * exact file, and portion corrections are rare, user-initiated, one-off taps
 * (not a hot concurrent-write path), so it's an acceptable pragmatic choice
 * rather than a new atomicity mechanism.
 */

import { readMemoryFile, writeMemoryFile } from '@/lib/memory';
import { normalizeName } from './candidates';

export interface PortionMemoryEntry {
  /** Display name as corrected, e.g. "White rice, cooked". */
  food: string;
  /** This user's typical grams for `food`. */
  grams: number;
  updatedAt: string;
}

interface NutritionHabits {
  portionMemory?: Record<string, PortionMemoryEntry>;
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

/** All portion corrections recorded for `userId`, in no particular order. */
export async function loadPortionMemory(userId: string): Promise<PortionMemoryEntry[]> {
  const habits = parseHabits(await readMemoryFile(userId, 'nutrition-habits.json'));
  return Object.values(habits.portionMemory ?? {});
}

/** One food's remembered typical grams, by exact normalized name — or null if never corrected. */
export async function getPortionMemoryFor(userId: string, food: string): Promise<PortionMemoryEntry | null> {
  const key = normalizeName(food);
  if (!key) return null;
  const habits = parseHabits(await readMemoryFile(userId, 'nutrition-habits.json'));
  return habits.portionMemory?.[key] ?? null;
}

/**
 * Records (or overwrites) a user's typical grams for one food — called from
 * app/api/meals/scale/route.ts whenever a scale/grams correction implies a
 * concrete portion for a specific food. Silently no-ops on a non-positive or
 * non-finite `grams`, or an empty food name — never throws.
 */
export async function recordPortionCorrection(userId: string, food: string, grams: number): Promise<void> {
  const key = normalizeName(food);
  if (!key || !Number.isFinite(grams) || grams <= 0) return;

  const habits = parseHabits(await readMemoryFile(userId, 'nutrition-habits.json'));
  const portionMemory = { ...(habits.portionMemory ?? {}) };
  portionMemory[key] = { food: food.trim(), grams: Math.round(grams), updatedAt: new Date().toISOString() };

  await writeMemoryFile(userId, 'nutrition-habits.json', JSON.stringify({ ...habits, portionMemory }, null, 2));
}
