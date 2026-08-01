import {
  AnalysisContentError,
  parseAnalysisText,
  type AnalysisFailureCategory,
  type ProactiveAnalysisSource,
} from './proactiveAnalysisGrounding';
import { type CoachAnalysis } from './proactiveAnalysisSchema';
import { formatAnalysisSource } from './proactiveAnalysisFormatting';

export { AnalysisContentError, type AnalysisFailureCategory } from './proactiveAnalysisGrounding';

export const DEFAULT_PROACTIVE_ANALYSIS_MODEL = 'claude-sonnet-5';
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

export interface GenerateAnalysisArgs {
  source: ProactiveAnalysisSource;
  generate(request: AnalysisGenerationRequest): Promise<string>;
  report(event: AnalysisFailureEvent): void;
}

const SCHEMA_CONTRACT = `headline, shortInsight, and narrative must each be a non-empty JSON string. observations and nextSteps must each be a JSON array of non-empty JSON strings. No additional keys are allowed.`;
const NUMBER_CONTRACT = `The app already displays this session's exact figures (duration, calories, average and max heart rate, distance, pace, sleep stages, and similar) in a metrics card shown directly above this text, so repeating any of those figures here would just be redundant. Describe the session qualitatively instead: say whether it was faster or slower, longer or shorter than usual, well above or below baseline, a personal best, or in line with recent sessions — without writing the numbers themselves. Never write a digit or any other numeral character (no Arabic numerals, no other numbering systems, no numeric symbols) anywhere in headline, shortInsight, narrative, observations, or nextSteps.`;
const CONTENT_CONTRACT = `Name the workout type or sleep in the headline using a few words. Make the shortInsight one sentence characterizing the single most notable aspect of the session. Keep the narrative to at most three sentences about this session only. Characterize two or three observations qualitatively rather than citing exact figures. Give one or two next steps. Mention profile or goal context only when it changes what the user should do next.`;

export const PROACTIVE_ANALYSIS_SYSTEM_PROMPT = `You are Vital coach. Return JSON only with exactly headline, shortInsight, narrative, observations, and nextSteps. ${SCHEMA_CONTRACT} Keep the output observational and non-diagnostic. ${NUMBER_CONTRACT} ${CONTENT_CONTRACT}`;

export const PROACTIVE_ANALYSIS_REPAIR_PROMPT = `Repair the Vital coach response for the supplied failure category and request. Return a full replacement as JSON only with exactly headline, shortInsight, narrative, observations, and nextSteps. ${SCHEMA_CONTRACT} Keep the output observational and non-diagnostic. ${NUMBER_CONTRACT} ${CONTENT_CONTRACT}`;

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

function analysisRequest(attempt: AnalysisAttempt, system: string, payload: unknown): AnalysisGenerationRequest {
  return { attempt, system, content: JSON.stringify(payload) };
}

/**
 * The model receives a pre-formatted source (see lib/proactiveAnalysisFormatting.ts — rounded,
 * unit-labeled figures rather than raw floats) and is asked for qualitative prose only: the exact
 * figures are rendered deterministically by the client from the same stored input (see
 * lib/proactiveHealthHttp.ts), so the model never has to reproduce a number. One repair attempt
 * covers the occasional stray digit or malformed JSON; a second failure is reported and rethrown so
 * the caller can fall back. `args.source` itself is never mutated — see formatAnalysisSource's doc
 * comment for why that matters.
 */
export async function generateAnalysis(args: GenerateAnalysisArgs): Promise<CoachAnalysis> {
  const formattedSource = formatAnalysisSource(args.source);
  let initialError: AnalysisContentError;

  try {
    const initialText = await args.generate(analysisRequest('initial', PROACTIVE_ANALYSIS_SYSTEM_PROMPT, formattedSource));
    return parseAnalysisText(initialText);
  } catch (error) {
    if (!(error instanceof AnalysisContentError)) throw error;
    initialError = error;
  }

  args.report(analysisFailureEvent('initial', initialError.category, 'repair_started'));
  const repairPayload = {
    category: initialError.category,
    request: formattedSource,
  };

  try {
    const repairText = await args.generate(analysisRequest('repair', PROACTIVE_ANALYSIS_REPAIR_PROMPT, repairPayload));
    const result = parseAnalysisText(repairText);
    args.report(analysisFailureEvent('repair', initialError.category, 'repair_succeeded'));
    return result;
  } catch (error) {
    if (!(error instanceof AnalysisContentError)) throw error;
    args.report(analysisFailureEvent('repair', error.category, 'repair_exhausted'));
    throw error;
  }
}
