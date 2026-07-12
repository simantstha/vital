import type { SpecialistManifest, SpecialistRegistry } from './registry';
import type {
  SpecialistSession,
  SpecialistSessionRepository,
  SpecialistSessionService,
} from './sessions';

export type SpecialistAction =
  | 'accept_handoff'
  | 'decline_handoff'
  | 'accept_return'
  | 'decline_return';

export type SpecialistConfirmation = 'accept' | 'decline';

export interface PersonaSnapshot {
  id: 'vital' | 'running-coach';
  title: string;
  subtitle: string;
  accent: string;
  icon: string;
  sessionId: string | null;
}

export interface HandoffCardEvent {
  type: 'handoff_card';
  phase: 'dismissed';
  sessionId: string;
  specialist: PersonaSnapshot;
  objective: string;
  returnSummary?: unknown;
}

export interface PersonaChangedEvent {
  type: 'persona_changed';
  persona: PersonaSnapshot;
}

export interface SpecialistActionResult {
  session: SpecialistSession;
  events: [HandoffCardEvent, PersonaChangedEvent];
}

export interface ApplySpecialistActionInput {
  userId: string;
  sessionId: string;
  actionId: string;
  action: SpecialistAction;
}

export interface SpecialistActionStore {
  find(userId: string, actionId: string): Promise<SpecialistActionResult | null>;
  save(
    userId: string,
    actionId: string,
    sessionId: string,
    action: SpecialistAction,
    result: SpecialistActionResult,
  ): Promise<SpecialistActionResult>;
}

export class InMemorySpecialistActionStore implements SpecialistActionStore {
  private readonly rows = new Map<string, SpecialistActionResult>();

  async find(userId: string, actionId: string): Promise<SpecialistActionResult | null> {
    return this.rows.get(`${userId}:${actionId}`) ?? null;
  }

  async save(
    userId: string,
    actionId: string,
    _sessionId: string,
    _action: SpecialistAction,
    result: SpecialistActionResult,
  ): Promise<SpecialistActionResult> {
    const key = `${userId}:${actionId}`;
    const existing = this.rows.get(key);
    if (existing) return existing;
    this.rows.set(key, result);
    return result;
  }
}

export function isSpecialistsEnabled(
  environment: { SPECIALISTS_ENABLED?: string } = {
    SPECIALISTS_ENABLED: process.env.SPECIALISTS_ENABLED,
  },
): boolean {
  return environment.SPECIALISTS_ENABLED === 'true';
}

export function parseSpecialistConfirmation(text: string): SpecialistConfirmation | null {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, '').trim();
  if (/^(yes|yep|yeah|accept|bring them in)$/.test(normalized)) return 'accept';
  if (/^(no|decline|not now|no thanks)$/.test(normalized)) return 'decline';
  return null;
}

export function specialistPersona(manifest: SpecialistManifest, sessionId: string): PersonaSnapshot {
  return {
    id: manifest.id,
    title: manifest.name,
    subtitle: manifest.role,
    accent: manifest.accentColor,
    icon: manifest.icon,
    sessionId,
  };
}

export const VITAL_PERSONA: PersonaSnapshot = {
  id: 'vital',
  title: 'Vital Coach',
  subtitle: 'Your personal coach',
  accent: '#7C6CF2',
  icon: 'sparkles',
  sessionId: null,
};

export class SpecialistActionCoordinator<
  R extends SpecialistSessionRepository = SpecialistSessionRepository,
> {
  constructor(
    private readonly sessions: SpecialistSessionService<R>,
    private readonly actions: SpecialistActionStore,
    private readonly manifests: SpecialistRegistry,
  ) {}

  async apply(input: ApplySpecialistActionInput): Promise<SpecialistActionResult> {
    if (!input.actionId.trim()) throw new Error('actionId is required');
    const duplicate = await this.actions.find(input.userId, input.actionId);
    if (duplicate) return duplicate;

    const current = await this.sessions.get(input.userId, input.sessionId);
    if (!current) throw new Error(`Specialist session ${input.sessionId} not found for user`);

    const expected: Record<SpecialistAction, SpecialistSession['status']> = {
      accept_handoff: 'proposed',
      decline_handoff: 'proposed',
      accept_return: 'return_proposed',
      decline_return: 'return_proposed',
    };
    if (current.status !== expected[input.action]) {
      throw new Error(`Action ${input.action} is invalid while session is ${current.status}`);
    }

    const target = {
      accept_handoff: 'active',
      decline_handoff: 'declined',
      accept_return: 'completed',
      decline_return: 'active',
    }[input.action] as SpecialistSession['status'];
    const session = await this.sessions.transition(input.userId, input.sessionId, target);
    const manifest = this.manifests.get(session.manifestId);
    const persona = target === 'active'
      ? specialistPersona(manifest, session.id)
      : VITAL_PERSONA;
    const result: SpecialistActionResult = {
      session,
      events: [
        {
          type: 'handoff_card',
          phase: 'dismissed',
          sessionId: session.id,
          specialist: specialistPersona(manifest, session.id),
          objective: session.objective,
          ...(session.returnHandoff ? { returnSummary: session.returnHandoff } : {}),
        },
        { type: 'persona_changed', persona },
      ],
    };
    return this.actions.save(
      input.userId,
      input.actionId,
      input.sessionId,
      input.action,
      result,
    );
  }
}

interface SpecialistPromptInput {
  manifest: SpecialistManifest;
  objective: string;
  trustedSafetyRules: string;
  hardConstraints: string;
  calibration: string;
  relevantMessages: string[];
  inboundHandoff: unknown;
}

export interface CompiledSpecialistPrompt {
  system: string;
  model: string;
  allowedTools: readonly string[];
}

function trustedHandoffFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const allowed = ['summary', 'relevantFacts', 'recentContext', 'requestedOutcome'];
  return Object.fromEntries(allowed.flatMap((key) => key in source ? [[key, source[key]]] : []));
}

export function buildSpecialistPrompt(input: SpecialistPromptInput): CompiledSpecialistPrompt {
  const moduleText = input.manifest.promptModules.map((module) => module.prompt).join('\n\n');
  const handoff = JSON.stringify(trustedHandoffFields(input.inboundHandoff), null, 2);
  return {
    model: input.manifest.model,
    allowedTools: input.manifest.allowedTools,
    system: [
      `You are ${input.manifest.name}, a non-clinical ${input.manifest.role}.`,
      moduleText,
      `## Consultation objective\n${input.objective}`,
      `## Trusted safety rules\n${input.trustedSafetyRules}`,
      `## Hard constraints\n${input.hardConstraints}`,
      `## Calibration\n${input.calibration}`,
      `## Structured handoff\n${handoff}`,
      `## Relevant conversation\n${input.relevantMessages.join('\n')}`,
    ].join('\n\n---\n\n'),
  };
}

export interface ReturnHandoff {
  outcomes: string[];
  decisions: string[];
  recommendations: string[];
  unresolvedRisks: string[];
  nextSteps: string[];
}

export function validateReturnHandoff(input: unknown): ReturnHandoff {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('return handoff must be an object');
  }
  const source = input as Record<string, unknown>;
  const keys = ['outcomes', 'decisions', 'recommendations', 'unresolvedRisks', 'nextSteps'] as const;
  const result = {} as ReturnHandoff;
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`${key} must be a non-empty array of strings`);
    }
    result[key] = value;
  }
  return result;
}
