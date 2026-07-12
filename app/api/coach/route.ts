/**
 * GET/POST /api/coach
 *
 * POST preserves the existing message request and SSE event contract. When
 * specialists are enabled it also accepts explicit specialist-card actions
 * and streams handoff_card/persona_changed events.
 *
 * GET restores the latest 50 messages plus authoritative specialist UI state.
 * It remains unavailable while the specialist feature flag is off.
 */

import { db } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { runCoach, runSpecialistAction } from '@/lib/brain/coach';
import { createCoachHttpHandlers } from '@/lib/specialists/httpHandlers';
import { isSpecialistsEnabled } from '@/lib/specialists/orchestration';
import { specialistRegistry } from '@/lib/specialists/registry';
import {
  DrizzleCoachHistoryRepository,
  loadCoachRestoration,
} from '@/lib/specialists/restoration';
import { DrizzleSpecialistSessionRepository } from '@/lib/specialists/sessionRepository';

export const dynamic = 'force-dynamic';

const history = new DrizzleCoachHistoryRepository(db);
const sessions = new DrizzleSpecialistSessionRepository();

const handlers = createCoachHttpHandlers({
  enabled: isSpecialistsEnabled,
  authenticate: getUserIdFromRequest,
  runCoach,
  runAction: runSpecialistAction,
  restore: (userId) => loadCoachRestoration(userId, {
    history,
    sessions,
    manifests: specialistRegistry,
  }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
