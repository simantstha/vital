export interface CoachAnalysis {
  headline: string;
  shortInsight: string;
  narrative: string;
  observations: string[];
  nextSteps: string[];
}

// Runaway guardrails, set one notch above what CONTENT_CONTRACT in proactiveAnalysisGeneration.ts
// asks for — exceeding these throws and costs a repair round-trip, so they should rarely fire.
const limits: Record<keyof CoachAnalysis, number> = {
  headline: 80, shortInsight: 200, narrative: 500, observations: 3, nextSteps: 2,
};

export function parseCoachAnalysis(value: unknown): CoachAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coach output must be an object');
  const row = value as Record<string, unknown>;
  for (const key of ['headline', 'shortInsight', 'narrative'] as const) {
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > limits[key]) throw new Error(`invalid ${key}`);
  }
  const arrays: Record<'observations' | 'nextSteps', string[]> = { observations: [], nextSteps: [] };
  for (const key of ['observations', 'nextSteps'] as const) {
    // CONTENT_CONTRACT (proactiveAnalysisGeneration.ts) tells the model to
    // "return empty observations and nextSteps" for a routine session; models
    // sometimes literalize "empty" as a missing key or an explicit null
    // rather than `[]`. Both coerce to `[]` here — only a present, non-array,
    // non-null value is a real schema violation.
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw) || raw.length > limits[key] || raw.some((item) => typeof item !== 'string' || !item.trim() || item.length > 200)) {
      throw new Error(`invalid ${key}`);
    }
    arrays[key] = raw;
  }
  // Return a fresh object containing exactly the five known fields rather
  // than casting the raw row, so an unknown extra key the model added (e.g.
  // a stray "confidence") is silently dropped instead of rejected.
  return {
    headline: row.headline as string,
    shortInsight: row.shortInsight as string,
    narrative: row.narrative as string,
    observations: arrays.observations,
    nextSteps: arrays.nextSteps,
  };
}
