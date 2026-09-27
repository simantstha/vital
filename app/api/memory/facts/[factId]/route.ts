/**
 * PATCH /api/memory/facts/[factId]
 *
 * Edits a fact's label (Memory contract §2). Never an in-place overwrite:
 * the old node is superseded (status='superseded', superseded_by=<new id>)
 * and a new active node is inserted with the edited label — same
 * supersede/never-mutate semantics `supersedeFact`
 * (lib/brain/tools.ts) already formalizes, reused here rather than
 * re-implemented.
 *
 * Body: { "label": string } — trimmed, must be 1–140 chars (400 otherwise,
 * see lib/brain/factPresentation.ts's validateFactLabel).
 *
 * The fact must be active, belong to the caller, and must not be an entity
 * node (a node referenced as someone else's subject — see
 * lib/brain/entityDoc.ts's loadEntityRoster, the same "what is an entity"
 * check GET /api/memory already applies). Any of those failing — unknown id,
 * another user's fact, a resolved/superseded fact, or an entity node — is a
 * 404, indistinguishable from each other (same rationale as the undo route:
 * never leak which case it was).
 *
 * Response: 200 { ok: true, fact: { id, type, label, isConstraint,
 * recordedAt, origin, group } } — `fact` is the NEW node.
 * 401: no/invalid auth.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { isUuid } from '@/lib/brain/uuid';
import { loadEntityRoster } from '@/lib/brain/entityDoc';
import { HARD_CONSTRAINT_TYPES } from '@/lib/brain/context';
import { drizzleFactSupersessionStore, supersedeFact } from '@/lib/brain/tools';
import { factOriginFromSource, factGroupFromType, validateFactLabel } from '@/lib/brain/factPresentation';
import { localDayKey, pickTimeZone } from '@/lib/localDay';

export const dynamic = 'force-dynamic';

function notFound(factId: string): NextResponse {
  return NextResponse.json({ error: `No fact found with id "${factId}".` }, { status: 404 });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ factId: string }> },
): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const { factId } = await context.params;

  if (!isUuid(factId)) {
    return notFound(factId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { label: rawLabel } = (body ?? {}) as { label?: unknown };
  const validated = validateFactLabel(rawLabel);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  // An entity node (e.g. the "Father" Person record itself) is a subject,
  // not a fact about the user — never editable through this route. Same
  // roster GET /api/memory already computes "what is an entity" from.
  const entities = await loadEntityRoster(userId);
  if (entities.some((e) => e.id === factId)) {
    return notFound(factId);
  }

  const result = await supersedeFact(drizzleFactSupersessionStore, { id: factId, label: validated.label }, userId);
  if (!result.ok) {
    return notFound(factId);
  }

  const [usersRow] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const tz = pickTimeZone(null, usersRow?.timezone) ?? 'UTC';

  const { fact } = result;
  return NextResponse.json({
    ok: true,
    fact: {
      id: fact.id,
      type: fact.type,
      label: fact.label,
      isConstraint: HARD_CONSTRAINT_TYPES.has(fact.type),
      recordedAt: localDayKey(fact.created_at, tz),
      origin: factOriginFromSource('confirmed'),
      group: factGroupFromType(fact.type),
    },
  });
}
