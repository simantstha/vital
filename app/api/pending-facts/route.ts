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
import { getOrCreateDevUser } from '@/lib/brain/user';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  let userId: string;
  try {
    userId = await getOrCreateDevUser();
  } catch (err) {
    return NextResponse.json({ error: `DB error resolving user: ${String(err)}` }, { status: 500 });
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
