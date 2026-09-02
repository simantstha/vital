import type { TextBlockParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SpecialistManifest } from './registry';
import type { SpecialistSession } from './sessions';
import type {
  CompiledSpecialistPrompt,
  HandoffCardEvent,
  PersonaChangedEvent,
  PersonaSnapshot,
} from './orchestration';
import { specialistPersona, VITAL_PERSONA } from './orchestration';
import { PROPOSE_RETURN_TO_VITAL_TOOL } from './coachRuntime';

interface CoachConfigurationInput {
  enabled: boolean;
  session: SpecialistSession | null;
  manifest: SpecialistManifest | null;
  baseModel: string;
  basePrompt: string;
  baseTools: Tool[];
  specialistPrompt: CompiledSpecialistPrompt | null;
  handoffTool: Tool | null;
}

export interface CoachConfiguration {
  model: string;
  /**
   * Block array rather than a plain string so the last block can carry a
   * `cache_control` breakpoint — see cachedSystem below.
   */
  system: TextBlockParam[];
  context: string | null;
  tools: Tool[];
  speaker: 'coach' | 'specialist';
}

/**
 * Renders the system prompt as a single cached text block.
 *
 * The API renders `tools` -> `system` -> `messages`, so a breakpoint on the
 * LAST system block covers the tool schemas AND the system prompt in one
 * entry. That pair is the bulk of the request (lib/brain/tools.ts alone is
 * ~1665 lines of schema) and is byte-identical across every round of a turn,
 * so caching it turns MAX_ROUNDS full-price re-sends into one write plus
 * cheap reads.
 *
 * A single block is enough — the breakpoint caches everything *preceding* it,
 * not just its own block, so splitting the prompt would buy nothing here.
 */
function cachedSystem(prompt: string): TextBlockParam[] {
  return [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }];
}

export function selectCoachConfiguration(input: CoachConfigurationInput): CoachConfiguration {
  if (!input.enabled) {
    return {
      model: input.baseModel,
      system: cachedSystem(input.basePrompt),
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
      system: cachedSystem(input.specialistPrompt.system),
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
    system: cachedSystem(input.basePrompt),
    context: null,
    tools: input.session || !input.handoffTool
      ? input.baseTools
      : [...input.baseTools, input.handoffTool],
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
  cardOccurrenceId: string;
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
    cardOccurrenceId: session.cardOccurrenceId,
    specialist: specialistPersona(manifest, session.id),
    objective: session.objective,
    ...(session.returnHandoff ? { returnSummary: session.returnHandoff } : {}),
  };
}

export function killSwitchEventsForSession(
  session: SpecialistSession,
  manifest?: SpecialistManifest,
): Array<HandoffCardEvent | PersonaChangedEvent> {
  const personaChanged: PersonaChangedEvent = {
    type: 'persona_changed',
    persona: VITAL_PERSONA,
  };
  if (session.status !== 'proposed' && session.status !== 'return_proposed') {
    return [personaChanged];
  }
  if (!manifest) throw new Error('A specialist manifest is required to dismiss a pending card');
  return [
    { ...handoffCardForSession(session, manifest), phase: 'dismissed' },
    personaChanged,
  ];
}
