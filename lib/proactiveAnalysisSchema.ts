export interface CoachAnalysis {
  headline: string;
  shortInsight: string;
  narrative: string;
  observations: string[];
  nextSteps: string[];
}

const limits: Record<keyof CoachAnalysis, number> = {
  headline: 120, shortInsight: 240, narrative: 1200, observations: 6, nextSteps: 5,
};

export function parseCoachAnalysis(value: unknown): CoachAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coach output must be an object');
  const row = value as Record<string, unknown>;
  const expected = Object.keys(limits);
  for (const key of Object.keys(row)) if (!expected.includes(key)) throw new Error(`unexpected field: ${key}`);
  for (const key of ['headline', 'shortInsight', 'narrative'] as const) {
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > limits[key]) throw new Error(`invalid ${key}`);
  }
  for (const key of ['observations', 'nextSteps'] as const) {
    if (!Array.isArray(row[key]) || row[key].length > limits[key] || row[key].some((item) => typeof item !== 'string' || !item.trim() || item.length > 240)) throw new Error(`invalid ${key}`);
  }
  return row as unknown as CoachAnalysis;
}
