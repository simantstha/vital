/**
 * GET /api/pending-facts
 *
 * Returns all pending_facts with status='pending' for the dev user.
 *
 * Response:
 * {
 *   items: [{
 *     id:           string,
 *     proposedNode: { type: string, label: string, properties?: object } | null,
 *     evidence:     string,
 *     salience:     number,
 *     createdAt:    string (ISO 8601),
 *     reason?:      string (≤140 chars),
 *   }]
 * }
 *
 * `reason` (Memory contract §1) is additive: `pending_facts.evidence` is a
 * NOT NULL text column (db/schema.ts) already returned as `evidence` above,
 * so it's re-surfaced here — trimmed and capped at 140 chars, omitted when
 * blank — for the iOS "Did I get this right?" card (contract §4), which
 * shows `reason` when present and falls back to "Noticed from your data"
 * otherwise. See lib/brain/factPresentation.ts's reasonFromEvidence.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, desc } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { reasonFromEvidence } from '@/lib/brain/factPresentation';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(schema.pending_facts)
    .where(
      and(
        eq(schema.pending_facts.user_id, userId),
        eq(schema.pending_facts.status, 'pending'),
      ),
    )
    .orderBy(desc(schema.pending_facts.created_at));

  const items = rows.map(r => {
    const reason = reasonFromEvidence(r.evidence);
    return {
      id:           r.id,
      proposedNode: r.proposed_node ?? null,
      evidence:     r.evidence,
      salience:     r.salience,
      createdAt:    r.created_at.toISOString(),
      ...(reason !== undefined && { reason }),
    };
  });

  return NextResponse.json({ items });
}
