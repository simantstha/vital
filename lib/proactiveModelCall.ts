import type Anthropic from '@anthropic-ai/sdk';
import { AnalysisContentError } from './proactiveAnalysisGrounding';

/**
 * Request construction and response handling for the proactive worker's two
 * Anthropic calls (analyses and goal nudges), kept out of
 * scripts/proactive-health-worker.ts so the parts that have bitten us in
 * production are unit-testable without a network or an API key.
 */

export const ANALYSIS_MAX_TOKENS = 1500;
export const NUDGE_MAX_TOKENS = 500;

export interface ProactiveModelRequest {
  system: string;
  content: string;
}

/** Names the call in error messages; 'analysis' also selects the AnalysisContentError (repairable) failure path. */
export type ProactiveModelCallLabel = 'analysis' | 'insight nudge';

export function buildAnalysisRequest(model: string, request: ProactiveModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: ANALYSIS_MAX_TOKENS,
    // Sonnet 5 runs adaptive thinking by default when this is omitted (Sonnet
    // 4.6 did not), and thinking tokens count against max_tokens. With a large
    // analysis context the thinking ate most of the budget, the JSON was cut
    // off mid-object, and both the first call and the repair call fell back to
    // the "couldn't put together a read" copy. This call is a single-turn,
    // schema-constrained JSON answer — disable explicitly, as lib/claude.ts and
    // lib/brain/coach.ts do.
    thinking: { type: 'disabled' },
    system: request.system,
    messages: [{ role: 'user', content: request.content }],
  };
}

export function buildNudgeRequest(model: string, request: ProactiveModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: NUDGE_MAX_TOKENS,
    // Same reason as buildAnalysisRequest, and worse at 500 tokens: adaptive
    // thinking could consume the whole budget and leave no text block at all.
    thinking: { type: 'disabled' },
    system: request.system,
    messages: [{ role: 'user', content: request.content }],
  };
}

/**
 * Pulls the single text block out of a response, checking `stop_reason` first so
 * a truncated or refused response fails with a reason instead of a confusing
 * downstream "not JSON". For analyses the failures are AnalysisContentErrors
 * (category parse_failure), which sends them down generateAnalysis's repair
 * path and puts the reason in the logged failure event; nudges have no repair
 * path, so they throw a plain Error.
 */
export function textFromResponse(response: Anthropic.Message, label: ProactiveModelCallLabel): string {
  const repairable = label === 'analysis';
  if (response.stop_reason === 'max_tokens') {
    if (repairable) throw new AnalysisContentError('parse_failure', 'truncated at max_tokens');
    throw new Error(`${label} model response truncated at max_tokens`);
  }
  if (response.stop_reason === 'refusal') {
    if (repairable) throw new AnalysisContentError('parse_failure', 'refusal');
    throw new Error(`${label} model refused`);
  }
  const textBlocks = response.content.filter((block): block is Anthropic.TextBlock => block.type === 'text');
  if (textBlocks.length !== 1) throw new Error(`${label} model returned no text`);
  return textBlocks[0].text;
}
