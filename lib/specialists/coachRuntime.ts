import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SpecialistManifest, SpecialistRegistry } from './registry';
import {
  type SpecialistSession,
  type SpecialistSessionRepository,
  type SpecialistSessionService,
} from './sessions';
import { validateReturnHandoff } from './orchestration';

const PROPOSAL_TTL_MS = 15 * 60 * 1000;

interface AnthropicUsage {
  input_tokens: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens: number;
}

export interface AggregatedModelUsage {
  /**
   * Total prompt tokens — the uncached remainder PLUS both cache figures.
   * (`usage.input_tokens` alone is only the uncached part, so a well-cached
   * turn would otherwise look like it shrank rather than got cheaper.)
   */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens written to cache, billed at ~1.25x. Nonzero on the round that seeds the cache. */
  cacheCreationInputTokens: number;
  /** Prompt tokens served from cache, billed at ~0.1x. Zero here across a multi-round turn means a breakpoint is misplaced. */
  cacheReadInputTokens: number;
}

export function accumulateModelUsage(
  current: AggregatedModelUsage | undefined,
  usage: AnthropicUsage,
): AggregatedModelUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) +
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + usage.output_tokens,
    cacheCreationInputTokens: (current?.cacheCreationInputTokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
  };
}

export function isModelStreamInterruption(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' ||
    error.constructor.name === 'APIUserAbortError' ||
    error.message === 'Request was aborted.';
}

export function proposeSpecialistHandoffTool(manifests: SpecialistManifest[]): Tool {
  const specialistList = manifests
    .map((manifest) => `- ${manifest.name} (${manifest.id}): ${manifest.triggerDescription}`)
    .join('\n');
  return {
    name: 'propose_specialist_handoff',
    description:
      'Propose bringing a Vital specialist into this same chat for a deeper consultation. ' +
      'This creates a confirmation card only and never changes persona automatically.\n\n' +
      `Available specialists:\n${specialistList}`,
    input_schema: {
      type: 'object',
      properties: {
        specialistId: {
          type: 'string',
          enum: manifests.map((manifest) => manifest.id),
          description: 'The id of the specialist to bring in.',
        },
        objective: { type: 'string', description: 'The bounded consultation objective.' },
        summary: { type: 'string', description: 'Compact context the specialist needs.' },
        relevantFacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only facts directly relevant to the consultation.',
        },
      },
      required: ['specialistId', 'objective', 'summary', 'relevantFacts'],
    },
  };
}

export const PROPOSE_RETURN_TO_VITAL_TOOL: Tool = {
  name: 'propose_return_to_vital',
  description:
    'Propose completing this consultation and returning the visible conversation to Vital Coach. ' +
    'This creates a confirmation card and does not return automatically.',
  input_schema: {
    type: 'object',
    properties: {
      outcomes: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' } },
      recommendations: { type: 'array', items: { type: 'string' } },
      unresolvedRisks: { type: 'array', items: { type: 'string' } },
      nextSteps: { type: 'array', items: { type: 'string' } },
    },
    required: ['outcomes', 'decisions', 'recommendations', 'unresolvedRisks', 'nextSteps'],
  },
};

interface ProposeHandoffInput {
  specialistId: string;
  objective: string;
  summary: string;
  relevantFacts: string[];
}

interface RuntimeLog extends Record<string, unknown> {
  event: string;
  userId: string;
  sessionId: string;
  manifestId: string;
  status: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

interface RuntimeDependencies<R extends SpecialistSessionRepository> {
  sessions: SpecialistSessionService<R>;
  manifests: SpecialistRegistry;
  now?: () => Date;
  log?: (entry: RuntimeLog) => void;
}

export class SpecialistCoachRuntime<
  R extends SpecialistSessionRepository = SpecialistSessionRepository,
> {
  private readonly now: () => Date;
  private readonly log: (entry: RuntimeLog) => void;

  constructor(private readonly dependencies: RuntimeDependencies<R>) {
    this.now = dependencies.now ?? (() => new Date());
    this.log = dependencies.log ?? ((entry) => console.info('specialist_lifecycle', entry));
  }

  async proposeHandoff(userId: string, input: ProposeHandoffInput): Promise<SpecialistSession> {
    if (!input.specialistId?.trim()) throw new Error('specialistId is required');
    if (!input.objective?.trim()) throw new Error('objective is required');
    if (!input.summary?.trim()) throw new Error('summary is required');
    if (!Array.isArray(input.relevantFacts) || input.relevantFacts.some((fact) => typeof fact !== 'string')) {
      throw new Error('relevantFacts must be an array of strings');
    }
    const manifest = this.dependencies.manifests.get(input.specialistId.trim());
    const now = this.now();
    const session = await this.dependencies.sessions.propose({
      userId,
      objective: input.objective.trim(),
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      inboundHandoff: {
        summary: input.summary.trim(),
        relevantFacts: input.relevantFacts.map((fact) => fact.trim()).filter(Boolean),
      },
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    });
    this.lifecycleLog(session, 'specialist_proposed');
    return session;
  }

  async proposeReturn(userId: string, sessionId: string, input: unknown): Promise<SpecialistSession> {
    const returnHandoff = validateReturnHandoff(input);
    const session = await this.dependencies.sessions.transition(userId, sessionId, 'return_proposed', {
      returnHandoff,
      expiresAt: new Date(this.now().getTime() + PROPOSAL_TTL_MS),
    });
    this.lifecycleLog(session, 'specialist_return_proposed');
    return session;
  }

  async completeExplicitReturn(userId: string, sessionId: string): Promise<SpecialistSession> {
    const session = await this.dependencies.sessions.transition(userId, sessionId, 'completed', {
      returnHandoff: {
        reason: 'user_requested_return',
        summary: 'The user explicitly ended the specialist consultation.',
      },
    });
    this.lifecycleLog(session, 'specialist_explicit_return');
    return session;
  }

  async handleModelFailure(
    userId: string,
    sessionId: string,
    error: unknown,
  ): Promise<SpecialistSession> {
    const current = await this.dependencies.sessions.get(userId, sessionId);
    if (!current) throw new Error(`Specialist session ${sessionId} not found for user`);
    if (isModelStreamInterruption(error)) {
      this.lifecycleLog(current, 'specialist_stream_interrupted');
      return current;
    }
    const failed = await this.dependencies.sessions.transition(userId, sessionId, 'failed', {
      failureReason: 'premium_model_unavailable',
    });
    this.lifecycleLog(failed, 'specialist_model_failed');
    return failed;
  }

  logModelUsage(
    session: SpecialistSession,
    usage: {
      latencyMs: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    },
  ): void {
    this.log({
      event: 'specialist_model_usage',
      userId: session.userId,
      sessionId: session.id,
      manifestId: session.manifestId,
      status: session.status,
      latencyMs: usage.latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      // The cache split is what makes the prompt-caching effect observable in
      // production: a healthy multi-round turn writes once and reads on every
      // later round. cacheReadInputTokens pinned at 0 means no cache is landing.
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
    });
  }

  private lifecycleLog(session: SpecialistSession, event: string): void {
    this.log({
      event,
      userId: session.userId,
      sessionId: session.id,
      manifestId: session.manifestId,
      status: session.status,
    });
  }
}
