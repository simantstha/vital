/**
 * Vital — unit system preference (pure parsing + DB lookup).
 *
 * `users.unit_system` governs *rendering only* — every value stored anywhere
 * in the schema (heightCm, weightKg, distances, etc.) remains canonically
 * metric. This module is the single place that turns an untrusted/raw value
 * (request body, DB row) into the closed `UnitSystem` type, so validation and
 * fallback behavior can't drift between call sites.
 *
 * Two entry points, deliberately different strictness:
 *  - `parseUnitSystem` — strict, for writes/validation. Anything that isn't
 *    exactly 'metric'/'imperial' (case/whitespace-insensitive) is rejected
 *    with `null`, so callers can 400 on a bad PATCH body.
 *  - `resolveUnitSystem` — lenient, for reads/normalization-on-write.
 *    null/garbage silently falls back to 'metric' rather than erroring, so
 *    older clients sending unexpected values don't get rejected.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';

export type UnitSystem = 'metric' | 'imperial';

export const DEFAULT_UNIT_SYSTEM: UnitSystem = 'metric';

/** Strict parse: exactly 'metric' | 'imperial' (case/whitespace-insensitive) — `null` otherwise. */
export function parseUnitSystem(raw: unknown): UnitSystem | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'metric' || normalized === 'imperial') return normalized;
  return null;
}

/** Lenient parse: null/garbage falls back to the metric default instead of erroring. */
export function resolveUnitSystem(raw: unknown): UnitSystem {
  return parseUnitSystem(raw) ?? DEFAULT_UNIT_SYSTEM;
}

/** Looks up the user's stored preference and resolves it against the default. */
export async function getUserUnitSystem(userId: string): Promise<UnitSystem> {
  const [row] = await db
    .select({ unit_system: schema.users.unit_system })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return resolveUnitSystem(row?.unit_system);
}
