/**
 * GET /api/memory/entities/[id]
 *
 * Returns one entity's document (lib/brain/entityDoc.ts's `loadEntityDoc`)
 * as structured JSON for the iOS "Memory" browser's entity detail screen —
 * the same data `renderEntityDoc` turns into markdown for the coach prompt,
 * just not rendered, so the app can lay it out natively.
 *
 * Response:
 * { id, label, kind, isSelf, facts: [{ type, label, evidence, source, createdAt }] }
 *
 * 404 (JSON error) when `id` doesn't resolve to an entity for this user —
 * loadEntityDoc is already scoped by user_id (see its SAFETY note), so a
 * miss here covers both "no such id" and "id belongs to another user".
 */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { loadEntityDoc } from '@/lib/brain/entityDoc';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const { id } = await context.params;

  const doc = await loadEntityDoc(userId, id);
  if (!doc) {
    return NextResponse.json({ error: 'Entity not found.' }, { status: 404 });
  }

  return NextResponse.json({
    id: doc.id,
    label: doc.label,
    kind: doc.kind,
    isSelf: doc.isSelf,
    facts: doc.facts.map((f) => ({
      type: f.type,
      label: f.label,
      evidence: f.evidence,
      source: f.source,
      createdAt: f.createdAt.toISOString(),
    })),
  });
}
