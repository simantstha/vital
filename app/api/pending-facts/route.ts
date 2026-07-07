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
 *   }]
 * }
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, desc } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';

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

  const items = rows.map(r => ({
    id:           r.id,
    proposedNode: r.proposed_node ?? null,
    evidence:     r.evidence,
    salience:     r.salience,
    createdAt:    r.created_at.toISOString(),
  }));

  return NextResponse.json({ items });
}
