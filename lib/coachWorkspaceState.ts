import { applyActionAdjustment, type ActionAdjustment, type CoachWorkspaceAction } from '@/lib/coachWorkspace';

export type CoachWorkspaceHydrationStatus = 'ready' | 'calibration' | 'planned' | 'skipped' | 'completed';
export type HydrationAction = 'accept' | 'adjust' | 'skip' | 'complete' | 'open_chat';

export interface HydrationInteraction {
  action: HydrationAction;
  adjustment: unknown;
  planItemId: string | null;
  createdAt: Date;
  materialSignature: string | null;
}

export interface HydrationPlanItem {
  id: string;
  userId: string;
  localDay: string;
  status: string;
  kind: string;
}

export interface CoachWorkspaceState {
  status: CoachWorkspaceHydrationStatus;
  planItemId: string | null;
  effectiveAction: CoachWorkspaceAction;
}

const MATERIAL_SIGNATURE_KEY = '__materialSignature';

/** Stores recommendation context alongside the existing adjustment JSONB. */
export function adjustmentWithMaterialSignature(
  adjustment: ActionAdjustment | undefined,
  materialSignature: string,
): Record<string, unknown> {
  return { ...(adjustment ?? {}), [MATERIAL_SIGNATURE_KEY]: materialSignature };
}

/** Reads context written by adjustmentWithMaterialSignature; legacy rows return null. */
export function materialSignatureFromAdjustment(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const signature = (value as Record<string, unknown>)[MATERIAL_SIGNATURE_KEY];
  return typeof signature === 'string' && signature.length > 0 ? signature : null;
}

export function latestCurrentOccurrencePlanId(
  rows: Array<{ adjustment: unknown; planItemId: string | null }>,
  materialSignature: string,
): string | null {
  for (const row of rows) {
    const signature = materialSignatureFromAdjustment(row.adjustment);
    if (signature !== materialSignature) return null;
    if (row.planItemId) return row.planItemId;
  }
  return null;
}

function currentOccurrenceInteractions(
  interactions: HydrationInteraction[],
  materialSignature: string,
): HydrationInteraction[] {
  const hasPersistedContext = interactions.some(interaction => interaction.materialSignature != null);
  if (!hasPersistedContext) return interactions;

  const current: HydrationInteraction[] = [];
  for (const interaction of interactions) {
    if (interaction.materialSignature !== materialSignature) break;
    current.push(interaction);
  }
  return current;
}

function parseAction(value: unknown): CoachWorkspaceAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recommendation action is invalid.');
  const action = value as Record<string, unknown>;
  if (typeof action.title !== 'string' || typeof action.copy !== 'string'
    || !['move', 'rest', 'sleep', 'other'].includes(String(action.kind))
    || !Number.isInteger(action.timeMinutes)) throw new Error('Recommendation action is invalid.');
  return {
    title: action.title,
    copy: action.copy,
    kind: action.kind as CoachWorkspaceAction['kind'],
    timeMinutes: action.timeMinutes as number,
    durationMinutes: typeof action.durationMinutes === 'number' ? action.durationMinutes : null,
    intensity: action.intensity === 'easy' || action.intensity === 'moderate' ? action.intensity : null,
  };
}

function parseAdjustment(value: unknown): ActionAdjustment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Persisted adjustment is invalid.');
  const raw = value as Record<string, unknown>;
  return {
    timeMinutes: typeof raw.timeMinutes === 'number' ? raw.timeMinutes : undefined,
    durationMinutes: typeof raw.durationMinutes === 'number' ? raw.durationMinutes : undefined,
    intensity: typeof raw.intensity === 'string' ? raw.intensity : undefined,
  };
}

export function assertActionAllowedForRecommendation(category: string, action: HydrationAction): void {
  if (category === 'calibration' && action !== 'skip' && action !== 'open_chat') {
    throw new Error(`${action} is not allowed for calibration recommendations.`);
  }
}

export function shouldMutatePlanForAction(category: string, action: HydrationAction): boolean {
  return category !== 'calibration' && action !== 'open_chat';
}

/** Derives the durable UI state from latest-first persisted interactions. */
export function deriveCoachWorkspaceState(input: {
  category: string;
  action: unknown;
  materialSignature: string;
  userId: string;
  localDay: string;
  interactions: HydrationInteraction[];
  planItem: HydrationPlanItem | null;
}): CoachWorkspaceState {
  const baseAction = parseAction(input.action);
  if (input.category === 'calibration') {
    return { status: 'calibration', planItemId: null, effectiveAction: baseAction };
  }

  const compatibleInteractions = currentOccurrenceInteractions(input.interactions, input.materialSignature);
  const stateful = compatibleInteractions.find(interaction => interaction.action !== 'open_chat');
  if (!stateful) return { status: 'ready', planItemId: null, effectiveAction: baseAction };

  const latestEffective = compatibleInteractions.find(interaction =>
    interaction.action === 'accept' || interaction.action === 'adjust',
  );
  let effectiveAction = baseAction;
  let effectiveCompatible = true;
  if (latestEffective?.action === 'adjust') {
    try {
      effectiveAction = applyActionAdjustment(baseAction, parseAdjustment(latestEffective.adjustment));
    } catch {
      effectiveCompatible = false;
    }
  }

  const latestLinkedPlanId = compatibleInteractions.find(interaction =>
    interaction.action !== 'open_chat' && interaction.planItemId != null,
  )?.planItemId ?? null;
  const validPlan = input.planItem
    && input.planItem.id === latestLinkedPlanId
    && input.planItem.userId === input.userId
    && input.planItem.localDay === input.localDay
    && input.planItem.kind === baseAction.kind
    && effectiveCompatible
    ? input.planItem
    : null;

  if (!effectiveCompatible) return { status: 'ready', planItemId: null, effectiveAction: baseAction };
  if (stateful.action === 'skip') {
    return { status: 'skipped', planItemId: validPlan?.id ?? null, effectiveAction };
  }
  if (!validPlan) return { status: 'ready', planItemId: null, effectiveAction };

  const status: CoachWorkspaceHydrationStatus = validPlan.status === 'done'
    ? 'completed'
    : validPlan.status === 'skipped'
      ? 'skipped'
      : 'planned';
  return { status, planItemId: validPlan.id, effectiveAction };
}
