import {
  AnalysisContentError,
  assertNoRawNumbers,
  encodeProactiveAnalysisRequest,
  groundAnalysisText,
  modelPayload,
  type AnalysisFailureCategory,
  type GroundedAnalysisProof,
  type ProactiveAnalysisSource,
} from './proactiveAnalysisGrounding';

export { AnalysisContentError, type AnalysisFailureCategory } from './proactiveAnalysisGrounding';

export const DEFAULT_PROACTIVE_ANALYSIS_MODEL = 'claude-haiku-4-5';
export type AnalysisAttempt = 'initial' | 'repair';
export type AnalysisFailureOutcome = 'repair_started' | 'repair_succeeded' | 'repair_exhausted';

export interface AnalysisFailureEvent {
  event: 'proactive_analysis_failure';
  attempt: AnalysisAttempt;
  category: AnalysisFailureCategory;
  outcome: AnalysisFailureOutcome;
}

export interface AnalysisGenerationRequest {
  attempt: AnalysisAttempt;
  system: string;
  content: string;
}

export interface GenerateGroundedAnalysisArgs {
  source: ProactiveAnalysisSource;
  generate(request: AnalysisGenerationRequest): Promise<string>;
  report(event: AnalysisFailureEvent): void;
}

const SCHEMA_CONTRACT = `headline, shortInsight, and narrative must each be a non-empty JSON string. observations and nextSteps must each be a JSON array of non-empty JSON strings. No additional keys are allowed.`;
const TOKEN_CONTRACT = `Evidence tokens are delimited by the characters ⟦ and ⟧ (for example ⟦EVIDENCE_A⟧); every such token is a real recorded measurement, never a placeholder or an unfilled template variable, and must be copied exactly as given, brackets included. Every supplied evidence token stands for a verified recorded value and already includes its display unit when applicable. Treat evidence tokens as real measurements, not placeholders or missing data. Never describe the request as containing placeholders, template variables, unresolved tokens, missing metric values, or a data integrity problem. Copy only supplied evidence tokens exactly into natural user-facing prose. Cite the session's key metrics: for a workout, cite duration, distance, pace, and average heart rate when supplied; for sleep, cite duration and efficiency. Copy a token only into a scalar string or an individual array-item string. Never repeat an evidence token anywhere in the response. A copied token must be the final content of its clause or string. When punctuation is used, place the token immediately before a terminal punctuation mark. Place no content after the token in that clause. Never place a unit, qualifier, parenthetical, symbol, or other prose after the token. Never place a sign before a token. Never alter, split, concatenate, nest, enumerate, or manufacture a token. Never write a raw number or numeric symbol sequence.`;
const CONTENT_CONTRACT = `Name the workout type or sleep in the headline using a few words. Make the shortInsight one sentence containing the single most notable metric. Keep the narrative to at most three sentences about this session only. Anchor each observation to a supplied metric, giving two or three observations. Give one or two next steps. Never repeat the same fact or profile detail in more than one field; mention profile or goal context only when it changes what the user should do next.`;

export const PROACTIVE_ANALYSIS_SYSTEM_PROMPT = `You are Vital coach. Return JSON only with exactly headline, shortInsight, narrative, observations, and nextSteps. ${SCHEMA_CONTRACT} Keep the output observational and non-diagnostic. ${TOKEN_CONTRACT} ${CONTENT_CONTRACT}`;

export const PROACTIVE_ANALYSIS_REPAIR_PROMPT = `Repair the Vital coach response for the supplied failure category and request. Return a full replacement as JSON only with exactly headline, shortInsight, narrative, observations, and nextSteps. ${SCHEMA_CONTRACT} Keep the output observational and non-diagnostic. ${TOKEN_CONTRACT} ${CONTENT_CONTRACT}`;

export function proactiveAnalysisModel(env: NodeJS.ProcessEnv): string {
  return env.PROACTIVE_ANALYSIS_MODEL ?? DEFAULT_PROACTIVE_ANALYSIS_MODEL;
}

export function analysisFailureEvent(
  attempt: AnalysisAttempt,
  category: AnalysisFailureCategory,
  outcome: AnalysisFailureOutcome,
): AnalysisFailureEvent {
  return { event: 'proactive_analysis_failure', attempt, category, outcome };
}

function guardedRequest(attempt: AnalysisAttempt, system: string, payload: unknown): AnalysisGenerationRequest {
  const content = JSON.stringify(payload);
  assertNoRawNumbers(system);
  assertNoRawNumbers(content);
  return { attempt, system, content };
}

export async function generateGroundedAnalysis(args: GenerateGroundedAnalysisArgs): Promise<GroundedAnalysisProof> {
  const encoded = encodeProactiveAnalysisRequest(args.source);
  let initialError: AnalysisContentError;

  try {
    const initialRequest = guardedRequest('initial', PROACTIVE_ANALYSIS_SYSTEM_PROMPT, modelPayload(encoded));
    const initialText = await args.generate(initialRequest);
    return groundAnalysisText(initialText, encoded);
  } catch (error) {
    if (!(error instanceof AnalysisContentError)) throw error;
    initialError = error;
  }

  args.report(analysisFailureEvent('initial', initialError.category, 'repair_started'));
  const repairPayload = {
    category: initialError.category,
    request: modelPayload(encoded),
  };

  try {
    const repairRequest = guardedRequest('repair', PROACTIVE_ANALYSIS_REPAIR_PROMPT, repairPayload);
    const repairText = await args.generate(repairRequest);
    const proof = groundAnalysisText(repairText, encoded);
    args.report(analysisFailureEvent('repair', initialError.category, 'repair_succeeded'));
    return proof;
  } catch (error) {
    if (!(error instanceof AnalysisContentError)) throw error;
    args.report(analysisFailureEvent('repair', error.category, 'repair_exhausted'));
    throw error;
  }
}
