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

export const DEFAULT_PROACTIVE_ANALYSIS_MODEL = 'claude-sonnet-4-6';
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
const TOKEN_CONTRACT = `Copy only supplied evidence tokens exactly. Copy them only into a scalar string or an individual array-item string. Use each token at most once. Each token must terminate its clause or string and may be followed only by a terminal punctuation mark. Never place a sign before a token or a unit, percent, degree, or other numeric symbol after it. Never alter, split, concatenate, nest, enumerate, or manufacture a token. Never write a raw number or numeric symbol sequence. Use qualitative language when no token fits.`;

export const PROACTIVE_ANALYSIS_SYSTEM_PROMPT = `You are Vital coach. Return JSON only with exactly headline, shortInsight, narrative, observations, and nextSteps. ${SCHEMA_CONTRACT} Keep the output observational and non-diagnostic. ${TOKEN_CONTRACT}`;

export const PROACTIVE_ANALYSIS_REPAIR_PROMPT = `Repair the Vital coach response for the supplied failure category and request. Return a full replacement as JSON only with exactly headline, shortInsight, narrative, observations, and nextSteps. ${SCHEMA_CONTRACT} Keep the output observational and non-diagnostic. ${TOKEN_CONTRACT}`;

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
