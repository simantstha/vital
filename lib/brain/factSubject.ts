/**
 * Vital Brain — third-party fact subject disclosure
 *
 * A `nodes` row may be about someone other than the user (see
 * `nodes.subject_node_id` in db/schema.ts — nullable; null means "about the
 * user themself"). Every reader that renders facts into a model prompt must
 * make a third-party fact visually distinct from a self-fact, or the model
 * can't tell "my father has diabetes" from "I have diabetes" — this is the
 * single shared place that logic lives, so every reader (context.ts,
 * brief.ts, proactiveHealthWorkerRepository.ts, scripts/proactive-health-
 * worker.ts) stays consistent instead of re-deriving it.
 *
 * This module is deliberately NOT where the hard-constraint self-only filter
 * lives — that's a separate, stricter rule (subject_node_id IS NULL, full
 * stop) applied at lib/brain/context.ts's HARD_CONSTRAINT_TYPES partition and
 * lib/brain/persona.ts's hardConstraintsInjector. This module is for facts
 * that ARE rendered and merely need to disclose whose they are.
 */

export interface SubjectLookupNode {
  id: string;
  label: string;
}

/**
 * id → label lookup, built from the SAME active-node result set a reader
 * already fetched for the user — subject entities (Person, Pet, etc.) are
 * ordinary active `nodes` rows, so no extra query is needed to resolve them.
 */
export function buildSubjectLabelMap(nodes: readonly SubjectLookupNode[]): Map<string, string> {
  return new Map(nodes.map(n => [n.id, n.label]));
}

/**
 * Resolves a subject_node_id to its entity's label, or null for a self-fact.
 * A dangling reference (the entity was resolved/superseded out of the active
 * set, or simply isn't in the caller's lookup) falls back to "someone else"
 * rather than silently rendering as a self-fact — ambiguity here is exactly
 * what this module exists to prevent.
 */
export function resolveSubjectLabel(
  subjectNodeId: string | null | undefined,
  labelsById: ReadonlyMap<string, string>,
): string | null {
  if (!subjectNodeId) return null;
  return labelsById.get(subjectNodeId) ?? 'someone else';
}

/**
 * Appends " (about: X)" to a fact's rendered text when it has a subject — the
 * inline disclosure every fact reader must carry. A no-op for self-facts.
 */
export function withSubjectSuffix(text: string, subjectLabel: string | null): string {
  return subjectLabel ? `${text} (about: ${subjectLabel})` : text;
}

// ── Subject (entity) kind + matching primitives ─────────────────────────────
//
// A fact has exactly one subject: null means "about the user themself" (every
// fact before this feature, and the default going forward); a non-null
// subject_node_id points at another `nodes` row — conventionally type='Person'
// but any kind is valid — that the fact is about. See the safety comment on
// `nodes.subject_node_id` in db/schema.ts: a third-party fact must never be
// indistinguishable from a self-fact anywhere it's rendered.
//
// Lives here (not in tools.ts) because entityDoc.ts also needs these
// primitives and tools.ts needs entityDoc.ts's loadEntityDoc/loadEntityRoster
// (for the read_entity tool) — putting the shared subject vocabulary in
// tools.ts made that a circular import. tools.ts re-exports these names so
// existing importers are unaffected.

export const KNOWN_SUBJECT_KINDS = ['Person', 'Pet', 'Place', 'Organization'] as const;
export type SubjectKind = typeof KNOWN_SUBJECT_KINDS[number];

/**
 * Normalizes free-text subjectKind against the known set, case-insensitively.
 * An unrecognised kind is NEVER rejected — it's logged and stored as the raw
 * string, so an unfamiliar entity kind (e.g. "Colleague") never causes the
 * fact itself to be dropped. (rule (b) in memoryCurationBlock — the coach may
 * name new entities freely but must not invent new *kinds* — is instruction
 * to the model; this is the code-side backstop for when it does anyway.)
 */
export function normalizeSubjectKind(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'Person';
  const match = KNOWN_SUBJECT_KINDS.find(k => k.toLowerCase() === trimmed.toLowerCase());
  if (match) return match;
  console.error(JSON.stringify({ event: 'remember_fact_unknown_subject_kind', subjectKind: trimmed }));
  return trimmed;
}

export interface SubjectCandidate {
  id: string;
  label: string;
  properties?: unknown;
}

/**
 * Case-insensitive match against a candidate's label OR its
 * properties.aliases array — this is what lets "my dad", "Dad", and "Father"
 * all resolve to the same entity instead of fragmenting into duplicates.
 */
export function matchesSubjectName(candidate: SubjectCandidate, name: string): boolean {
  const target = name.trim().toLowerCase();
  if (candidate.label.trim().toLowerCase() === target) return true;
  const aliases = (candidate.properties as { aliases?: unknown } | null | undefined)?.aliases;
  return Array.isArray(aliases) && aliases.some(a => typeof a === 'string' && a.trim().toLowerCase() === target);
}

/** First active candidate matching `name` by label or alias, or null on a miss. */
export function findSubjectMatch(candidates: readonly SubjectCandidate[], name: string): SubjectCandidate | null {
  return candidates.find(c => matchesSubjectName(c, name)) ?? null;
}
