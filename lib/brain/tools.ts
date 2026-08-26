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
 *   resolve_fact       — retract a confirmed node (status → 'resolved'; never deletes;
 *                        not specialist-allowed)
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
import { eq, and, gte, gt, lt, asc, desc, inArray, sql } from 'drizzle-orm';
import { lookupBarcode } from '@/lib/openFoodFacts';
import { searchCandidates, type Candidate } from '@/lib/nutrition/candidates';
import type { BaselineStats } from '@/lib/brain/baselines';
import { applyDietBudgetUpdate, splitMacrosForKcal, DEFAULT_WEIGHT_KG } from '@/lib/brain/dietBudget';
import { readMemoryFile } from '@/lib/memory';
import { parseProfileDetails } from '@/lib/profileDetails';

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
              distanceKm:  { type: 'number', description: 'Distance in km — convert from miles if the user speaks imperial.' },
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
    name: 'resolve_fact',
    description:
      'Retract a confirmed fact that no longer applies — e.g. an injury that healed, a ' +
      'condition that resolved, a medication that was stopped, an allergy the user has ' +
      'outgrown. This is the ONLY way to retract a fact; it marks the node resolved, it ' +
      'never deletes it, and the change is reversible. Use whenever the user states a ' +
      'previously recorded fact is no longer true. Do not create a new node for this — ' +
      'always resolve the existing one.',
    input_schema: {
      type: 'object' as const,
      properties: {
        label: {
          type: 'string',
          description:
            'Label of the existing fact to resolve, e.g. "Adductor injury". Matched ' +
            'case-insensitively against the user\'s active ontology nodes. Provide this ' +
            'or id.',
        },
        id: {
          type: 'string',
          description:
            'Optional UUID of the node to resolve, if already known (e.g. from a prior ' +
            'query_ontology call). Takes priority over label when both are given.',
        },
        evidence: {
          type: 'string',
          description: 'The exact user quote confirming the fact no longer applies.',
        },
      },
      required: ['evidence'],
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
  {
    name: 'get_schedule',
    description:
      'Get the user\'s synced calendar busy blocks (times + titles only — never ' +
      'locations, attendees, or notes) for a date range, rendered in the user\'s own ' +
      'timezone. Use whenever a question involves timing, planning, or availability — ' +
      'never guess at what\'s on their calendar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate: {
          type: 'string',
          description: 'Optional start date as YYYY-MM-DD. Defaults to today.',
        },
        days: {
          type: 'number',
          description: 'How many days forward to look (1-14, default 3).',
        },
      },
      required: [],
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

export interface Biometrics {
  weightKg: number;
  heightCm: number | null;
  age: number | null;
  biologicalSex: string | null;
  /**
   * Base activity multiplier applied to BMR to get maintenance TDEE, before
   * per-workout calories are added on top. Defaults to 1.3 (today's fixed
   * behavior) when omitted. See `activityMultiplierForFrequency` — the caller
   * (dietBudget.ts) derives this from the user's training frequency.
   */
  activityMultiplier?: number;
}

/**
 * Base (NEAT-only) activity multiplier by self-reported training days/week.
 *
 * Deliberately capped at 1.4, NOT the textbook 1.5-1.55 for "very active" —
 * `estimateTDEE` already adds explicit per-workout calories in the loop
 * below (see the run/cycle/swim/strength/walk branches), so this multiplier
 * must carry ONLY non-exercise daily activity (NEAT). Pushing it to 1.5+
 * would double-count the same training volume once as a higher base
 * multiplier and again as explicit workout kcal. Do not "correct" this
 * upward without also removing (or heavily discounting) the workout loop.
 */
export const ACTIVITY_MULTIPLIER_BY_FREQUENCY: ReadonlyArray<{ maxDays: number; multiplier: number }> = [
  { maxDays: 1, multiplier: 1.2 },
  { maxDays: 3, multiplier: 1.3 },
  { maxDays: 5, multiplier: 1.35 },
  { maxDays: 7, multiplier: 1.4 },
];

/** Fallback base multiplier when frequency is missing/unparseable — today's unchanged behavior. */
export const DEFAULT_ACTIVITY_MULTIPLIER = 1.3;

/**
 * Maps a weekly training-day count to the base (NEAT-only) activity
 * multiplier. Accepts a number or numeric string (iOS sends Int, the
 * training-history.json type says string — this tolerates either), clamps
 * to 0..7, and falls back to DEFAULT_ACTIVITY_MULTIPLIER for anything
 * missing or unparseable.
 */
export function activityMultiplierForFrequency(frequency: unknown): number {
  const raw =
    typeof frequency === 'number' ? frequency :
    typeof frequency === 'string' ? (
      frequency.trim().length === 0 ? NaN : Number(frequency.trim())
    ) :
    NaN;
  if (!Number.isFinite(raw)) return DEFAULT_ACTIVITY_MULTIPLIER;

  const days = Math.min(7, Math.max(0, raw));
  const bucket = ACTIVITY_MULTIPLIER_BY_FREQUENCY.find((b) => days <= b.maxDays);
  return bucket ? bucket.multiplier : DEFAULT_ACTIVITY_MULTIPLIER;
}

/** Fallback height (cm) when the user's profile has none on file. */
export const FALLBACK_HEIGHT_CM = 170;
/** Fallback age (years) when the user's profile has none on file. */
export const FALLBACK_AGE = 35;

/**
 * Normalizes free-text biological sex into the two values the Mifflin-St
 * Jeor sex term needs. Case-insensitive, trimmed; anything unrecognized
 * (including empty/missing) maps to null so callers can apply a sex-neutral
 * fallback instead of silently guessing.
 */
export function normalizeBiologicalSex(sex: string | null): 'male' | 'female' | null {
  if (sex == null) return null;
  const normalized = sex.trim().toLowerCase();
  if (normalized === 'male' || normalized === 'm' || normalized === 'man') return 'male';
  if (normalized === 'female' || normalized === 'f' || normalized === 'woman') return 'female';
  return null;
}

export function estimateTDEE(bio: Biometrics, workouts: WorkoutInput[]): number {
  const { weightKg } = bio;
  const heightCm = bio.heightCm ?? FALLBACK_HEIGHT_CM;
  const age = bio.age ?? FALLBACK_AGE;
  const sex = normalizeBiologicalSex(bio.biologicalSex);

  // Mifflin-St Jeor's sex term is +5 for male, -161 for female — a 166 kcal
  // swing. When sex is unknown, use the midpoint of those two offsets (-78)
  // rather than defaulting to male: defaulting to male would bias every
  // unknown-sex user's BMR ~166 kcal high, over-budgeting calories for
  // roughly half the user base.
  const sexOffset = sex === 'male' ? 5 : sex === 'female' ? -161 : -78;

  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset;
  const activityMultiplier = bio.activityMultiplier ?? DEFAULT_ACTIVITY_MULTIPLIER;
  let tdee = bmr * activityMultiplier; // NEAT-only base — workout kcal added below

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

/**
 * Goal calorie adjustments as a percentage of TDEE rather than a fixed kcal
 * offset. Fixed offsets (-400/+200/+100) were calibrated against a ~2400
 * kcal "typical" TDEE, where -400 is ~17%. Applied to a small woman's
 * ~1500 kcal TDEE that same -400 is ~26% — a much harsher deficit than
 * intended, and one that could undercut her own BMR. As a percentage, the
 * cut scales with the person instead of being a one-size number.
 */
export const GOAL_TDEE_MULTIPLIER: Record<string, number> = {
  weight_loss: 0.85, // -15%
  muscle:      1.08,
  endurance:   1.05,
  general:     1.0,
};

export function macrosForGoal(
  goal: string,
  weightKg: number,
  tdee: number,
): { targetCal: number; c: number; p: number; f: number } {
  const multiplier = GOAL_TDEE_MULTIPLIER[goal] ?? GOAL_TDEE_MULTIPLIER.general;
  const targetCal = tdee * multiplier;

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
    case 'resolve_fact':
      return 'Updating your record…';
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
    case 'get_schedule':
      return 'Checking your schedule…';
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

export interface MetricPointRow extends MetricPoint {
  metric: string;
}

/**
 * Multi-metric raw daily_metrics rows over the trailing window — one SELECT
 * via `inArray` for however many metrics are requested. This is the N+1 fix
 * for the Trends batch endpoint (app/api/trends/route.ts): mirrors
 * queryMetricPoints(), just not pinned to a single metric.
 */
export async function queryMetricPointsMulti(
  userId: string,
  metrics: string[],
  days: number,
): Promise<MetricPointRow[]> {
  if (metrics.length === 0) return [];
  const since = isoDateDaysAgo(days);
  const rows = await db
    .select({
      metric: schema.daily_metrics.metric,
      date:   schema.daily_metrics.date,
      value:  schema.daily_metrics.value,
    })
    .from(schema.daily_metrics)
    .where(
      and(
        eq(schema.daily_metrics.user_id, userId),
        inArray(schema.daily_metrics.metric, metrics),
        gte(schema.daily_metrics.date, since),
      ),
    )
    .orderBy(asc(schema.daily_metrics.date));

  return rows.map(r => ({ metric: r.metric, date: r.date, value: r.value }));
}

export interface MetricDataDaysRow {
  metric:   string;
  dataDays: number;
  lastDate: string | null;
}

/**
 * Fresh per-metric data-day counts (90-day window) + most recent date, one
 * GROUP BY for however many metrics are requested. Same freshness rationale
 * as getCalibration() (lib/brain/baselines.ts:130-133): the
 * `baselines.data_days` snapshot only refreshes on recomputeBaselines() and
 * can lag a backfill, so Trends recomputes straight from daily_metrics.
 */
export async function queryMetricDataDays(
  userId: string,
  metrics: string[],
): Promise<MetricDataDaysRow[]> {
  if (metrics.length === 0) return [];
  const rows = await db
    .select({
      metric:   schema.daily_metrics.metric,
      dataDays: sql<number>`count(distinct ${schema.daily_metrics.date}) filter (where ${schema.daily_metrics.date} >= current_date - interval '90 days')`,
      lastDate: sql<string | null>`max(${schema.daily_metrics.date})`,
    })
    .from(schema.daily_metrics)
    .where(and(eq(schema.daily_metrics.user_id, userId), inArray(schema.daily_metrics.metric, metrics)))
    .groupBy(schema.daily_metrics.metric);

  return rows.map(r => ({
    metric:   r.metric,
    dataDays: Number(r.dataDays ?? 0),
    lastDate: r.lastDate ?? null,
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

export async function querySleepSummary(
  userId: string,
  days: number,
  metric: string = 'sleep_minutes',
): Promise<SleepSummary> {
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
        eq(schema.daily_metrics.metric, metric),
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

// ── calendar_blocks query + render helpers ─────────────────────────────────────
// Plain functions (no Anthropic tool binding) so both the get_schedule tool
// executor below and lib/brain/context.ts's "### Schedule" prompt section
// share one query + one timezone-safe rendering implementation — the model
// (and the prompt) never do timezone math themselves.

export interface ScheduleBlock {
  id:      string;
  startAt: Date;
  endAt:   Date;
  allDay:  boolean;
  title:   string | null;
}

/** Raw calendar_blocks rows for a user within [from, to), ordered by start_at. */
export async function queryScheduleWindow(
  userId: string,
  from: Date,
  to: Date,
): Promise<ScheduleBlock[]> {
  return db
    .select({
      id:      schema.calendar_blocks.id,
      startAt: schema.calendar_blocks.start_at,
      endAt:   schema.calendar_blocks.end_at,
      allDay:  schema.calendar_blocks.all_day,
      title:   schema.calendar_blocks.title,
    })
    .from(schema.calendar_blocks)
    .where(
      and(
        eq(schema.calendar_blocks.user_id, userId),
        lt(schema.calendar_blocks.start_at, to),
        gt(schema.calendar_blocks.end_at, from),
      ),
    )
    .orderBy(asc(schema.calendar_blocks.start_at));
}

const SCHEDULE_DATE_TIME_FMT: Intl.DateTimeFormatOptions = {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
};
const SCHEDULE_DATE_ONLY_FMT: Intl.DateTimeFormatOptions = {
  weekday: 'short', month: 'short', day: 'numeric',
};
const SCHEDULE_TIME_ONLY_FMT: Intl.DateTimeFormatOptions = {
  hour: 'numeric', minute: '2-digit',
};

/** Intl.DateTimeFormat in `timezone`, falling back to UTC on an invalid IANA id. */
function formatInTimezone(date: Date, timezone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(date);
  }
}

export interface RenderedScheduleEntry {
  start:  string;
  end:    string;
  allDay: boolean;
  title:  string;
}

/** Human-readable start/end + title for one block, rendered in the user's timezone. */
export function renderScheduleBlock(block: ScheduleBlock, timezone: string): RenderedScheduleEntry {
  const title = block.title && block.title.trim().length > 0 ? block.title : 'Busy';
  if (block.allDay) {
    return {
      start:  formatInTimezone(block.startAt, timezone, SCHEDULE_DATE_ONLY_FMT),
      end:    formatInTimezone(block.endAt, timezone, SCHEDULE_DATE_ONLY_FMT),
      allDay: true,
      title,
    };
  }
  return {
    start:  formatInTimezone(block.startAt, timezone, SCHEDULE_DATE_TIME_FMT),
    end:    formatInTimezone(block.endAt, timezone, SCHEDULE_TIME_ONLY_FMT),
    allDay: false,
    title,
  };
}

/** Compact one-line rendering for the prompt's "### Schedule" section. */
export function formatScheduleLine(block: ScheduleBlock, timezone: string): string {
  const rendered = renderScheduleBlock(block, timezone);
  return rendered.allDay
    ? `- ${rendered.start} (all day): ${rendered.title}`
    : `- ${rendered.start}–${rendered.end}: ${rendered.title}`;
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
      .where(and(eq(schema.nodes.user_id, userId), eq(schema.nodes.status, 'active')))
      .orderBy(desc(schema.nodes.weight));

    if (nodeType) rows = rows.filter(n => n.type === nodeType);
    if (labelContains) rows = rows.filter(n => n.label.toLowerCase().includes(labelContains));

    return JSON.stringify(rows);
  }

  // ── calculate_macros ──────────────────────────────────────────────────────
  if (name === 'calculate_macros') {
    const goal    = String(input.goal ?? 'general');
    const profile = parseProfileDetails(readMemoryFile(userId, 'core-profile.md'));
    const weightKg = typeof input.weightKg === 'number'
      ? input.weightKg
      : (profile.weightKg ?? DEFAULT_WEIGHT_KG);
    const workouts = Array.isArray(input.todayWorkouts)
      ? (input.todayWorkouts as WorkoutInput[])
      : [];

    const tdee = estimateTDEE({
      weightKg,
      heightCm:      profile.heightCm,
      age:           profile.age,
      biologicalSex: profile.biologicalSex,
    }, workouts);
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
        .where(and(eq(schema.nodes.user_id, userId), eq(schema.nodes.status, 'active')));

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
    const result = await confirmPendingFact(
      drizzlePendingFactConfirmationStore,
      { factId, action },
      userId,
    );
    return result.ok
      ? JSON.stringify(result)
      : `No pending_fact found with id ${factId}.`;
  }

  // ── resolve_fact ──────────────────────────────────────────────────────────
  if (name === 'resolve_fact') {
    const evidence = String(input.evidence ?? '').trim();
    if (!evidence) return 'Error: evidence is required.';

    const result = await resolveFact(
      drizzleNodeResolutionStore,
      {
        id:    input.id != null ? String(input.id) : null,
        label: input.label != null ? String(input.label) : null,
        evidence,
      },
      userId,
    );
    return JSON.stringify(result);
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

    // Text/description path — history-first candidate search
    const { candidates, estimateFoods } = await searchCandidates(userId, text);
    const top = candidates[0];
    if (!top) {
      return `Could not find nutrition data for "${text}". Try being more specific, e.g. "200g grilled chicken breast".`;
    }

    const SOURCE_BY_ORIGIN: Record<Candidate['origin'], string> = {
      history:  'history',
      cache:    'cache',
      usda:     'usda',
      estimate: 'calorieninjas',
    };
    const isEstimate = top.origin === 'estimate' && estimateFoods != null;

    const payload: Record<string, unknown> = {
      kcal:        top.kcal,
      c:           top.c,
      p:           top.p,
      f:           top.f,
      description: text,
      source:      SOURCE_BY_ORIGIN[top.origin],
    };
    if (isEstimate) {
      payload.items = estimateFoods!.map(fd => `${fd.qty}${fd.unit} ${fd.name}`).join(', ');
    }

    await db.insert(schema.events).values({
      user_id:   userId,
      timestamp: new Date(),
      type:      'meal_logged',
      payload,
      source: 'coach',
    });

    const result: Record<string, unknown> = {
      ok: true,
      query: text,
      kcal: top.kcal,
      c: top.c,
      p: top.p,
      f: top.f,
      matched: top.name,
      origin: top.origin,
    };
    if (isEstimate) {
      result.foods = estimateFoods;
    }

    return JSON.stringify(result);
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

  // ── get_schedule ──────────────────────────────────────────────────────────
  if (name === 'get_schedule') {
    const days = Math.max(1, Math.min(14, Math.round(Number(input.days ?? 3))));

    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const startDateStr = typeof input.startDate === 'string' && DATE_RE.test(input.startDate)
      ? input.startDate
      : null;
    const from = startDateStr ? new Date(`${startDateStr}T00:00:00.000Z`) : new Date();
    const to = new Date(from.getTime() + days * 86_400_000);

    const [userRow] = await db
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const timezone = userRow?.timezone ?? 'UTC';

    const blocks = await queryScheduleWindow(userId, from, to);
    const busy = blocks.map((b) => renderScheduleBlock(b, timezone));

    return JSON.stringify({ timezone, busy });
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

export interface PendingFactConfirmationStore {
  resolvePendingFact(request: {
    factId: string;
    userId: string;
    expectedStatus: 'pending';
    nextStatus: 'confirmed' | 'rejected';
    resolvedAt: Date;
  }): Promise<{ id: string; proposedNode: unknown } | null>;
  insertConfirmedNode(userId: string, node: Record<string, unknown>): Promise<void>;
}

export async function confirmPendingFact(
  store: PendingFactConfirmationStore,
  input: { factId: string; action: 'confirm' | 'reject' },
  userId: string,
  resolvedAt = new Date(),
): Promise<
  | { ok: true; factId: string; status: 'confirmed' | 'rejected' }
  | { ok: false; factId: string; error: 'pending_fact_not_found' }
> {
  const status = input.action === 'confirm' ? 'confirmed' : 'rejected';
  const resolved = await store.resolvePendingFact({
    factId: input.factId,
    userId,
    expectedStatus: 'pending',
    nextStatus: status,
    resolvedAt,
  });
  if (!resolved) {
    return { ok: false, factId: input.factId, error: 'pending_fact_not_found' };
  }
  if (input.action === 'confirm' && resolved.proposedNode) {
    await store.insertConfirmedNode(userId, resolved.proposedNode as Record<string, unknown>);
  }
  return { ok: true, factId: input.factId, status };
}

const drizzlePendingFactConfirmationStore: PendingFactConfirmationStore = {
  async resolvePendingFact(request) {
    const [updated] = await db
      .update(schema.pending_facts)
      .set({ status: request.nextStatus, resolved_at: request.resolvedAt })
      .where(and(
        eq(schema.pending_facts.id, request.factId),
        eq(schema.pending_facts.user_id, request.userId),
        eq(schema.pending_facts.status, request.expectedStatus),
      ))
      .returning({
        id: schema.pending_facts.id,
        proposedNode: schema.pending_facts.proposed_node,
      });
    return updated ?? null;
  },
  async insertConfirmedNode(userId, proposed) {
    await db.insert(schema.nodes).values({
      user_id: userId,
      type: String(proposed.type ?? 'Habit'),
      label: String(proposed.label ?? ''),
      properties: proposed.properties as Record<string, unknown> | null,
      source: 'confirmed',
      weight: 0.9,
    }).onConflictDoNothing();
  },
};

// ── resolve_fact ──────────────────────────────────────────────────────────────
// Retraction is a status flip (active → resolved), never a delete — the row
// (and its history) stays intact and the change is reversible. The store
// abstraction mirrors PendingFactConfirmationStore above: lookup and mutation
// are both scoped to (user_id, status='active') so a duplicate or racing call
// on an already-resolved fact never throws and never double-applies.

export interface NodeResolutionStore {
  findActiveNode(request: {
    userId: string;
    id: string | null;
    label: string | null;
  }): Promise<{ id: string; label: string; type: string } | null>;
  resolveNode(request: {
    id: string;
    userId: string;
    resolvedAt: Date;
  }): Promise<{ id: string; label: string; type: string } | null>;
}

export async function resolveFact(
  store: NodeResolutionStore,
  input: { id?: string | null; label?: string | null; evidence: string },
  userId: string,
  resolvedAt = new Date(),
): Promise<
  | { ok: true; resolved: true; nodeId: string; label: string; nodeType: string; evidence: string }
  | { ok: false; resolved: false; reason: string }
> {
  const id = input.id?.trim() || null;
  const label = input.label?.trim() || null;

  if (!id && !label) {
    return { ok: false, resolved: false, reason: 'A label or id is required to resolve a fact.' };
  }

  const noMatch = () => ({
    ok: false as const,
    resolved: false as const,
    reason: id
      ? `No matching active fact found for id "${id}".`
      : `No matching active fact found for label "${label}".`,
  });

  const match = await store.findActiveNode({ userId, id, label });
  if (!match) return noMatch();

  // Re-scoped to (id, userId) inside resolveNode's own active-status filter,
  // so a race between lookup and update also collapses to "no match" instead
  // of a crash or a double-resolve.
  const updated = await store.resolveNode({ id: match.id, userId, resolvedAt });
  if (!updated) return noMatch();

  return {
    ok: true,
    resolved: true,
    nodeId: updated.id,
    label: updated.label,
    nodeType: updated.type,
    evidence: input.evidence,
  };
}

const drizzleNodeResolutionStore: NodeResolutionStore = {
  async findActiveNode({ userId, id, label }) {
    const scope = [eq(schema.nodes.user_id, userId), eq(schema.nodes.status, 'active')];

    if (id) {
      const [row] = await db
        .select({ id: schema.nodes.id, label: schema.nodes.label, type: schema.nodes.type })
        .from(schema.nodes)
        .where(and(...scope, eq(schema.nodes.id, id)))
        .limit(1);
      return row ?? null;
    }

    // Label match is case-insensitive; fetch the user's active nodes and
    // compare in JS, consistent with the linksTo lookup in remember_fact above.
    const rows = await db
      .select({ id: schema.nodes.id, label: schema.nodes.label, type: schema.nodes.type })
      .from(schema.nodes)
      .where(and(...scope));

    const target = (label ?? '').toLowerCase();
    return rows.find(row => row.label.toLowerCase() === target) ?? null;
  },
  async resolveNode({ id, userId, resolvedAt }) {
    const [updated] = await db
      .update(schema.nodes)
      .set({ status: 'resolved', resolved_at: resolvedAt })
      .where(and(
        eq(schema.nodes.id, id),
        eq(schema.nodes.user_id, userId),
        eq(schema.nodes.status, 'active'),
      ))
      .returning({ id: schema.nodes.id, label: schema.nodes.label, type: schema.nodes.type });
    return updated ?? null;
  },
};
