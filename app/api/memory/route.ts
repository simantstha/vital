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
 *     facts: [{
 *       id, type, label, isConstraint: boolean,
 *       recordedAt: "YYYY-MM-DD" (created_at as a day in the user's tz),
 *       origin: "told" | "noticed" | "confirmed" | "onboarding",
 *       group: "health" | "goals" | "routines" | "food" | "other",
 *     }]
 *   },
 *   entities: [{ id, label, kind, factCount }]
 * }
 *
 * recordedAt/origin/group are additive (Memory contract §1) — old-style
 * consumers reading only id/type/label/isConstraint are unaffected.
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
import { factOriginFromSource, factGroupFromType } from '@/lib/brain/factPresentation';
import { localDayKey, pickTimeZone } from '@/lib/localDay';

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

  // The user's stored timezone, for recordedAt's local-day bucketing (same
  // pickTimeZone/localDayKey pattern as lib/brain/context.ts and
  // app/api/today/route.ts — a fresh ?tz= isn't accepted here since this is
  // a read-only browse endpoint, not one that persists the tz like /today).
  const [usersRow] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const tz = pickTimeZone(null, usersRow?.timezone) ?? 'UTC';

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
      source: schema.nodes.source,
      created_at: schema.nodes.created_at,
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
      recordedAt: localDayKey(n.created_at, tz),
      origin: factOriginFromSource(n.source),
      group: factGroupFromType(n.type),
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
