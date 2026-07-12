import type { SpecialistAction } from './orchestration';

export interface SpecialistActionRequest {
  sessionId: string;
  cardOccurrenceId: string;
  actionId: string;
  action: SpecialistAction;
}

const ACTIONS = new Set<SpecialistAction>([
  'accept_handoff',
  'decline_handoff',
  'accept_return',
  'decline_return',
]);

export function parseSpecialistActionRequest(body: unknown): SpecialistActionRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const looksLikeAction = 'sessionId' in input || 'actionId' in input || 'action' in input;
  if (!looksLikeAction) return null;
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
    throw new Error('sessionId is required for specialist actions');
  }
  if (typeof input.actionId !== 'string' || !input.actionId.trim()) {
    throw new Error('actionId is required for specialist actions');
  }
  if (typeof input.cardOccurrenceId !== 'string' || !input.cardOccurrenceId.trim()) {
    throw new Error('cardOccurrenceId is required for specialist actions');
  }
  if (typeof input.action !== 'string' || !ACTIONS.has(input.action as SpecialistAction)) {
    throw new Error('action must be a supported specialist action');
  }
  return {
    sessionId: input.sessionId,
    cardOccurrenceId: input.cardOccurrenceId,
    actionId: input.actionId,
    action: input.action as SpecialistAction,
  };
}
