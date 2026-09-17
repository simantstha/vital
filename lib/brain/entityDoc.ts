/**
 * Vital Brain — entity documents
 *
 * Stage 2 (see lib/brain/factSubject.ts, db/schema.ts's nodes.subject_node_id)
 * gave a fact exactly one subject: null means "about the user themself", a
 * non-null value points at another `nodes` row (conventionally type='Person',
 * but any KNOWN_SUBJECT_KIND is valid) that the fact is actually about. This
 * module renders one such subject entity — e.g. "Father" — and every active
 * fact recorded about them as a single document, so the coach can pull the
 * full picture on demand via the `read_entity` tool (lib/brain/tools.ts)
 * instead of only seeing the scattered inline "(about: Father)" disclosure
 * that context.ts's prompt already carries.
 *
 * Split deliberately in two:
 *   - renderEntityDoc  — pure formatting, testable without a database.
 *   - loadEntityDoc    — resolves a name/alias/id to an entity + its facts.
 *   - buildEntityRoster/loadEntityRoster — the compact "which entities exist"
 *     list consumed by context.ts's prompt roster and by read_entity's
 *     miss path (so the model can self-correct instead of inventing a name).
 *
 * Reuses factSubject.ts's findSubjectMatch/KNOWN_SUBJECT_KINDS for name/alias
 * resolution rather than reimplementing it — that logic (case-insensitive
 * label-or-alias match) must stay in exactly one place. Deliberately imported
 * from factSubject.ts and not tools.ts: tools.ts's read_entity tool imports
 * this module (dynamically) to call loadEntityDoc/loadEntityRoster, so a
 * static import back from here to tools.ts would be circular.
 *
 * SAFETY (matches every other nodes reader — see the audit referenced in
 * db/schema.ts's nodes.subject_node_id comment):
 *   - every query is scoped by user_id — an unscoped ontology query
 *     previously leaked another user's health data in this project.
 *   - every query filters status = 'active' AND superseded_by IS NULL.
 */

import { and, desc, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { findSubjectMatch, type SubjectCandidate } from './factSubject';
import { sourcePrecedenceSql } from './memoryTiers';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntityDocFact {
  type: string;
  label: string;
  evidence: string;
  source: string;
  createdAt: Date;
}

export interface EntityDocData {
  id: string;
  label: string;
  kind: string;
  isSelf: boolean;
  facts: EntityDocFact[];
}

export interface EntityRosterItem {
  id: string;
  label: string;
  kind: string;
  factCount: number;
}

/** The minimal node shape buildEntityRoster needs — matches OntologyNode's fields. */
export interface EntityRosterNode {
  id: string;
  label: string;
  type: string;
  subject_node_id: string | null;
}

// ── Rendering (pure) ─────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  confirmed: 'confirmed',
  coach: 'from chat',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Renders an entity document. Groups facts by `type` (preserving first-seen
 * order), shows evidence verbatim (the only provenance that exists — never
 * paraphrase it), and omits the third-party disclaimer entirely when
 * `isSelf` is true.
 */
export function renderEntityDoc(doc: EntityDocData): string {
  const lines: string[] = [];

  lines.push(`# ${doc.label}`);
  lines.push(`${doc.kind} · ${doc.facts.length} fact${doc.facts.length === 1 ? '' : 's'}`);

  if (!doc.isSelf) {
    lines.push('');
    lines.push(
      `These facts are recorded about ${doc.label}, not about the user. They are not ` +
      `the user's own health constraints. Use them only where they bear on the ` +
      `user's own care (e.g. heritable risk).`,
    );
  }

  const byType = new Map<string, EntityDocFact[]>();
  for (const fact of doc.facts) {
    const bucket = byType.get(fact.type);
    if (bucket) bucket.push(fact);
    else byType.set(fact.type, [fact]);
  }

  for (const [type, facts] of byType) {
    lines.push('');
    lines.push(`## ${type}`);
    for (const fact of facts) {
      lines.push(`- ${fact.label}`);
      lines.push(`  evidence: "${fact.evidence}"`);
      lines.push(`  source: ${sourceLabel(fact.source)} · recorded ${formatDate(fact.createdAt)}`);
    }
  }

  return lines.join('\n');
}

// ── Roster (pure) ─────────────────────────────────────────────────────────────

/**
 * Compact "which entities exist" roster, derived purely from an already-
 * fetched active node set — no extra query needed when the caller (e.g.
 * context.ts) already has one in hand.
 *
 * An entity is any node referenced as a subject — i.e. any node whose id
 * appears as some other node's non-null subject_node_id — NOT any node whose
 * `type` happens to be one of KNOWN_SUBJECT_KINDS. That filter-by-type
 * approach was the bug fetchEntityCandidates below already avoids:
 * normalizeSubjectKind (tools.ts) deliberately preserves unrecognised kinds
 * (e.g. "Colleague") so a fact is never dropped, so a type-based filter here
 * would silently drop such an entity from the roster while read_entity could
 * still resolve and render it — an inconsistent, hard-to-debug gap. Deriving
 * from subject_node_id references instead keeps this function's notion of
 * "entity" identical to fetchEntityCandidates's SQL.
 */
export function buildEntityRoster(nodes: readonly EntityRosterNode[]): EntityRosterItem[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const roster: EntityRosterItem[] = [];
  const seen = new Set<string>();

  for (const n of nodes) {
    const subjectId = n.subject_node_id;
    if (!subjectId || seen.has(subjectId)) continue;
    seen.add(subjectId);

    const entity = byId.get(subjectId);
    if (!entity) continue; // dangling reference — subject not in this node set

    roster.push({
      id: entity.id,
      label: entity.label,
      kind: entity.type,
      factCount: nodes.filter(m => m.subject_node_id === subjectId).length,
    });
  }

  return roster;
}

// ── Loading (DB-backed) ────────────────────────────────────────────────────────

interface EntityCandidate extends SubjectCandidate {
  type: string;
}

function extractEvidence(properties: unknown): string {
  const evidence = (properties as { evidence?: unknown } | null | undefined)?.evidence;
  return typeof evidence === 'string' ? evidence : '';
}

async function fetchEntityCandidates(userId: string): Promise<EntityCandidate[]> {
  // An entity is any node that is referenced as a subject by at least one other
  // node. This allows unrecognised kinds (e.g. "Colleague") to be queryable, even
  // if the normalizeSubjectKind backstop stores them (see tools.ts's comment on
  // normalizeSubjectKind for the rationale: preserve unknown kinds so the model
  // can name new entities freely without the fact being dropped).
  const subjectNodeIds = db
    .selectDistinct({ id: schema.nodes.subject_node_id })
    .from(schema.nodes)
    .where(and(
      eq(schema.nodes.user_id, userId),
      eq(schema.nodes.status, 'active'),
      isNull(schema.nodes.superseded_by),
      isNotNull(schema.nodes.subject_node_id),
    ));

  return db
    .select({
      id:         schema.nodes.id,
      label:      schema.nodes.label,
      type:       schema.nodes.type,
      properties: schema.nodes.properties,
    })
    .from(schema.nodes)
    .where(and(
      eq(schema.nodes.user_id, userId),
      eq(schema.nodes.status, 'active'),
      isNull(schema.nodes.superseded_by),
      inArray(schema.nodes.id, subjectNodeIds),
    ));
}

/**
 * Resolves `nameOrId` to a subject entity (by id first, else by label/alias
 * via findSubjectMatch — same matching tools.ts's remember_fact subject
 * resolution uses) and returns it plus every active, non-superseded fact
 * recorded about it. Returns null on a miss — never throws, so a caller (the
 * read_entity tool) can render a self-correcting message instead.
 */
export async function loadEntityDoc(userId: string, nameOrId: string): Promise<EntityDocData | null> {
  const query = nameOrId.trim();
  if (!query) return null;

  const candidates = await fetchEntityCandidates(userId);
  const match = candidates.find(c => c.id === query) ?? findSubjectMatch(candidates, query);
  if (!match) return null;

  // Re-find in candidates to get the full EntityCandidate with type field
  // (findSubjectMatch returns SubjectCandidate which omits type)
  const entity = candidates.find(c => c.id === match.id);
  if (!entity) return null;

  const factRows = await db
    .select({
      type:       schema.nodes.type,
      label:      schema.nodes.label,
      properties: schema.nodes.properties,
      source:     schema.nodes.source,
      created_at: schema.nodes.created_at,
    })
    .from(schema.nodes)
    .where(and(
      eq(schema.nodes.user_id, userId),
      eq(schema.nodes.subject_node_id, entity.id),
      eq(schema.nodes.status, 'active'),
      isNull(schema.nodes.superseded_by),
    ))
    .orderBy(desc(sourcePrecedenceSql(schema.nodes.source)), desc(schema.nodes.weight));

  const facts: EntityDocFact[] = factRows.map(r => ({
    type:      r.type,
    label:     r.label,
    evidence:  extractEvidence(r.properties),
    source:    r.source,
    createdAt: r.created_at,
  }));

  return { id: entity.id, label: entity.label, kind: entity.type, isSelf: false, facts };
}

/** The roster for a user, fetched fresh — used by read_entity's miss path. */
export async function loadEntityRoster(userId: string): Promise<EntityRosterItem[]> {
  const nodes = await db
    .select({
      id:               schema.nodes.id,
      label:            schema.nodes.label,
      type:             schema.nodes.type,
      subject_node_id:  schema.nodes.subject_node_id,
    })
    .from(schema.nodes)
    .where(and(
      eq(schema.nodes.user_id, userId),
      eq(schema.nodes.status, 'active'),
      isNull(schema.nodes.superseded_by),
    ));

  return buildEntityRoster(nodes);
}
