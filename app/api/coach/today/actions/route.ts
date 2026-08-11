import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import { applyCoachAction, type CoachWorkspaceInteractionAction } from '@/lib/coachWorkspaceRepository';
import type { ActionAdjustment } from '@/lib/coachWorkspace';
import {
  COACH_WORKSPACE_DISABLED_RESPONSE,
  COACH_WORKSPACE_DISABLED_STATUS,
  isCoachWorkspaceEnabled,
} from '@/lib/coachWorkspaceFeature';

const VALID_ACTIONS = new Set<CoachWorkspaceInteractionAction>(['accept', 'adjust', 'skip', 'complete', 'open_chat']);

function parseAdjustment(value: unknown): ActionAdjustment | null {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('adjustment must be an object.');
  const adjustment = value as Record<string, unknown>;
  const allowed = new Set(['timeMinutes', 'durationMinutes', 'intensity']);
  if (Object.keys(adjustment).some(key => !allowed.has(key))) throw new Error('adjustment contains an unsupported field.');
  if (Object.keys(adjustment).length === 0) throw new Error('adjustment must change at least one field.');
  if (Object.values(adjustment).every(entry => entry == null)) throw new Error('adjustment must change at least one field.');
  if (adjustment.timeMinutes != null && typeof adjustment.timeMinutes !== 'number') throw new Error('adjustment.timeMinutes must be a number.');
  if (adjustment.durationMinutes != null && typeof adjustment.durationMinutes !== 'number') throw new Error('adjustment.durationMinutes must be a number.');
  if (adjustment.intensity != null && typeof adjustment.intensity !== 'string') throw new Error('adjustment.intensity must be a string.');
  return adjustment as ActionAdjustment;
}

function serialize(interaction: Awaited<ReturnType<typeof applyCoachAction>>['interaction']) {
  return {
    id: interaction.id,
    recommendationId: interaction.recommendation_id,
    actionId: interaction.action_id,
    action: interaction.action,
    planItemId: interaction.plan_item_id,
    createdAt: interaction.created_at.toISOString(),
  };
}

/** Records one atomic Coach Workspace interaction. Plan rows are server-authored. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isCoachWorkspaceEnabled()) {
    return NextResponse.json(COACH_WORKSPACE_DISABLED_RESPONSE, { status: COACH_WORKSPACE_DISABLED_STATUS });
  }

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { actionId, recommendationId, action } = body;
  if (typeof actionId !== 'string' || actionId.trim() === '') {
    return NextResponse.json({ error: 'actionId is required.' }, { status: 400 });
  }
  if (typeof recommendationId !== 'string' || recommendationId.trim() === '') {
    return NextResponse.json({ error: 'recommendationId is required.' }, { status: 400 });
  }
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action as CoachWorkspaceInteractionAction)) {
    return NextResponse.json({ error: 'action must be accept, adjust, skip, complete, or open_chat.' }, { status: 400 });
  }

  let adjustment: ActionAdjustment | null;
  try {
    adjustment = parseAdjustment(body.adjustment);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
  if (action === 'adjust' && !adjustment) {
    return NextResponse.json({ error: 'adjustment is required for adjust.' }, { status: 400 });
  }
  if (action !== 'adjust' && adjustment) {
    return NextResponse.json({ error: 'adjustment is only valid for adjust.' }, { status: 400 });
  }

  try {
    const result = await applyCoachAction({
      userId,
      recommendationId,
      actionId,
      action: action as CoachWorkspaceInteractionAction,
      adjustment: adjustment ?? undefined,
    });
    return NextResponse.json({ interaction: serialize(result.interaction) }, { status: result.created ? 201 : 200 });
  } catch (err) {
    const message = String(err);
    const status = /not found/i.test(message) ? 404 : /invalid|must be|not allowed|required/i.test(message) ? 400 : 409;
    return NextResponse.json({ error: `Coach Workspace action error: ${message}` }, { status });
  }
}
