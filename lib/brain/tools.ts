/**
 * Vital Brain — tool definitions + executors
 *
 * Anthropic tool definitions for the coach loop + deterministic executor
 * functions backed by Drizzle. All math is computed in code, never by the LLM.
 *
 * Tool inventory:
 *   query_events       — read events table by type + date range
 *   query_ontology     — read nodes/edges
 *   calculate_macros   — deterministic TDEE + macro split (no LLM math)
 *   propose_fact       — create a pending fact for explicit confirmation
 *   remember_fact      — legacy direct ontology write (not specialist-allowed)
 *   confirm_fact       — resolve a pending_fact to confirmed/rejected
 *   log_meal           — nutrition lookup → meal_logged event
 *   get_metric_trend   — daily_metrics trend + mean/min/max + baseline direction
 *   get_sleep_summary  — nightly sleep minutes + stages + consistency
 *   get_workouts       — workout list from the workouts metric payload
 *   get_baseline       — baselines row for one metric
 *   compare_periods    — current vs. offset period means + delta
 *
 * Design rule (Phase 3): the coach prompt carries only small durable facts
 * (profile, baselines snapshot, calibration, today's numbers — see context.ts).
 * All time-series health data is tool-only — the five data tools above
 * (get_metric_trend, get_sleep_summary, get_workouts, get_baseline,
 * compare_periods) are the only way the coach reads daily_metrics/baselines.
 * The plain query-helper functions below are exported so other server code
 * (e.g. lib/brain/brief.ts) can reuse the same aggregation instead of
 * duplicating it.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { db, schema } from '@/db';
import { eq, and, gte, lt, asc, desc } from 'drizzle-orm';
import { lookupNutrition } from '@/lib/nutritionix';
import { lookupBarcode } from '@/lib/openFoodFacts';
import type { BaselineStats } from '@/lib/brain/baselines';
import { applyDietBudgetUpdate, splitMacrosForKcal } from '@/lib/brain/dietBudget';

// ── Tool definitions (Anthropic API schema) ────────────────────────────────

export const BRAIN_TOOLS: Tool[] = [
  {
    name: 'query_events',
    description:
      'Query the user\'s event ledger for a specific event type over a date range. ' +
      'Returns JSON array of { timestamp, payload } objects ordered newest first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description:
            'Event type to filter. Known types: hrv_reading, sleep_session, ' +
            'workout_completed, steps_recorded, meal_logged, weight_logged, lab_result.',
        },
        rangeDays: {
          type: 'number',
          description: 'How many days back to search (1 = today only, 7 = last week, etc.).',
        },
      },
      required: ['type', 'rangeDays'],
    },
  },
  {
    name: 'query_ontology',
    description:
      'Query the user\'s ontology (structured facts: goals, allergies, conditions, ' +
      'preferences, medications, injuries). Optionally filter by node type or label.',
    input_schema: {
      type: 'object' as const,
      properties: {
        nodeType: {
          type: 'string',
          description:
            'Optional node type to filter. Valid types: Person, Condition, Medication, ' +
            'Allergy, Intolerance, Goal, Habit, FoodPreference, Cuisine, PantryItem, ' +
            'LabMarker, Injury, FamilyHistory.',
        },
        labelContains: {
          type: 'string',
          description: 'Optional substring to filter node labels (case-insensitive).',
        },
      },
      required: [],
    },
  },
  {
    name: 'calculate_macros',
    description:
      'Deterministic TDEE and macro calculation. Inputs: user\'s goal, weight, ' +
      'and today\'s workouts. Returns daily calorie target + macro grams (C/P/F). ' +
      'Always use this for numbers — never compute macros from context text.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string',
          enum: ['weight_loss', 'muscle', 'endurance', 'general'],
          description: 'The user\'s primary nutrition goal.',
        },
        weightKg: {
          type: 'number',
          description: 'User\'s current body weight in kilograms.',
        },
        todayWorkouts: {
          type: 'array',
          description: 'Workouts completed today. Provide an empty array if none.',
          items: {
            type: 'object',
            properties: {
              type:        { type: 'string', description: 'e.g. running, cycling, strength, walk' },
              distanceKm:  { type: 'number', description: 'Distance in km (optional).' },
              durationMin: { type: 'number', description: 'Duration in minutes (optional).' },
              calories:    { type: 'number', description: 'Active calories if known (overrides estimate).' },
            },
            required: ['type'],
          },
        },
      },
      required: ['goal', 'weightKg', 'todayWorkouts'],
    },
  },
  {
    name: 'update_diet_budget',
    description:
      'Change the user\'s saved daily calorie/macro budget — the same budget both the ' +
      'app and this coach read for "how am I doing today" and meal-planning. Macros ' +
      'are NOT a param: they are computed server-side from the goal, never set by hand. ' +
      'ALWAYS propose the specific change in chat and get the user\'s explicit agreement ' +
      'BEFORE calling this tool — never call it silently. Use mode:\'custom\' with ' +
      'targetKcal to pin a specific number, or mode:\'auto\' to reset to the ' +
      'auto-calculated budget.',
    input_schema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['auto', 'custom'],
          description: '\'custom\' pins targetKcal (+ derived macros); \'auto\' clears the pin.',
        },
        goal: {
          type: 'string',
          enum: ['weight_loss', 'muscle', 'endurance', 'general'],
          description: 'Optional — update the user\'s nutrition goal alongside the budget.',
        },
        targetKcal: {
          type: 'number',
          description: 'Required when mode is \'custom\'. The new pinned daily calorie target.',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'propose_fact',
    description:
      'Propose a structured fact for the user to confirm or reject before it is persisted ' +
      'to the ontology. This only creates a pending proposal; it never writes a confirmed fact.',
    input_schema: {
      type: 'object' as const,
      properties: {
        nodeType: {
          type: 'string',
          description:
            'Node type. One of: Condition, Medication, Allergy, Intolerance, Goal, ' +
            'Habit, FoodPreference, Cuisine, PantryItem, LabMarker, Injury, FamilyHistory.',
        },
        label: {
          type: 'string',
          description: 'Short label for the proposed fact.',
        },
        evidence: {
          type: 'string',
          description: 'The exact user quote or signal that surfaced this proposal.',
        },
      },
      required: ['nodeType', 'label', 'evidence'],
    },
  },
  {
    name: 'remember_fact',
    description:
      'Persist a new fact about the user to the ontology. Use when the user reveals ' +
      'an allergy, condition, medication, goal, food preference, or any other ' +
      'structured fact worth remembering permanently. Creates a node (weight 0.6).',
    input_schema: {
      type: 'object' as const,
      properties: {
        nodeType: {
          type: 'string',
          description:
            'Node type. One of: Condition, Medication, Allergy, Intolerance, Goal, ' +
            'Habit, FoodPreference, Cuisine, PantryItem, LabMarker, Injury, FamilyHistory.',
        },
        label: {
          type: 'string',
          description: 'Short label for the fact, e.g. "Peanut allergy" or "Marathon runner".',
        },
        evidence: {
          type: 'string',
          description: 'The exact user quote or signal that surfaced this fact.',
        },
        linksTo: {
          type: 'string',
          description:
            'Optional label of an existing node to create an edge to. ' +
            'E.g. if remembering an Injury, linksTo might be the activity it affects.',
        },
      },
      required: ['nodeType', 'label', 'evidence'],
    },
  },
  {
    name: 'confirm_fact',
    description:
      'Resolve a pending fact (confirm or reject). Use when the user explicitly ' +
      'confirms or denies a fact the coach proposed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        factId: {
          type: 'string',
          description: 'UUID of the pending_fact row to resolve.',
        },
        action: {
          type: 'string',
          enum: ['confirm', 'reject'],
          description: 'Whether to confirm (promote to ontology) or reject the fact.',
        },
      },
      required: ['factId', 'action'],
    },
  },
  {
    name: 'log_meal',
    description:
      'Look up nutrition for a food description or barcode and write a meal_logged ' +
      'event to the database. Use when the user reports eating something.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description:
            'Food description (e.g. "200g grilled chicken and rice") or a barcode ' +
            'number (all digits, e.g. "0123456789"). The tool auto-detects which.',
        },
        grams: {
          type: 'number',
          description:
            'Optional serving size override in grams (only applies when text is a barcode).',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_metric_trend',
    description:
      'Get the daily trend for a single HealthKit metric over a date range, with ' +
      'mean/min/max and a direction call vs. the user\'s 30-day baseline. Use this ' +
      'whenever the user asks how a metric "has been" — never invent numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: {
          type: 'string',
          description:
            'One of: hrv_sdnn, resting_hr, hr_avg, steps, active_energy_kcal, ' +
            'body_mass_kg, sleep_minutes.',
        },
        days: {
          type: 'number',
          description: 'How many days back to look (max 90).',
        },
      },
      required: ['metric', 'days'],
    },
  },
  {
    name: 'get_sleep_summary',
    description:
      'Get nightly sleep minutes + stage breakdown for the last N days, plus a ' +
      'consistency read (standard deviation of nightly minutes). Use for any ' +
      'question about sleep duration, quality, or regularity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          description: 'How many nights back to look (max 30).',
        },
      },
      required: ['days'],
    },
  },
  {
    name: 'get_workouts',
    description:
      'List the user\'s logged workouts over the last N days (type, duration, ' +
      'calories, etc., as captured from HealthKit). Use for any question about ' +
      'training history or recent sessions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          description: 'How many days back to look (max 30).',
        },
      },
      required: ['days'],
    },
  },
  {
    name: 'get_baseline',
    description:
      'Get the current baseline stats (7/30/60-day means, sd, percentiles) for a ' +
      'single metric, plus whether it\'s established (>= 14 days of data) and how ' +
      'many days of data back it. Use to ground any claim about "normal for you".',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: {
          type: 'string',
          description:
            'One of: hrv_sdnn, resting_hr, hr_avg, steps, active_energy_kcal, ' +
            'body_mass_kg, sleep_minutes, workouts.',
        },
      },
      required: ['metric'],
    },
  },
  {
    name: 'compare_periods',
    description:
      'Compare a metric\'s mean over a recent period against an earlier period of ' +
      'the same length (e.g. this week vs. last week). Use for any "vs last week" / ' +
      '"has this gotten better/worse" question.',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: {
          type: 'string',
          description:
            'One of: hrv_sdnn, resting_hr, hr_avg, steps, active_energy_kcal, ' +
            'body_mass_kg, sleep_minutes.',
        },
        periodDays: {
          type: 'number',
          description: 'Length of each period in days (max 30). E.g. 7 for week-over-week.',
        },
        offsetDays: {
          type: 'number',
          description:
            'How many days back the earlier period starts, relative to today. ' +
            'Usually equal to periodDays (e.g. 7/7 = this week vs. the week before).',
        },
      },
      required: ['metric', 'periodDays', 'offsetDays'],
    },
  },
];

// ── Deterministic macro math ──────────────────────────────────────────────────

export interface WorkoutInput {
  type: string;
  distanceKm?: number;
  durationMin?: number;
  calories?: number;
}

export function estimateTDEE(weightKg: number, workouts: WorkoutInput[]): number {
  // Mifflin-St Jeor for 175 cm, 30-year-old male (profile defaults)
  const bmr = 10 * weightKg + 6.25 * 175 - 5 * 30 + 5;
  let tdee = bmr * 1.3; // lightly-active base

  for (const w of workouts) {
    if (w.calories != null && w.calories > 0) {
      tdee += w.calories;
      continue;
    }
    const t = w.type.toLowerCase();
    const durMin = w.durationMin ?? 0;
    const distKm = w.distanceKm ?? 0;

    if (t.includes('run')) {
      tdee += distKm > 0 ? weightKg * distKm * 1.0 : durMin * 11;
    } else if (t.includes('cycl') || t.includes('bike')) {
      tdee += distKm > 0 ? weightKg * distKm * 0.5 : durMin * 8;
    } else if (t.includes('swim')) {
      tdee += durMin * 9;
    } else if (
      t.includes('strength') || t.includes('gym') ||
      t.includes('weight') || t.includes('lift')
    ) {
      tdee += durMin * 4;
    } else if (t.includes('walk') || t.includes('hike')) {
      tdee += distKm > 0 ? weightKg * distKm * 0.5 : durMin * 4;
    } else {
      tdee += durMin * 6; // generic activity
    }
  }

  return Math.round(tdee);
}

export function macrosForGoal(
  goal: string,
  weightKg: number,
  tdee: number,
): { targetCal: number; c: number; p: number; f: number } {
  let targetCal: number;

  switch (goal) {
    case 'weight_loss':
      targetCal = tdee - 400;
      break;
    case 'muscle':
      targetCal = tdee + 200;
      break;
    case 'endurance':
      targetCal = tdee + 100;
      break;
    default: // 'general'
      targetCal = tdee;
  }

  // Ratio table (protein-g/kg + fat-fraction per goal) lives in dietBudget.ts
  // so the auto TDEE-derived split and the coach's custom-kcal split stay identical.
  const { protein: p, carbs: c, fat: f } = splitMacrosForKcal(goal, weightKg, targetCal);

  return { targetCal: Math.round(targetCal), c, p, f };
}

// ── Ontology helper ────────────────────────────────────────────────────────────

function predicateFor(nodeType: string): string {
  const map: Record<string, string> = {
    Condition:      'has_condition',
    Allergy:        'has_allergy',
    Intolerance:    'has_intolerance',
    Medication:     'takes_medication',
    FamilyHistory:  'has_family_member',
    Goal:           'has_goal',
    Habit:          'has_habit',
    FoodPreference: 'prefers',
    Cuisine:        'prefers',
    PantryItem:     'contains_ingredient',
    Injury:         'blocks_activity',
    LabMarker:      'last_value',
  };
  return map[nodeType] ?? 'related_to';
}

// ── Metric label helper (shared: tool_call SSE labels + prompt formatting) ────

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

const EVENT_TYPE_LABELS: Record<string, string> = {
  hrv_reading:        'HRV readings',
  sleep_session:      'sleep sessions',
  workout_completed:  'workouts',
  steps_recorded:     'step counts',
  meal_logged:        'meals',
  weight_logged:      'weight logs',
};

/** Human label for an in-flight tool call, surfaced via SSE tool_call events. */
export function toolCallLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'query_events':
      return `Checking your ${EVENT_TYPE_LABELS[String(input.type ?? '')] ?? 'recent activity'}…`;
    case 'query_ontology':
      return 'Looking up what I know about you…';
    case 'calculate_macros':
      return 'Crunching your macros…';
    case 'update_diet_budget':
      return 'Updating your diet budget…';
    case 'remember_fact':
      return 'Remembering that…';
    case 'propose_fact':
      return 'Preparing that for your confirmation…';
    case 'confirm_fact':
      return 'Updating that…';
    case 'log_meal':
      return 'Logging your meal…';
    case 'get_metric_trend':
      return `Checking your ${metricLabel(String(input.metric ?? ''))} trend…`;
    case 'get_sleep_summary':
      return 'Looking at your sleep…';
    case 'get_workouts':
      return 'Pulling up your workouts…';
    case 'get_baseline':
      return `Checking your ${metricLabel(String(input.metric ?? ''))} baseline…`;
    case 'compare_periods':
      return 'Comparing periods…';
    case 'read_memory':
      return 'Checking my notes on you…';
    case 'write_memory':
      return 'Saving that…';
    case 'append_observation':
      return 'Jotting that down…';
    default:
      return 'Working on it…';
  }
}

// ── daily_metrics / baselines query helpers ────────────────────────────────────
// Plain functions (no Anthropic tool binding) so both the tool executor below
// and lib/brain/brief.ts can share one aggregation implementation.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

export interface MetricPoint {
  date:  string;
  value: number;
}

/** Raw daily_metrics rows (date, value) for one metric over the trailing window. */
export async function queryMetricPoints(
  userId: string,
  metric: string,
  days: number,
): Promise<MetricPoint[]> {
  const since = isoDateDaysAgo(days);
  const rows = await db
    .select({ date: schema.daily_metrics.date, value: schema.daily_metrics.value })
    .from(schema.daily_metrics)
    .where(
      and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, metric),
        gte(schema.daily_metrics.date, since),
      ),
    )
    .orderBy(asc(schema.daily_metrics.date));

  return rows.map(r => ({ date: r.date, value: r.value }));
}

export interface BaselineSnapshot {
  metric:      string;
  stats:       BaselineStats | null;
  established: boolean;
  dataDays:    number;
}

/** Single (user, metric) row from `baselines`, or null if none exists yet. */
export async function queryBaseline(
  userId: string,
  metric: string,
): Promise<BaselineSnapshot | null> {
  const [row] = await db
    .select({
      stats:       schema.baselines.stats,
      established: schema.baselines.established,
      data_days:   schema.baselines.data_days,
    })
    .from(schema.baselines)
    .where(and(eq(schema.baselines.user_id, userId), eq(schema.baselines.metric, metric)))
    .limit(1);

  if (!row) return null;
  return {
    metric,
    stats:       row.stats as BaselineStats | null,
    established: row.established,
    dataDays:    row.data_days,
  };
}

/** All baseline rows for a user — used for the small context.ts snapshot. */
export async function queryAllBaselines(userId: string): Promise<BaselineSnapshot[]> {
  const rows = await db
    .select({
      metric:      schema.baselines.metric,
      stats:       schema.baselines.stats,
      established: schema.baselines.established,
      data_days:   schema.baselines.data_days,
    })
    .from(schema.baselines)
    .where(eq(schema.baselines.user_id, userId));

  return rows.map(r => ({
    metric:      r.metric,
    stats:       r.stats as BaselineStats | null,
    established: r.established,
    dataDays:    r.data_days,
  }));
}

export interface MetricTrend {
  metric:     string;
  days:       number;
  points:     MetricPoint[];
  stats:      { mean: number | null; min: number | null; max: number | null };
  baseline:   { mean30: number | null; established: boolean } | null;
  direction:  'above' | 'below' | 'similar' | 'unknown';
}

export async function queryMetricTrend(
  userId: string,
  metric: string,
  days: number,
): Promise<MetricTrend> {
  const clampedDays = Math.max(1, Math.min(90, Math.round(days)));

  const [points, baseline] = await Promise.all([
    queryMetricPoints(userId, metric, clampedDays),
    queryBaseline(userId, metric),
  ]);

  const values = points.map(p => p.value);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const min  = values.length ? Math.min(...values) : null;
  const max  = values.length ? Math.max(...values) : null;

  let direction: MetricTrend['direction'] = 'unknown';
  const baselineMean = baseline?.stats?.mean30 ?? null;
  if (mean != null && baselineMean != null && baselineMean !== 0) {
    const pctDiff = (mean - baselineMean) / baselineMean;
    direction = pctDiff > 0.05 ? 'above' : pctDiff < -0.05 ? 'below' : 'similar';
  }

  return {
    metric,
    days: clampedDays,
    points,
    stats: {
      mean: mean != null ? round2(mean) : null,
      min,
      max,
    },
    baseline: baseline
      ? { mean30: baseline.stats?.mean30 ?? null, established: baseline.established }
      : null,
    direction,
  };
}

export interface SleepNight {
  date:    string;
  minutes: number;
  stages:  unknown;
}

export interface SleepSummary {
  days:        number;
  nights:      SleepNight[];
  meanMinutes: number | null;
  sd:          number | null;
  consistency: 'consistent' | 'variable' | 'unknown';
}

export async function querySleepSummary(userId: string, days: number): Promise<SleepSummary> {
  const clampedDays = Math.max(1, Math.min(30, Math.round(days)));
  const since = isoDateDaysAgo(clampedDays);

  const rows = await db
    .select({
      date:    schema.daily_metrics.date,
      value:   schema.daily_metrics.value,
      payload: schema.daily_metrics.payload,
    })
    .from(schema.daily_metrics)
    .where(
      and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, 'sleep_minutes'),
        gte(schema.daily_metrics.date, since),
      ),
    )
    .orderBy(asc(schema.daily_metrics.date));

  const nights: SleepNight[] = rows.map(r => ({ date: r.date, minutes: r.value, stages: r.payload }));
  const minutesArr = nights.map(n => n.minutes);

  const meanMinutes = minutesArr.length
    ? minutesArr.reduce((a, b) => a + b, 0) / minutesArr.length
    : null;

  let sd: number | null = null;
  if (minutesArr.length > 1 && meanMinutes != null) {
    const variance =
      minutesArr.reduce((s, v) => s + (v - meanMinutes) ** 2, 0) / (minutesArr.length - 1);
    sd = Math.sqrt(variance);
  }

  const consistency: SleepSummary['consistency'] =
    sd == null ? 'unknown' : sd < 30 ? 'consistent' : 'variable';

  return {
    days: clampedDays,
    nights,
    meanMinutes: meanMinutes != null ? round2(meanMinutes) : null,
    sd: sd != null ? round2(sd) : null,
    consistency,
  };
}

export interface WorkoutEntry {
  date: string;
  [key: string]: unknown;
}

export async function queryWorkouts(userId: string, days: number): Promise<WorkoutEntry[]> {
  const clampedDays = Math.max(1, Math.min(30, Math.round(days)));
  const since = isoDateDaysAgo(clampedDays);

  const rows = await db
    .select({ date: schema.daily_metrics.date, payload: schema.daily_metrics.payload })
    .from(schema.daily_metrics)
    .where(
      and(
        eq(schema.daily_metrics.user_id, userId),
        eq(schema.daily_metrics.metric, 'workouts'),
        gte(schema.daily_metrics.date, since),
      ),
    )
    .orderBy(desc(schema.daily_metrics.date));

  const workouts: WorkoutEntry[] = [];
  for (const row of rows) {
    const list = Array.isArray(row.payload) ? (row.payload as Record<string, unknown>[]) : [];
    for (const w of list) workouts.push({ date: row.date, ...w });
  }
  return workouts;
}

export interface PeriodComparison {
  metric:     string;
  periodDays: number;
  offsetDays: number;
  current:    { mean: number | null; days: number };
  previous:   { mean: number | null; days: number };
  delta:      number | null;
  deltaPct:   number | null;
}

export async function queryComparePeriods(
  userId: string,
  metric: string,
  periodDays: number,
  offsetDays: number,
): Promise<PeriodComparison> {
  const clampedPeriod = Math.max(1, Math.min(30, Math.round(periodDays)));
  const clampedOffset = Math.max(1, Math.round(offsetDays) || clampedPeriod);

  const currentSince  = isoDateDaysAgo(clampedPeriod);
  const previousUntil = isoDateDaysAgo(clampedOffset);
  const previousSince = isoDateDaysAgo(clampedOffset + clampedPeriod);

  const [currentRows, previousRows] = await Promise.all([
    db
      .select({ value: schema.daily_metrics.value })
      .from(schema.daily_metrics)
      .where(
        and(
          eq(schema.daily_metrics.user_id, userId),
          eq(schema.daily_metrics.metric, metric),
          gte(schema.daily_metrics.date, currentSince),
        ),
      ),
    db
      .select({ value: schema.daily_metrics.value })
      .from(schema.daily_metrics)
      .where(
        and(
          eq(schema.daily_metrics.user_id, userId),
          eq(schema.daily_metrics.metric, metric),
          gte(schema.daily_metrics.date, previousSince),
          lt(schema.daily_metrics.date, previousUntil),
        ),
      ),
  ]);

  const currentVals  = currentRows.map(r => r.value);
  const previousVals = previousRows.map(r => r.value);

  const currentMean = currentVals.length
    ? currentVals.reduce((a, b) => a + b, 0) / currentVals.length
    : null;
  const previousMean = previousVals.length
    ? previousVals.reduce((a, b) => a + b, 0) / previousVals.length
    : null;

  const delta =
    currentMean != null && previousMean != null ? currentMean - previousMean : null;
  const deltaPct =
    delta != null && previousMean ? (delta / previousMean) * 100 : null;

  return {
    metric,
    periodDays: clampedPeriod,
    offsetDays: clampedOffset,
    current:  { mean: currentMean != null ? round2(currentMean) : null, days: currentVals.length },
    previous: { mean: previousMean != null ? round2(previousMean) : null, days: previousVals.length },
    delta: delta != null ? round2(delta) : null,
    deltaPct: deltaPct != null ? round2(deltaPct) : null,
  };
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  userId: string,
): Promise<string> {
  // ── query_events ──────────────────────────────────────────────────────────
  if (name === 'query_events') {
    const type      = String(input.type ?? '');
    const rangeDays = Math.max(1, Math.min(90, Number(input.rangeDays ?? 7)));

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - rangeDays);

    const rows = await db
      .select({ timestamp: schema.events.timestamp, payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.user_id, userId),
          eq(schema.events.type, type),
          gte(schema.events.timestamp, since),
        ),
      )
      .orderBy(desc(schema.events.timestamp))
      .limit(100);

    return JSON.stringify(rows);
  }

  // ── query_ontology ────────────────────────────────────────────────────────
  if (name === 'query_ontology') {
    const nodeType     = input.nodeType != null ? String(input.nodeType) : null;
    const labelContains = input.labelContains != null ? String(input.labelContains).toLowerCase() : null;

    let rows = await db
      .select()
      .from(schema.nodes)
      .where(eq(schema.nodes.user_id, userId))
      .orderBy(desc(schema.nodes.weight));

    if (nodeType) rows = rows.filter(n => n.type === nodeType);
    if (labelContains) rows = rows.filter(n => n.label.toLowerCase().includes(labelContains));

    return JSON.stringify(rows);
  }

  // ── calculate_macros ──────────────────────────────────────────────────────
  if (name === 'calculate_macros') {
    const goal     = String(input.goal ?? 'general');
    const weightKg = Number(input.weightKg ?? 70);
    const workouts = Array.isArray(input.todayWorkouts)
      ? (input.todayWorkouts as WorkoutInput[])
      : [];

    const tdee = estimateTDEE(weightKg, workouts);
    const { targetCal, c, p, f } = macrosForGoal(goal, weightKg, tdee);

    return JSON.stringify({
      tdee,
      targetCal,
      macros: { c, p, f },
      note: `TDEE ${tdee} kcal · goal adjustment → ${targetCal} kcal · ${c}g C / ${p}g P / ${f}g F`,
    });
  }

  // ── update_diet_budget ────────────────────────────────────────────────────
  if (name === 'update_diet_budget') {
    try {
      const { current } = await applyDietBudgetUpdate(userId, {
        mode:       String(input.mode),
        goal:       input.goal != null ? String(input.goal) : undefined,
        targetKcal: typeof input.targetKcal === 'number' ? input.targetKcal : undefined,
      });
      return JSON.stringify({ ok: true, budget: current });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── propose_fact ──────────────────────────────────────────────────────────
  if (name === 'propose_fact') {
    const proposal = buildPendingFactProposal(input, userId);
    if (!String(input.label ?? '')) return 'Error: label is required.';

    const [pending] = await db
      .insert(schema.pending_facts)
      .values(proposal)
      .returning({ id: schema.pending_facts.id });

    return JSON.stringify({ ok: true, factId: pending.id, status: 'pending' });
  }

  // ── remember_fact ─────────────────────────────────────────────────────────
  if (name === 'remember_fact') {
    const nodeType = String(input.nodeType ?? 'Habit');
    const label    = String(input.label ?? '');
    const evidence = String(input.evidence ?? '');
    const linksTo  = input.linksTo != null ? String(input.linksTo) : null;

    if (!label) return 'Error: label is required.';

    // Insert the new node with weight 0.6 (coach-proposed)
    const [newNode] = await db
      .insert(schema.nodes)
      .values({
        user_id:    userId,
        type:       nodeType,
        label,
        properties: { evidence },
        source:     'coach',
        weight:     0.6,
      })
      .returning({ id: schema.nodes.id });

    // Optionally link to an existing node whose label matches linksTo
    if (linksTo) {
      const allNodes = await db
        .select({ id: schema.nodes.id, label: schema.nodes.label })
        .from(schema.nodes)
        .where(eq(schema.nodes.user_id, userId));

      const toNode = allNodes.find(
        n => n.label.toLowerCase() === linksTo.toLowerCase(),
      );

      if (toNode) {
        await db.insert(schema.edges).values({
          user_id:   userId,
          from_node: newNode.id,
          to_node:   toNode.id,
          predicate: predicateFor(nodeType),
          source:    'coach',
          weight:    0.6,
        });
      }
    }

    return JSON.stringify({ ok: true, nodeId: newNode.id, label, nodeType });
  }

  // ── confirm_fact ──────────────────────────────────────────────────────────
  if (name === 'confirm_fact') {
    const factId = String(input.factId ?? '');
    const action = String(input.action ?? 'confirm') as 'confirm' | 'reject';

    if (!factId) return 'Error: factId is required.';

    const status     = action === 'confirm' ? 'confirmed' : 'rejected';
    const resolvedAt = new Date();

    const [updated] = await db
      .update(schema.pending_facts)
      .set({ status, resolved_at: resolvedAt })
      .where(eq(schema.pending_facts.id, factId))
      .returning({ id: schema.pending_facts.id, proposed_node: schema.pending_facts.proposed_node });

    if (!updated) return `No pending_fact found with id ${factId}.`;

    // If confirmed, promote the proposed node/edge to the ontology
    if (action === 'confirm' && updated.proposed_node) {
      const proposed = updated.proposed_node as Record<string, unknown>;
      await db.insert(schema.nodes).values({
        user_id:    userId,
        type:       String(proposed.type ?? 'Habit'),
        label:      String(proposed.label ?? ''),
        properties: proposed.properties as Record<string, unknown> | null,
        source:     'confirmed',
        weight:     0.9,
      }).onConflictDoNothing();
    }

    return JSON.stringify({ ok: true, factId, status });
  }

  // ── log_meal ──────────────────────────────────────────────────────────────
  if (name === 'log_meal') {
    const text  = String(input.text ?? '');
    const grams = input.grams != null ? Number(input.grams) : null;

    if (!text) return 'Error: text is required.';

    // Barcode path: all digits (8–14 chars)
    if (/^\d{8,14}$/.test(text.trim())) {
      const product = await lookupBarcode(text.trim());
      if (!product) return `Barcode ${text} not found in Open Food Facts.`;

      const servingG  = grams ?? 100;
      const factor    = servingG / 100;
      const kcal      = Math.round(product.per100g.kcal * factor);
      const c         = Math.round(product.per100g.c    * factor);
      const p         = Math.round(product.per100g.p    * factor);
      const f         = Math.round(product.per100g.f    * factor);

      await db.insert(schema.events).values({
        user_id:   userId,
        timestamp: new Date(),
        type:      'meal_logged',
        payload:   { kcal, c, p, f, description: `${product.productName} ${servingG}g`, source: 'barcode' },
        source:    'coach',
      });

      return JSON.stringify({
        ok: true,
        product: product.productName,
        servingG,
        kcal, c, p, f,
      });
    }

    // Text/description path — CalorieNinjas lookup
    const nutrition = await lookupNutrition(text);
    if (!nutrition) {
      return `Could not find nutrition data for "${text}". Try being more specific, e.g. "200g grilled chicken breast".`;
    }

    await db.insert(schema.events).values({
      user_id:   userId,
      timestamp: new Date(),
      type:      'meal_logged',
      payload:   {
        kcal:        nutrition.kcal,
        c:           nutrition.c,
        p:           nutrition.p,
        f:           nutrition.f,
        description: text,
        items:       nutrition.foods.map(fd => `${fd.qty}${fd.unit} ${fd.name}`).join(', '),
        source:      'calorieninjas',
      },
      source: 'coach',
    });

    return JSON.stringify({
      ok: true,
      query: text,
      kcal: nutrition.kcal,
      c: nutrition.c,
      p: nutrition.p,
      f: nutrition.f,
      foods: nutrition.foods,
    });
  }

  // ── get_metric_trend ──────────────────────────────────────────────────────
  if (name === 'get_metric_trend') {
    const metric = String(input.metric ?? '');
    const days   = Number(input.days ?? 7);
    if (!metric) return 'Error: metric is required.';

    return JSON.stringify(await queryMetricTrend(userId, metric, days));
  }

  // ── get_sleep_summary ─────────────────────────────────────────────────────
  if (name === 'get_sleep_summary') {
    const days = Number(input.days ?? 7);
    return JSON.stringify(await querySleepSummary(userId, days));
  }

  // ── get_workouts ──────────────────────────────────────────────────────────
  if (name === 'get_workouts') {
    const days = Number(input.days ?? 7);
    return JSON.stringify(await queryWorkouts(userId, days));
  }

  // ── get_baseline ──────────────────────────────────────────────────────────
  if (name === 'get_baseline') {
    const metric = String(input.metric ?? '');
    if (!metric) return 'Error: metric is required.';

    const baseline = await queryBaseline(userId, metric);
    return JSON.stringify(
      baseline ?? { metric, stats: null, established: false, dataDays: 0 },
    );
  }

  // ── compare_periods ───────────────────────────────────────────────────────
  if (name === 'compare_periods') {
    const metric     = String(input.metric ?? '');
    const periodDays = Number(input.periodDays ?? 7);
    const offsetDays = Number(input.offsetDays ?? periodDays);
    if (!metric) return 'Error: metric is required.';

    return JSON.stringify(await queryComparePeriods(userId, metric, periodDays, offsetDays));
  }

  return `Unknown tool: ${name}`;
}

export function buildPendingFactProposal(
  input: Record<string, unknown>,
  userId: string,
): typeof schema.pending_facts.$inferInsert {
  const evidence = String(input.evidence ?? '');
  return {
    user_id: userId,
    proposed_node: {
      type: String(input.nodeType ?? 'Habit'),
      label: String(input.label ?? ''),
      properties: { evidence },
    },
    proposed_edge: null,
    evidence,
    salience: 0.6,
    status: 'pending',
  };
}
