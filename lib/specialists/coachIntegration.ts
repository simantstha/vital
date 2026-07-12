import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SpecialistManifest } from './registry';
import type { SpecialistSession } from './sessions';
import type { CompiledSpecialistPrompt, PersonaSnapshot } from './orchestration';
import { specialistPersona } from './orchestration';
import {
  PROPOSE_RETURN_TO_VITAL_TOOL,
  PROPOSE_SPECIALIST_HANDOFF_TOOL,
} from './coachRuntime';

interface CoachConfigurationInput {
  enabled: boolean;
  session: SpecialistSession | null;
  manifest: SpecialistManifest | null;
  baseModel: string;
  basePrompt: string;
  baseTools: Tool[];
  specialistPrompt: CompiledSpecialistPrompt | null;
}

export interface CoachConfiguration {
  model: string;
  system: string;
  context: string | null;
  tools: Tool[];
  speaker: 'coach' | 'specialist';
}

export function selectCoachConfiguration(input: CoachConfigurationInput): CoachConfiguration {
  if (!input.enabled) {
    return {
      model: input.baseModel,
      system: input.basePrompt,
      context: null,
      tools: input.baseTools,
      speaker: 'coach',
    };
  }

  const specialistActive = input.session?.status === 'active' ||
    input.session?.status === 'return_proposed';
  if (specialistActive && input.manifest && input.specialistPrompt) {
    const allowed = new Set(input.specialistPrompt.allowedTools);
    return {
      model: input.specialistPrompt.model,
      system: input.specialistPrompt.system,
      context: input.specialistPrompt.context,
      tools: [
        ...input.baseTools.filter((tool) => allowed.has(tool.name)),
        PROPOSE_RETURN_TO_VITAL_TOOL,
      ],
      speaker: 'specialist',
    };
  }

  return {
    model: input.baseModel,
    system: input.basePrompt,
    context: null,
    tools: input.session ? input.baseTools : [...input.baseTools, PROPOSE_SPECIALIST_HANDOFF_TOOL],
    speaker: 'coach',
  };
}

const PRIVATE_SPECIALIST_TOOL_INPUTS = new Set([
  'propose_specialist_handoff',
  'propose_return_to_vital',
]);

export function toolCallForPersistence(
  name: string,
  input: Record<string, unknown>,
): { name: string; input?: Record<string, unknown> } {
  return PRIVATE_SPECIALIST_TOOL_INPUTS.has(name) ? { name } : { name, input };
}

export interface HandoffCardPayload {
  type: 'handoff_card';
  phase: 'proposed' | 'return_proposed';
  sessionId: string;
  specialist: PersonaSnapshot;
  objective: string;
  returnSummary?: unknown;
}

export function handoffCardForSession(
  session: SpecialistSession,
  manifest: SpecialistManifest,
): HandoffCardPayload {
  if (session.status !== 'proposed' && session.status !== 'return_proposed') {
    throw new Error(`Session ${session.id} does not have a pending handoff card`);
  }
  return {
    type: 'handoff_card',
    phase: session.status,
    sessionId: session.id,
    specialist: specialistPersona(manifest, session.id),
    objective: session.objective,
    ...(session.returnHandoff ? { returnSummary: session.returnHandoff } : {}),
  };
}
