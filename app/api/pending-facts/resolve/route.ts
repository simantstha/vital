/**
 * POST /api/pending-facts/resolve
 *
 * Confirms or rejects a pending fact.
 * On confirm: promotes the proposed_node into the nodes ontology (weight 0.9,
 * source 'confirmed') and marks the pending_fact as 'confirmed'.
 * On reject: marks the pending_fact as 'rejected' (retained for audit).
 *
 * Request body (JSON):
 *   { id: string, action: "confirm" | "reject" }
 *
 * Response:
 *   { ok: true, id: string, action: string, nodeId?: string }
 *
 * Mirrors the confirm_fact executor in lib/brain/tools.ts so the HTTP surface
 * and the coach tool stay in sync.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and } from 'drizzle-orm';
import { getOrCreateDevUser } from '@/lib/brain/user';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  // ── Parse body ────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { id, action } =
    (body ?? {}) as { id?: unknown; action?: unknown };

  if (typeof id !== 'string' || !id.trim()) {
    return NextResponse.json({ error: '"id" is required.' }, { status: 400 });
  }
  if (action !== 'confirm' && action !== 'reject') {
    return NextResponse.json({ error: '"action" must be "confirm" or "reject".' }, { status: 400 });
  }

  // ── Resolve user ──────────────────────────────────────────────────────────
  let userId: string;
  try {
    userId = await getOrCreateDevUser();
  } catch (err) {
    return NextResponse.json({ error: `DB error resolving user: ${String(err)}` }, { status: 500 });
  }

  // ── Update pending_fact ───────────────────────────────────────────────────
  const status     = action === 'confirm' ? 'confirmed' : 'rejected';
  const resolvedAt = new Date();

  const [updated] = await db
    .update(schema.pending_facts)
    .set({ status, resolved_at: resolvedAt })
    .where(
      and(
        eq(schema.pending_facts.id, id),
        eq(schema.pending_facts.user_id, userId),     // scope to this user
        eq(schema.pending_facts.status, 'pending'),   // idempotency guard
      ),
    )
    .returning({
      id:            schema.pending_facts.id,
      proposed_node: schema.pending_facts.proposed_node,
      proposed_edge: schema.pending_facts.proposed_edge,
    });

  if (!updated) {
    return NextResponse.json(
      { error: `No pending fact found with id "${id}" (already resolved or not yours).` },
      { status: 404 },
    );
  }

  // ── On confirm: promote proposed_node → nodes ─────────────────────────────
  let promotedNodeId: string | undefined;

  if (action === 'confirm' && updated.proposed_node) {
    const proposed = updated.proposed_node as Record<string, unknown>;
    const nodeType  = typeof proposed.type  === 'string' ? proposed.type  : 'Habit';
    const nodeLabel = typeof proposed.label === 'string' ? proposed.label : '';
    const nodeProps = (proposed.properties != null && typeof proposed.properties === 'object')
      ? (proposed.properties as Record<string, unknown>)
      : null;

    if (nodeLabel) {
      const [inserted] = await db
        .insert(schema.nodes)
        .values({
          user_id:    userId,
          type:       nodeType,
          label:      nodeLabel,
          properties: nodeProps,
          source:     'confirmed',
          weight:     0.9,
        })
        .returning({ id: schema.nodes.id });

      promotedNodeId = inserted?.id;
    }
  }

  return NextResponse.json({
    ok:     true,
    id:     updated.id,
    action,
    status,
    ...(promotedNodeId != null && { nodeId: promotedNodeId }),
  });
}
