/**
 * Vital Brain — metric/event-type label tables.
 *
 * Pure, zero-import leaf module (no DB, no Next.js, nothing) — split out of
 * lib/brain/tools.ts so lib/brain/toolActivity.ts (also pure) can share
 * these exact label strings for its done-form labels/summaries without
 * pulling in tools.ts's `@/db` dependency. tools.ts re-exports both names so
 * every existing importer of `metricLabel`/`EVENT_TYPE_LABELS` from './tools'
 * is unaffected.
 */

const METRIC_LABELS: Record<string, string> = {
  hrv_sdnn:            'HRV',
  resting_hr:          'resting heart rate',
  hr_avg:              'heart rate',
  steps:               'steps',
  active_energy_kcal:  'active energy',
  body_mass_kg:        'weight',
  sleep_minutes:       'sleep',
  workouts:            'workouts',
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

export const EVENT_TYPE_LABELS: Record<string, string> = {
  hrv_reading:        'HRV readings',
  sleep_session:      'sleep sessions',
  workout_completed:  'workouts',
  steps_recorded:     'step counts',
  meal_logged:        'meals',
  weight_logged:      'weight logs',
};
