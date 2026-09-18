/**
 * GET /api/memory
 *
 * Backs the iOS "Memory" browser: the user's own active facts plus the
 * roster of entities (people, pets, etc.) with facts recorded about them.
 * Deliberately structured JSON, not `renderEntityDoc`'s markdown — the app
 * renders natively, but both surfaces stay driven by the same loaders
 * (lib/brain/entityDoc.ts) so there is exactly one notion of "active fact".
 *
 * Response:
 * {
 *   self: {
 *     factCount: number,
 *     facts: [{ id, type, label, isConstraint: boolean }]
 *   },
 *   entities: [{ id, label, kind, factCount }]
 * }
 *
 * SAFETY:
 *   - every query is scoped by user_id — an unscoped ontology query
 *     previously leaked another user's health data in this project.
 *   - `self.facts` excludes both third-party facts (subject_node_id set —
 *     filtered directly in SQL) and entity nodes themselves (a node
 *     referenced as someone's subject is a subject, not a fact about the
 *     user — filtered against loadEntityRoster's result, the same "what is
 *     an entity" definition entityDoc.ts and context.ts already use).
 */

import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { loadEntityRoster } from '@/lib/brain/entityDoc';
import { HARD_CONSTRAINT_TYPES } from '@/lib/brain/context';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  // entities comes straight from the existing roster loader — no new
  // entity-resolution logic here.
  const entities = await loadEntityRoster(userId);
  const entityIds = new Set(entities.map((e) => e.id));

  // Candidate self-facts: active, non-superseded, no subject (i.e. not
  // recorded about a third party). This still includes entity nodes
  // themselves (e.g. the "Father" Person node also has subject_node_id
  // NULL — it's the entity record, not a fact about it), so entityIds is
  // subtracted below.
  const selfCandidates = await db
    .select({
      id: schema.nodes.id,
      type: schema.nodes.type,
      label: schema.nodes.label,
    })
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.user_id, userId),
        eq(schema.nodes.status, 'active'),
        isNull(schema.nodes.superseded_by),
        isNull(schema.nodes.subject_node_id),
      ),
    );

  const facts = selfCandidates
    .filter((n) => !entityIds.has(n.id))
    .map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      isConstraint: HARD_CONSTRAINT_TYPES.has(n.type),
    }));

  return NextResponse.json({
    self: {
      factCount: facts.length,
      facts,
    },
    entities: entities.map((e) => ({
      id: e.id,
      label: e.label,
      kind: e.kind,
      factCount: e.factCount,
    })),
  });
}
