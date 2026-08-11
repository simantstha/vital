import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/auth';
import {
  createInteraction,
  findInteractionByActionId,
  findRecommendationForUser,
  userPlanItem,
} from '@/lib/coachWorkspaceRepository';

const VALID_ACTIONS = new Set(['accept', 'dismiss', 'complete']);

function serialize(interaction: Awaited<ReturnType<typeof createInteraction>>) {
  return {
    id: interaction.id,
    recommendationId: interaction.recommendation_id,
    actionId: interaction.action_id,
    action: interaction.action,
    planItemId: interaction.plan_item_id,
    createdAt: interaction.created_at.toISOString(),
  };
}

/** Records an explicit Coach Workspace action once, optionally linked to a plan row. */
export async function POST(request: Request): Promise<NextResponse> {
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

  const { actionId, recommendationId, action, planItemId } = body;
  if (typeof actionId !== 'string' || actionId.trim() === '') {
    return NextResponse.json({ error: 'actionId is required.' }, { status: 400 });
  }
  if (typeof recommendationId !== 'string' || recommendationId.trim() === '') {
    return NextResponse.json({ error: 'recommendationId is required.' }, { status: 400 });
  }
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: 'action must be accept, dismiss, or complete.' }, { status: 400 });
  }
  if (planItemId != null && (typeof planItemId !== 'string' || planItemId.trim() === '')) {
    return NextResponse.json({ error: 'planItemId must be a non-empty string when provided.' }, { status: 400 });
  }

  try {
    const existing = await findInteractionByActionId(userId, actionId);
    if (existing) return NextResponse.json({ interaction: serialize(existing) });

    const recommendation = await findRecommendationForUser(userId, recommendationId);
    if (!recommendation) return NextResponse.json({ error: 'Recommendation not found.' }, { status: 404 });

    if (typeof planItemId === 'string' && !await userPlanItem(userId, planItemId)) {
      return NextResponse.json({ error: 'Plan item not found.' }, { status: 404 });
    }

    const interaction = await createInteraction({
      userId,
      recommendationId,
      actionId,
      action: action as 'accept' | 'dismiss' | 'complete',
      planItemId: typeof planItemId === 'string' ? planItemId : null,
    });
    return NextResponse.json({ interaction: serialize(interaction) }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: `Coach Workspace action error: ${String(err)}` }, { status: 500 });
  }
}
