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
