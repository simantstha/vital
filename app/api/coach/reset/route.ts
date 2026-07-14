/**
 * POST /api/coach/reset
 *
 * Manual "New chat" action for the Coach tab. Stamps users.chat_reset_at =
 * now(), which becomes a hard lower bound for both coach restore
 * (lib/specialists/restoration.ts) and LLM prompt context
 * (lib/brain/context.ts assembleContext) — see lib/brain/conversationWindow.ts.
 * Nothing is deleted; older messages simply fall outside the conversation
 * window from this point forward.
 *
 * Also closes any open specialist session (proposed/active/return_proposed)
 * via SpecialistSessionService.disableOpen, matching how /api/coach already
 * tears down specialist state when the feature flag is off.
 *
 * NOTE — inactivity resets never touch specialist sessions (this route is
 * the only writer; the automatic 4h gap logic in conversationWindow.ts is a
 * pure read-path filter and never mutates specialist_sessions). Accepted
 * edge case: if a user abandons an active specialist consultation for more
 * than 4h and then keeps chatting, the conversation resumes under the
 * specialist persona but with a transcript that excludes the pre-gap
 * messages — the specialist session itself is untouched until the user
 * explicitly starts a new chat (this route) or completes/declines it.
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { DrizzleSpecialistSessionRepository } from '@/lib/specialists/sessionRepository';
import { SpecialistSessionService } from '@/lib/specialists/sessions';

export const dynamic = 'force-dynamic';

const sessions = new DrizzleSpecialistSessionRepository();
const sessionService = new SpecialistSessionService(sessions);

export async function POST(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  await Promise.all([
    db.update(schema.users)
      .set({ chat_reset_at: new Date() })
      .where(eq(schema.users.id, userId)),
    sessionService.disableOpen(userId),
  ]);

  return NextResponse.json({ ok: true });
}
