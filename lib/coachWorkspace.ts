import { createHash } from 'node:crypto';
import type { Calibration } from '@/lib/brain/baselines';

export type CoachRecommendationCategory = 'training' | 'recovery' | 'sleep' | 'calibration';
export type CoachActionKind = 'move' | 'rest' | 'sleep' | 'other';

export interface CoachMetric {
  value: number | null;
  baseline: number | null;
  observedAt: Date | null;
}

export interface DailyRecommendationInput {
  localDay: string;
  now: Date;
  calibration: Calibration;
  metrics: { hrv: CoachMetric; restingHr: CoachMetric; sleep: CoachMetric };
  confirmedConstraints: Array<{ type: string; label: string }>;
  nutritionContext?: { consumedKcal: number; targetKcal: number };
}

export interface DailyRecommendation {
  category: CoachRecommendationCategory;
  action: { title: string; copy: string; kind: CoachActionKind; timeMinutes: number };
  evidence: {
    fresh: boolean;
    sources: Array<{ metric: 'hrv' | 'restingHr' | 'sleep'; observedAt: string | null; baseline: number | null; value: number | null }>;
    constraintGate: boolean;
  };
  materialSignature: string;
}

const FRESHNESS_MS = 36 * 60 * 60 * 1_000;

function isFresh(metric: CoachMetric, now: Date): boolean {
  return metric.value != null && metric.baseline != null && metric.observedAt != null
    && now.getTime() - metric.observedAt.getTime() <= FRESHNESS_MS
    && metric.observedAt.getTime() <= now.getTime();
}

function sourceEvidence(input: DailyRecommendationInput): DailyRecommendation['evidence']['sources'] {
  return (Object.entries(input.metrics) as Array<['hrv' | 'restingHr' | 'sleep', CoachMetric]>).map(([metric, row]) => ({
    metric,
    observedAt: row.observedAt?.toISOString() ?? null,
    baseline: row.baseline,
    value: row.value,
  }));
}

function signaturePayload(input: DailyRecommendationInput, recommendation: Omit<DailyRecommendation, 'materialSignature'>): string {
  return JSON.stringify({
    localDay: input.localDay,
    category: recommendation.category,
    action: recommendation.action,
    metrics: recommendation.evidence.sources,
    constraintGate: recommendation.evidence.constraintGate,
    calibration: input.calibration.status,
  });
}

/**
 * Selects the one daily Coach Workspace action. This has no model or filesystem
 * dependency: its only safety inputs are persisted metric snapshots and
 * confirmed canonical constraints supplied by the repository layer.
 */
export function createDailyRecommendation(input: DailyRecommendationInput): DailyRecommendation {
  const sources = sourceEvidence(input);
  const fresh = Object.values(input.metrics).every(metric => isFresh(metric, input.now));
  const constraintGate = input.confirmedConstraints.length > 0;

  let category: CoachRecommendationCategory;
  let action: DailyRecommendation['action'];

  if (input.calibration.status !== 'ready' || !fresh) {
    category = 'calibration';
    action = {
      title: 'Keep collecting your baseline',
      copy: fresh
        ? 'Keep today comfortable while we finish learning your baseline.'
        : 'Sync fresh sleep, HRV, and resting-heart-rate data before choosing today’s action.',
      kind: 'other',
      timeMinutes: 9 * 60,
    };
  } else if (constraintGate) {
    category = 'calibration';
    action = {
      title: 'Use your confirmed limits today',
      copy: 'A confirmed health constraint is on file, so no new training prescription is generated today.',
      kind: 'other',
      timeMinutes: 9 * 60,
    };
  } else {
    const hrvRatio = input.metrics.hrv.value! / input.metrics.hrv.baseline!;
    const restingHrRatio = input.metrics.restingHr.value! / input.metrics.restingHr.baseline!;
    const sleepRatio = input.metrics.sleep.value! / input.metrics.sleep.baseline!;

    if (hrvRatio < 0.85 || restingHrRatio >= 1.1) {
      category = 'recovery';
      action = {
        title: 'Choose recovery today',
        copy: 'Your recovery signals are below your usual range. Keep movement gentle and comfortable.',
        kind: 'rest',
        timeMinutes: 12 * 60,
      };
    } else if (sleepRatio < 0.8) {
      category = 'sleep';
      action = {
        title: 'Protect tonight’s sleep',
        copy: 'Sleep was meaningfully below your usual amount. Keep today lighter and make room for an earlier wind-down.',
        kind: 'sleep',
        timeMinutes: 21 * 60 + 30,
      };
    } else {
      category = 'training';
      action = {
        title: 'Keep training comfortable',
        copy: 'Your recovery signals are in your usual range. Choose a comfortable session from your established plan.',
        kind: 'move',
        timeMinutes: 17 * 60,
      };
    }
  }

  const unsigned = { category, action, evidence: { fresh, sources, constraintGate } };
  return {
    ...unsigned,
    materialSignature: createHash('sha256').update(signaturePayload(input, unsigned)).digest('hex'),
  };
}
