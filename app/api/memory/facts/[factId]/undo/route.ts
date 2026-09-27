/**
 * POST /api/memory/facts/[factId]/undo
 *
 * Reverts a "saved" memory op from the chat-activity contract (§2): the
 * `nodes` row `remember_fact` created (weight 0.6, status 'active'). Reuses
 * `resolveFact`/`drizzleNodeResolutionStore` — the exact same status flip
 * `resolve_fact` performs — rather than a new DB semantic, so this is never
 * a hard delete and is itself reversible by the same means as any other
 * resolved fact.
 *
 * `factId` is a `nodes.id` (the id `remember_fact`'s `saved` op reports —
 * see lib/brain/toolActivity.ts's extractMemoryOp), NOT a `pending_facts.id`
 * — a `propose_fact` proposal's `factId` is undone via the existing
 * pending-facts confirm/dismiss API instead (see §2's note that a `saved`
 * op with no stable undo target omits `factId` entirely, e.g. write_memory/
 * append_observation).
 *
 * Response: 200 { ok: true }.
 * 404: unknown id, already-resolved fact, or another user's fact —
 * `resolveFact`'s lookup is scoped by (userId, id, status: 'active'), so a
 * miss covers all three indistinguishably (never leaks which case it was).
 * 401: no/invalid auth.
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { isUuid } from '@/lib/brain/uuid';
import { drizzleNodeResolutionStore, resolveFact } from '@/lib/brain/tools';

export const dynamic = 'force-dynamic';

export async function POST(
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
    return NextResponse.json({ error: `No fact found with id "${factId}".` }, { status: 404 });
  }

  const result = await resolveFact(
    drizzleNodeResolutionStore,
    { id: factId, evidence: 'Undone from chat.' },
    userId,
  );

  if (!result.ok) {
    return NextResponse.json({ error: `No fact found with id "${factId}".` }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
