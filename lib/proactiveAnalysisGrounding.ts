import { type CoachAnalysis, parseCoachAnalysis } from './proactiveAnalysisSchema';

export interface ProactiveAnalysisSource {
  kind: 'workout' | 'sleep';
  date: string;
  input: unknown;
  availableContext: unknown;
}

const RAW_NUMBER = /\p{N}/u;
const META_RESPONSE = /\b(?:unable to process|placeholder tokens?|template variables?|unresolved tokens?|data integrity)\b/iu;

export type AnalysisFailureCategory = 'parse_failure' | 'schema_failure' | 'grounding_failure';

export class AnalysisContentError extends Error {
  constructor(readonly category: AnalysisFailureCategory) {
    super('Proactive analysis content validation failed.');
    this.name = 'AnalysisContentError';
  }
}

export function assertNoRawNumbers(content: string): void {
  if (RAW_NUMBER.test(content)) throw new AnalysisContentError('grounding_failure');
}

export function stripCompleteJsonFence(text: string): string {
  const fence = text.match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return fence ? fence[1] : text;
}

function authoredStrings(value: CoachAnalysis): string[] {
  return [value.headline, value.shortInsight, value.narrative, ...value.observations, ...value.nextSteps];
}

/**
 * Parses and validates a model response: valid JSON matching the CoachAnalysis schema, written
 * qualitatively with no digits. The app renders the exact figures in a metrics card above this
 * prose (see lib/proactiveHealthHttp.ts), so the model never needs to reproduce a number.
 */
export function parseAnalysisText(text: string): CoachAnalysis {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stripCompleteJsonFence(text));
  } catch {
    throw new AnalysisContentError('parse_failure');
  }

  let validated: CoachAnalysis;
  try {
    validated = parseCoachAnalysis(decoded);
  } catch {
    throw new AnalysisContentError('schema_failure');
  }

  for (const value of authoredStrings(validated)) {
    if (META_RESPONSE.test(value)) throw new AnalysisContentError('grounding_failure');
    assertNoRawNumbers(value);
  }

  return validated;
}
