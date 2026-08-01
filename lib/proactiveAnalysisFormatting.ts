import { type ProactiveAnalysisSource } from './proactiveAnalysisGrounding';
import { formatKilometres, formatMinutes, formatPaceMinPerKm, roundInteger, roundTo } from './metricFormat';

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SLEEP_STAGE_KEYS = new Set(['core', 'deep', 'rem', 'awake']);

const INTEGER_METRICS = new Set([
  'hrv_sdnn', 'resting_hr', 'hr_avg', 'steps', 'active_energy_kcal', 'workouts',
  'whoop_recovery', 'whoop_hrv_rmssd', 'whoop_resting_hr', 'whoop_spo2',
]);
const ROUND_TO_1DP_METRICS = new Set(['body_mass_kg', 'whoop_day_strain', 'whoop_skin_temp']);
const FORMAT_MINUTES_METRICS = new Set(['sleep_minutes', 'whoop_sleep_min']);

function bpm(value: unknown): string | null {
  const n = roundInteger(value);
  return n == null ? null : `${n} bpm`;
}

/**
 * Whitelisted workout input transform. `type` and `startTime` pass through
 * verbatim. Any key not in the whitelist below — including a brand-new iOS
 * field the ingest route hasn't been taught to reject yet (it only
 * validates `hkUuid: string`, see app/api/ingest/daily/route.ts:61,78-79) —
 * also passes through verbatim rather than being silently dropped.
 */
function formatWorkoutInput(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const result: Rec = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'durationMin': {
        const formatted = formatMinutes(value);
        if (formatted != null) result.duration = formatted;
        break;
      }
      case 'kcal': {
        const n = roundInteger(value);
        if (n != null) result.calories = `${n} kcal`;
        break;
      }
      case 'avgHr':
      case 'maxHr': {
        const formatted = bpm(value);
        if (formatted != null) result[key] = formatted;
        break;
      }
      case 'distanceM': {
        const formatted = formatKilometres(value);
        if (formatted != null) result.distance = formatted;
        break;
      }
      case 'paceMinPerKm': {
        const formatted = formatPaceMinPerKm(value);
        if (formatted != null) result.pace = `${formatted} /km`;
        break;
      }
      case 'elevationGainM': {
        const n = roundInteger(value);
        if (n != null) result[key] = `${n} m`;
        break;
      }
      default:
        result[key] = value;
    }
  }
  return result;
}

/** `minutes`→`duration`; each `stages.{core,deep,rem,awake}` through formatMinutes. Everything else passes through verbatim. */
function formatSleepInput(input: unknown): unknown {
  if (!isPlainObject(input)) return input;
  const result: Rec = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'minutes') {
      const formatted = formatMinutes(value);
      if (formatted != null) result.duration = formatted;
      continue;
    }
    if (key === 'stages' && isPlainObject(value)) {
      result.stages = formatSleepStages(value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function formatSleepStages(stages: Rec): Rec {
  const result: Rec = {};
  for (const [key, value] of Object.entries(stages)) {
    if (SLEEP_STAGE_KEYS.has(key)) {
      const formatted = formatMinutes(value);
      if (formatted != null) result[key] = formatted;
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * `availableContext.metrics[]` metric-name table — matches the rounding
 * already used in lib/brain/whoopContext.ts so the two prompts agree.
 */
function formatMetricValue(metric: string, value: unknown): unknown {
  if (INTEGER_METRICS.has(metric)) return roundInteger(value);
  if (ROUND_TO_1DP_METRICS.has(metric)) return roundTo(value, 1);
  if (FORMAT_MINUTES_METRICS.has(metric)) return formatMinutes(value);
  return roundTo(value, 1);
}

function formatMetricRow(row: unknown): unknown {
  if (!isPlainObject(row) || typeof row.metric !== 'string' || !('value' in row)) return row;
  const result: Rec = { ...row };
  const formatted = formatMetricValue(row.metric, row.value);
  if (formatted == null) delete result.value;
  else result.value = formatted;
  return result;
}

/**
 * `availableContext.baselines[].stats` — recursive round-to-1dp preserving
 * `null` leaves verbatim (lib/brain/baselines.ts:59-66 writes `null` for an
 * absent window; that must never become `0`). Leaf-agnostic on purpose:
 * `{mean7,mean30,sd30,p25...}` is metric-agnostic, serving HRV in ms and
 * steps as a count from the same shape.
 */
function roundNumericLeaves(stats: Rec, decimals: number): Rec {
  const result: Rec = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value === null) result[key] = null;
    else if (typeof value === 'number') result[key] = roundTo(value, decimals);
    else if (isPlainObject(value)) result[key] = roundNumericLeaves(value, decimals);
    else result[key] = value;
  }
  return result;
}

function formatBaselineRow(row: unknown): unknown {
  if (!isPlainObject(row) || !isPlainObject(row.stats)) return row;
  return { ...row, stats: roundNumericLeaves(row.stats, 1) };
}

function formatAvailableContext(context: unknown): unknown {
  if (!isPlainObject(context)) return context;
  const result: Rec = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === 'metrics' && Array.isArray(value)) { result.metrics = value.map(formatMetricRow); continue; }
    if (key === 'baselines' && Array.isArray(value)) { result.baselines = value.map(formatBaselineRow); continue; }
    result[key] = value;
  }
  return result;
}

/**
 * Builds a fresh, formatted `ProactiveAnalysisSource` — never mutates `source`
 * or anything nested in it. Non-mutation is load-bearing: `source.input` is
 * the same object reference later handed to `fallbackAnalysis`
 * (lib/proactiveHealthWorker.ts) and `analysisAlert`
 * (lib/proactiveHealthWorkerSupport.ts), and it is the row
 * lib/proactiveHealthHttp.ts serves to the iOS metrics card.
 */
export function formatAnalysisSource(source: ProactiveAnalysisSource): ProactiveAnalysisSource {
  return {
    kind: source.kind,
    date: source.date,
    input: source.kind === 'workout' ? formatWorkoutInput(source.input) : formatSleepInput(source.input),
    availableContext: formatAvailableContext(source.availableContext),
  };
}
