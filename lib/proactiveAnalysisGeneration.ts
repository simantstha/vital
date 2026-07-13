import { parseCoachAnalysis, validateGroundedAnalysis, type CoachAnalysis } from './proactiveHealthWorker';

export const DEFAULT_PROACTIVE_ANALYSIS_MODEL = 'claude-sonnet-4-6';
export type AnalysisFailureCategory = 'parse_failure' | 'schema_failure' | 'grounding_failure';
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
  promptInput: {
    kind: 'workout' | 'sleep';
    date: string;
    input: unknown;
    availableContext: unknown;
  };
  evidence: unknown;
  generate(request: AnalysisGenerationRequest): Promise<string>;
  report(event: AnalysisFailureEvent): void;
}

export class AnalysisContentError extends Error {
  constructor(readonly category: AnalysisFailureCategory) {
    super('Proactive analysis content validation failed.');
    this.name = 'AnalysisContentError';
  }
}

const DERIVED_NUMBER_RULES = `Do not perform or state arithmetic, ratios, percentages, differences, unit conversion, rounding, estimation, extrapolation, or numeric list labels.`;
const SOURCE_VALUE_RULE = `Every numeric claim must use an exact supplied value with the same unit as that source; never drop, add, disguise, or replace a source unit.`;

export const PROACTIVE_ANALYSIS_SYSTEM_PROMPT = `You are Vital coach. Use only supplied values; never infer or invent a metric. ${SOURCE_VALUE_RULE} ${DERIVED_NUMBER_RULES} Return JSON only with exactly headline, shortInsight, narrative, observations, nextSteps. Missing data must be described as unavailable. Keep medical claims observational, not diagnostic.`;

export const PROACTIVE_ANALYSIS_REPAIR_PROMPT = `Repair the rejected Vital coach response using only the supplied request and evidence. Use only supplied values; never infer or invent a metric. ${SOURCE_VALUE_RULE} ${DERIVED_NUMBER_RULES} Return a full replacement as JSON only with exactly headline, shortInsight, narrative, observations, nextSteps. Missing data must be described as unavailable. Keep medical claims observational, not diagnostic. Fix only the supplied failure category.`;

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

function validateText(text: string, evidence: unknown): CoachAnalysis {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    throw new AnalysisContentError('parse_failure');
  }

  let shaped: CoachAnalysis;
  try {
    shaped = parseCoachAnalysis(decoded);
  } catch {
    throw new AnalysisContentError('schema_failure');
  }

  try {
    return validateGroundedAnalysis(shaped, evidence);
  } catch {
    throw new AnalysisContentError('grounding_failure');
  }
}

export async function generateGroundedAnalysis(args: GenerateGroundedAnalysisArgs): Promise<CoachAnalysis> {
  const initialText = await args.generate({
    attempt: 'initial',
    system: PROACTIVE_ANALYSIS_SYSTEM_PROMPT,
    content: JSON.stringify(args.promptInput),
  });

  let initialCategory: AnalysisFailureCategory;
  try {
    return validateText(initialText, args.evidence);
  } catch (error) {
    if (!(error instanceof AnalysisContentError)) throw error;
    initialCategory = error.category;
  }

  args.report(analysisFailureEvent('initial', initialCategory, 'repair_started'));
  const repairText = await args.generate({
    attempt: 'repair',
    system: PROACTIVE_ANALYSIS_REPAIR_PROMPT,
    content: JSON.stringify({ promptInput: args.promptInput, rejectedText: initialText, category: initialCategory }),
  });

  try {
    const repaired = validateText(repairText, args.evidence);
    args.report(analysisFailureEvent('repair', initialCategory, 'repair_succeeded'));
    return repaired;
  } catch (error) {
    if (!(error instanceof AnalysisContentError)) throw error;
    args.report(analysisFailureEvent('repair', error.category, 'repair_exhausted'));
    throw error;
  }
}
