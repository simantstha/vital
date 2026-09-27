/**
 * Vital Brain — fact presentation helpers (Memory contract §1)
 *
 * Pure, DB-free mappings the iOS "Memory" browser (GET /api/memory,
 * GET /api/pending-facts) needs to render facts without re-deriving domain
 * knowledge on the client. Kept in one small module, per the memory
 * contract, so both the origin/group mappings and their edge cases (unknown
 * source, unknown type, unset label) live and are tested in exactly one
 * place.
 */

// ── origin (from nodes.source) ──────────────────────────────────────────────

export type FactOrigin = 'told' | 'noticed' | 'confirmed' | 'onboarding';

/**
 * `nodes.source` → the iOS-facing `origin` enum.
 *
 * The only `nodes.source` values actually written today (see
 * lib/brain/memoryTiers.ts's header comment) are:
 *   - 'coach'     — lib/brain/tools.ts's remember_fact: "Use when the user
 *                   reveals an allergy, condition, ... worth remembering" —
 *                   i.e. the user told the coach directly in chat. -> 'told'
 *   - 'confirmed' — app/api/pending-facts/resolve (a proposed fact the user
 *                   explicitly approved), lib/brain/healthConstraints.ts's
 *                   ensureHealthConstraintNodes (onboarding's declared
 *                   injuries/conditions/medications, promoted with the exact
 *                   same source/weight as a confirmed pending fact — see that
 *                   file's header comment), AND PATCH /api/memory/facts/
 *                   [factId]'s supersedeFact (lib/brain/tools.ts — editing a
 *                   fact is "the user is the authority on this text" too).
 *                   All three land here as 'confirmed'; nodes.source has no
 *                   signal that distinguishes "confirmed a coach proposal"
 *                   from "declared at onboarding", so no source value maps to
 *                   'onboarding' today even though the iOS-facing enum
 *                   reserves it for a future distinguishing signal (e.g. a
 *                   properties flag). -> 'confirmed'
 *   - 'digest'    — reserved for a not-yet-written future digest pass that
 *                   corroborates facts across turns without the user
 *                   confirming each one — the closest existing fit for
 *                   "the coach noticed this on its own". -> 'noticed'
 *
 * Anything else (a future/unexpected source) falls back to 'told', per the
 * memory contract — the safest default is "the user said this", never a
 * silent 'noticed'/'confirmed' upgrade of an unrecognised source.
 */
const SOURCE_TO_ORIGIN: Record<string, FactOrigin> = {
  coach: 'told',
  confirmed: 'confirmed',
  digest: 'noticed',
};

export function factOriginFromSource(source: string): FactOrigin {
  return SOURCE_TO_ORIGIN[source] ?? 'told';
}

// ── group (from nodes.type) ─────────────────────────────────────────────────

export type FactGroup = 'health' | 'goals' | 'routines' | 'food' | 'other';

/**
 * `nodes.type` → the iOS-facing `group` enum, for the "Health / Goals /
 * Routines & preferences / Food / Other" sectioning (contract §4).
 *
 * The full closed set of fact node types the coach ever creates (see the
 * `nodeType` enum documented on propose_fact/remember_fact in
 * lib/brain/tools.ts) is: Condition, Medication, Allergy, Intolerance, Goal,
 * Habit, FoodPreference, Cuisine, PantryItem, LabMarker, Injury,
 * FamilyHistory. There is no schedule/routine node type beyond Habit in the
 * codebase today (grepped for Schedule/Routine-shaped types — none exist), so
 * 'routines' is Habit alone. Entity node types (Person/Pet/Place/
 * Organization/...) never reach this function — GET /api/memory and the
 * PATCH route both exclude entity nodes before mapping a group — but any type
 * this function has never seen (an entity kind, or a genuinely new fact type)
 * safely falls back to 'other'.
 */
const TYPE_TO_GROUP: Record<string, FactGroup> = {
  Condition: 'health',
  Medication: 'health',
  Allergy: 'health',
  Intolerance: 'health',
  Injury: 'health',
  LabMarker: 'health',
  FamilyHistory: 'health',

  Goal: 'goals',

  Habit: 'routines',

  FoodPreference: 'food',
  Cuisine: 'food',
  PantryItem: 'food',
};

export function factGroupFromType(type: string): FactGroup {
  return TYPE_TO_GROUP[type] ?? 'other';
}

// ── label validation (PATCH /api/memory/facts/{factId}) ────────────────────

export const FACT_LABEL_MAX_LENGTH = 140;

export type FactLabelValidation =
  | { ok: true; label: string }
  | { ok: false; error: string };

/**
 * Trims `raw` and enforces the 1–140 char bound the memory contract's PATCH
 * route requires. Pure and reused as-is by the route (which turns `ok: false`
 * into a 400) so the bound is checked in exactly one place.
 */
export function validateFactLabel(raw: unknown): FactLabelValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: '"label" is required.' };
  }
  const label = raw.trim();
  if (label.length < 1) {
    return { ok: false, error: '"label" must not be empty.' };
  }
  if (label.length > FACT_LABEL_MAX_LENGTH) {
    return { ok: false, error: `"label" must be at most ${FACT_LABEL_MAX_LENGTH} characters.` };
  }
  return { ok: true, label };
}

// ── pending-fact "reason" (GET /api/pending-facts) ──────────────────────────

export const PENDING_FACT_REASON_MAX_LENGTH = 140;

/**
 * `pending_facts.evidence` (NOT NULL text — see db/schema.ts) → an optional,
 * length-capped `reason` for the "Did I get this right?" card (contract §4).
 * Blank evidence (whitespace-only) maps to undefined so the client's "Noticed
 * from your data" fallback kicks in instead of showing an empty string.
 */
export function reasonFromEvidence(evidence: string): string | undefined {
  const trimmed = evidence.trim();
  if (!trimmed) return undefined;
  return trimmed.length > PENDING_FACT_REASON_MAX_LENGTH
    ? trimmed.slice(0, PENDING_FACT_REASON_MAX_LENGTH)
    : trimmed;
}
