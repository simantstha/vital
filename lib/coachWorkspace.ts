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
  confirmedConstraints: Array<{ id: string; type: string; label: string }>;
  nutritionContext?: { consumedKcal: number; targetKcal: number };
}

export interface DailyRecommendation {
  category: CoachRecommendationCategory;
  action: CoachWorkspaceAction;
  evidence: {
    fresh: boolean;
    sources: Array<{ metric: 'hrv' | 'restingHr' | 'sleep'; observedAt: string | null; baseline: number | null; value: number | null }>;
    constraintGate: boolean;
  };
  materialSignature: string;
}

export interface CoachWorkspaceAction {
  title: string;
  copy: string;
  kind: CoachActionKind;
  timeMinutes: number;
  durationMinutes: number | null;
  intensity: 'easy' | 'moderate' | null;
}

export interface ActionAdjustment {
  timeMinutes?: number;
  durationMinutes?: number;
  // Client JSON is untrusted; applyActionAdjustment narrows this by action type.
  intensity?: string;
}

const FRESHNESS_MS = 36 * 60 * 60 * 1_000;

function isPlausible(metric: CoachMetric, metricName: 'hrv' | 'restingHr' | 'sleep'): boolean {
  if (metric.value == null || metric.baseline == null || !Number.isFinite(metric.value) || !Number.isFinite(metric.baseline)) return false;
  const [minimum, maximum] = metricName === 'hrv'
    ? [5, 250]
    : metricName === 'restingHr'
      ? [25, 220]
      : [60, 960];
  return metric.value >= minimum && metric.value <= maximum
    && metric.baseline >= minimum && metric.baseline <= maximum;
}

function isFresh(metric: CoachMetric, metricName: 'hrv' | 'restingHr' | 'sleep', now: Date): boolean {
  return isPlausible(metric, metricName) && metric.observedAt != null
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
    category: recommendation.category,
    kind: recommendation.action.kind,
    timeMinutes: recommendation.action.timeMinutes,
    durationMinutes: recommendation.action.durationMinutes,
    intensity: recommendation.action.intensity,
    safetyConstraintIds: input.confirmedConstraints.map(constraint => constraint.id).sort(),
    calibration: input.calibration.status,
  });
}

/** Validates a user-requested adjustment without changing safe coach copy. */
export function applyActionAdjustment(action: CoachWorkspaceAction, adjustment: ActionAdjustment): CoachWorkspaceAction {
  const next = { ...action };
  if (adjustment.timeMinutes != null) {
    if (!Number.isInteger(adjustment.timeMinutes) || adjustment.timeMinutes < 0 || adjustment.timeMinutes > 1439) {
      throw new Error('timeMinutes must be an integer between 0 and 1439.');
    }
    next.timeMinutes = adjustment.timeMinutes;
  }

  if (action.kind === 'move') {
    if (adjustment.durationMinutes != null) {
      if (!Number.isInteger(adjustment.durationMinutes) || adjustment.durationMinutes < 10 || adjustment.durationMinutes > 120) {
        throw new Error('move durationMinutes must be an integer between 10 and 120.');
      }
      next.durationMinutes = adjustment.durationMinutes;
    }
    if (adjustment.intensity != null) {
      if (adjustment.intensity !== 'easy' && adjustment.intensity !== 'moderate') {
        throw new Error('move intensity must be easy or moderate.');
      }
      next.intensity = adjustment.intensity;
    }
    return next;
  }

  if (action.kind === 'rest') {
    if (adjustment.durationMinutes != null) {
      if (!Number.isInteger(adjustment.durationMinutes) || adjustment.durationMinutes < 5 || adjustment.durationMinutes > 90) {
        throw new Error('rest durationMinutes must be an integer between 5 and 90.');
      }
      next.durationMinutes = adjustment.durationMinutes;
    }
    if (adjustment.intensity != null) throw new Error('intensity is not allowed for rest.');
    return next;
  }

  if (adjustment.durationMinutes != null || adjustment.intensity != null) {
    throw new Error(`durationMinutes and intensity are not allowed for ${action.kind}.`);
  }
  return next;
}

/**
 * Selects the one daily Coach Workspace action. This has no model or filesystem
 * dependency: its only safety inputs are persisted metric snapshots and
 * confirmed canonical constraints supplied by the repository layer.
 */
export function createDailyRecommendation(input: DailyRecommendationInput): DailyRecommendation {
  const sources = sourceEvidence(input);
  const fresh = (Object.entries(input.metrics) as Array<['hrv' | 'restingHr' | 'sleep', CoachMetric]>)
    .every(([metric, row]) => isFresh(row, metric, input.now));
  const constraintGate = input.confirmedConstraints.length > 0;

  let category: CoachRecommendationCategory;
  let action: CoachWorkspaceAction;

  if (input.calibration.status !== 'ready' || !fresh) {
    category = 'calibration';
    action = {
      title: 'Keep collecting your baseline',
      copy: fresh
        ? 'Keep today comfortable while we finish learning your baseline.'
        : 'Sync fresh sleep, HRV, and resting-heart-rate data before choosing today’s action.',
      kind: 'other',
      timeMinutes: 9 * 60,
      durationMinutes: null,
      intensity: null,
    };
  } else if (constraintGate) {
    category = 'calibration';
    action = {
      title: 'Use your confirmed limits today',
      copy: 'A confirmed health constraint is on file, so no new training prescription is generated today.',
      kind: 'other',
      timeMinutes: 9 * 60,
      durationMinutes: null,
      intensity: null,
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
        durationMinutes: 30,
        intensity: null,
      };
    } else if (sleepRatio < 0.8) {
      category = 'sleep';
      action = {
        title: 'Protect tonight’s sleep',
        copy: 'Sleep was meaningfully below your usual amount. Keep today lighter and make room for an earlier wind-down.',
        kind: 'sleep',
        timeMinutes: 21 * 60 + 30,
        durationMinutes: null,
        intensity: null,
      };
    } else {
      category = 'training';
      action = {
        title: 'Keep training comfortable',
        copy: 'Your recovery signals are in your usual range. Choose a comfortable session from your established plan.',
        kind: 'move',
        timeMinutes: 17 * 60,
        durationMinutes: 45,
        intensity: 'easy',
      };
    }
  }

  const unsigned = { category, action, evidence: { fresh, sources, constraintGate } };
  return {
    ...unsigned,
    materialSignature: createHash('sha256').update(signaturePayload(input, unsigned)).digest('hex'),
  };
}
