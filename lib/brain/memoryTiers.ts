/**
 * Vital Brain — memory tier contract (provisional / consolidated / user-confirmed)
 *
 * Formalizes the three states an ontology fact (a `nodes` row) can be in and
 * the precedence rule that decides which one wins when the same fact exists
 * at more than one tier. This is the contract a future digest pipeline (which
 * writes `source: 'digest'`) must obey — it does not exist yet; today only
 * 'coach' and 'confirmed' sources are ever written (lib/brain/tools.ts
 * remember_fact / confirmPendingFact, app/api/pending-facts/resolve).
 *
 * ── Precedence is by SOURCE, not weight ──────────────────────────────────────
 * `weight` (see the weight-rules comment above `edges` in db/schema.ts) is a
 * reinforcement/decay signal: it increments when a fact is reinforced and
 * decays weekly. It is NOT the tier-precedence key. The original spec for
 * this feature proposed giving user-confirmed facts weight 1.0; we deliberately
 * did not do that, because every confirmed node already in production is
 * weight 0.9 (see lib/brain/tools.ts confirmPendingFact,
 * app/api/pending-facts/resolve/route.ts) and there is no backfill migration
 * for those rows. Ranking by weight alone would also be wrong on principle: a
 * heavily-reinforced provisional fact must never outrank a fresh
 * user-confirmed one just because its weight climbed. So precedence is
 * determined purely by `source`, via SOURCE_PRECEDENCE below; weight remains
 * available as a tiebreaker within the same source (see sourcePrecedenceSql).
 *
 * ── The three tiers ───────────────────────────────────────────────────────────
 *   provisional    — source: 'coach',     weight 0.6  (remember_fact; a single
 *                    coach turn's guess, unconfirmed by the user)
 *   consolidated   — source: 'digest',    weight 0.75 (NOT YET WRITTEN ANYWHERE
 *                    — reserved for a future batch/digest pass that promotes
 *                    corroborated provisional facts without requiring the
 *                    user to confirm each one individually)
 *   user-confirmed — source: 'confirmed', weight 0.9  (confirm_fact /
 *                    POST /api/pending-facts/resolve; the user explicitly
 *                    approved a proposed fact)
 *
 * ── Protection ────────────────────────────────────────────────────────────────
 * A user-confirmed fact is the one tier a digest pass must never silently
 * overwrite or supersede. assertDigestMutable() is the single gate a future
 * digest writer calls before mutating (editing, resolving, or superseding) a
 * node — amending a user-confirmed fact instead requires proposing a new
 * pending_facts row and going back through user confirmation.
 */

import type { Column, SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

// ── Sources ───────────────────────────────────────────────────────────────────

export type FactSource = 'coach' | 'digest' | 'confirmed';

/**
 * Higher rank wins. Any source not listed here (including sources that don't
 * exist yet, or a corrupt/unexpected value) ranks below all three known
 * tiers — see rankSource().
 *
 * This object is the ONLY place precedence is declared. sourcePrecedenceSql()
 * below derives its SQL CASE expression from these same entries rather than
 * restating them, so the in-database ordering and rankSource() cannot drift
 * apart when a tier is added or re-ranked.
 */
export const SOURCE_PRECEDENCE: Record<FactSource, number> = {
  confirmed: 3,
  digest:    2,
  coach:     1,
};

/** Rank given to any source absent from SOURCE_PRECEDENCE — always lowest. */
export const UNKNOWN_SOURCE_RANK = 0;

/** Ranks an arbitrary source string; unknown sources rank lowest. */
export function rankSource(source: string): number {
  return SOURCE_PRECEDENCE[source as FactSource] ?? UNKNOWN_SOURCE_RANK;
}

// ── Tiers ─────────────────────────────────────────────────────────────────────

export type MemoryTierName = 'provisional' | 'consolidated' | 'userConfirmed';

export interface MemoryTierSpec {
  source: FactSource;
  /** Conventional weight for new writes at this tier — a reinforcement/decay
   *  starting point, not a precedence signal (see header comment). */
  weight: number;
  description: string;
}

export const MEMORY_TIERS: Record<MemoryTierName, MemoryTierSpec> = {
  provisional: {
    source: 'coach',
    weight: 0.6,
    description: 'A single coach turn\'s unconfirmed guess (remember_fact). Lowest precedence.',
  },
  consolidated: {
    source: 'digest',
    weight: 0.75,
    description: 'Corroborated by a digest pass across multiple provisional facts, but never confirmed by the user. Outranks provisional, never outranks user-confirmed.',
  },
  userConfirmed: {
    source: 'confirmed',
    weight: 0.9,
    description: 'The user explicitly confirmed this fact (confirm_fact / pending-facts resolve). Highest precedence; protected from digest mutation.',
  },
};

// ── Protection ────────────────────────────────────────────────────────────────

/**
 * Minimal shape a digest writer needs to check before mutating a node.
 * `properties.confirmed_by === 'user'` is an additional escape hatch for any
 * node that carries user-confirmed provenance in its properties without
 * using source: 'confirmed' directly (e.g. a future migration path) —
 * whichever signal is present is authoritative.
 */
export interface DigestMutationCandidate {
  source: string;
  properties?: unknown;
}

/**
 * Throws if `node` is a user-confirmed fact. A digest pipeline must call this
 * before editing, resolving, or superseding any node — amending a
 * user-confirmed fact instead requires creating a new pending_facts row and
 * routing it back through user confirmation, never a direct write.
 */
export function assertDigestMutable(node: DigestMutationCandidate): void {
  const properties = node.properties;
  const confirmedByUser =
    properties != null &&
    typeof properties === 'object' &&
    (properties as Record<string, unknown>).confirmed_by === 'user';

  if (node.source === 'confirmed' || confirmedByUser) {
    throw new Error(
      'Cannot mutate a user-confirmed fact directly. Propose a new pending_facts row and route it through user confirmation instead.',
    );
  }
}

// ── Reader ordering ───────────────────────────────────────────────────────────

/**
 * SQL CASE expression ranking a `source` column by SOURCE_PRECEDENCE, for use
 * as the primary ORDER BY key ahead of `weight` as a tiebreaker — e.g.
 * `.orderBy(desc(sourcePrecedenceSql(schema.nodes.source)), desc(schema.nodes.weight))`.
 *
 * The branches are GENERATED from SOURCE_PRECEDENCE, never restated here: a
 * hardcoded CASE would silently diverge from rankSource() the first time a
 * tier is added or re-ranked, and nothing in SQL would catch it. The `else`
 * arm matches rankSource()'s fallback, so any source not in SOURCE_PRECEDENCE
 * sorts last in the database exactly as it ranks last in JS.
 *
 * Interpolation: the column is passed through `${sourceColumn}`, which drizzle
 * renders as a quoted identifier; each source *value* is passed as a bound
 * parameter (drizzle's default for a string in a template hole). Only the
 * integer ranks use sql.raw — they can't be bound params in a CASE `then` arm
 * without Postgres losing the result type, and the integer guard below makes
 * that raw interpolation provably safe.
 */
export function sourcePrecedenceSql(sourceColumn: Column): SQL<number> {
  const branches = (Object.entries(SOURCE_PRECEDENCE) as Array<[FactSource, number]>)
    .sort(([, aRank], [, bRank]) => bRank - aRank)
    .map(([source, rank]) => {
      if (!Number.isInteger(rank)) {
        throw new Error(`SOURCE_PRECEDENCE rank for "${source}" must be an integer, got ${rank}`);
      }
      return sql`when ${source} then ${sql.raw(String(rank))}`;
    });

  return sql<number>`case ${sourceColumn} ${sql.join(branches, sql` `)} else ${sql.raw(String(UNKNOWN_SOURCE_RANK))} end`;
}
