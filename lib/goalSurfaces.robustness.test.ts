/**
 * ROBUSTNESS FUZZ for the goal surfaces: the goal card (computeGoalProgress), the Monday weekly review
 * (computeWeeklyReview + its push alert), the coach opener (lib/brain/openerText.ts) and the coach's goal
 * text (lib/goalPromptText.ts), run over a few hundred MESSY-BUT-PLAUSIBLE synthetic users per goal kind.
 *
 * Why: lib/timeline/ tests these surfaces heavily, but only against 16 well-formed scripted users. A real user's
 * data is messy (one weigh-in, two on a day, a 40-day gap, a 0 kcal day, a run with no distance), and a throw
 * or a "NaN km" in these surfaces breaks the Today screen or a push notification for a real person.
 *
 * Same pattern as lib/insights/nullCanary.test.ts: a seeded mulberry32 PRNG, fixed todayKeys derived from the
 * seed (never the clock), and assertions that do not bend. If this fails, fix the product code. DO NOT relax a
 * check, delete a case or widen a cap: a muted fuzz test protects nothing.
 *
 * What is generated: raw ROWS (what the database would hold: weigh-ins, HealthKit workouts, logged sets, intake,
 * vitals) plus the user's goal columns, then turned into the surfaces' INPUTS by builders that mirror
 * lib/goalProgressLoader.ts and lib/weeklyReviewLoader.ts line by line (like lib/timeline/engine.ts does, and for
 * the same reason: the loaders import @/db). KEEP IN SYNC WITH THE LOADERS. Unlike the timeline engine this also
 * feeds the vitals series, the budget's TDEE fields and rows dated after the goal card's `todayKey` (the review's
 * goal-progress read is "as of last Sunday" but its queries run on the real clock), because those are inputs the
 * loaders really pass.
 *
 * GENERATOR CONSTRAINTS (inputs the loaders can NOT pass, so they are not generated):
 *  - weeklySessions is null or an integer 1..14 (lib/goalTarget.ts parseWeeklySessionsTarget guards every writer:
 *    PATCH /api/profile, POST /api/onboarding and the coach's set_goal_target), never 0 or 15+.
 *  - target weight 30..300 kg, weekly distance 1..300 km, race distance 1..250 km, all rounded to 0.1 (same file).
 *  - the budget is always a number: resolveDietBudget() returns an auto or custom budget with a numeric kcal and
 *    protein (800..6000 kcal custom, never below the sex floor auto). `budget: none` (null) is generated for a
 *    small share of users anyway, tagged "budget:none", because the function contract allows it.
 *  - intake is one row per requested day, in order, never duplicated (resolveDailyIntake returns a Map keyed by
 *    day); a `none` day carries null kcal/protein; a `healthkit` day always has kcal > 0 (the `> 0` guard).
 *  - vitals are one point per day, ascending (queryMetricPoints orders by date; daily_metrics is unique per day).
 *  - weigh-ins stay in 20..400 kg (the write paths accept any number, but a 0 or negative weight is not a
 *    plausible user; a lb/kg mix-up spike inside that range IS generated).
 *  - running history / race peak week only carry runs with a distance > 0 (loadRunHistory, loadRacePeakWeekKm).
 *
 * To reproduce one failure (the failure message prints seed, kind and index):
 *   FUZZ_ONLY=muscle:17 node --import tsx --experimental-test-module-mocks --test lib/goalSurfaces.robustness.test.ts
 *   (add FUZZ_DUMP=1 to print the raw rows, FUZZ_PRINT=1 to print the card and review JSON)
 * To hunt deeper than the committed run (a failure found at index 2500 is reproduced the same way):
 *   FUZZ_USERS=3000 node --import tsx --experimental-test-module-mocks --test lib/goalSurfaces.robustness.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeGoalProgress,
  HEADLINE_MAX_CHARS,
  isRunningWorkoutType,
  isStrengthWorkoutType,
  REBUILD_HEADLINE_MAX_CHARS,
  type DayValue,
  type GoalKind,
  type GoalProgress,
  type GoalProgressBudget,
  type GoalProgressInput,
  type GoalProgressIntakeDay,
} from './goalProgress';
import {
  buildExerciseDisplay,
  computeWeeklyReview,
  lastCompletedWeekStart,
  MAX_REVIEW_STATS,
  NO_NEED_TO_TIGHTEN_NEXT_WEEK,
  REVIEW_HEADLINE_MAX_CHARS,
  signupLocalDay,
  STAT_COMPARISON_MAX_CHARS,
  type WeeklyReview,
  type WeeklyReviewInput,
} from './weeklyReview';
import { weeklyReviewAlert } from './weeklyReviewWorker';
import { buildBriefGoalSection, formatGoalProgressLines, type BriefGoalFocus, type WeeklyVolumeRow } from './goalPromptText';
import { goalFallbackOpener, goalOpenerLine, newUserGoalOpener, requiredOpenerLine, returningUserOpener } from './brain/openerText';
import { isWindDownPhase, peakWeekEndDaysOut, peakWeekKmBeforeTaper, racePhase } from './enduranceProgression';
import { canonicalExercise } from './exerciseCanonical';
import { localDayKey, previousDayKey, weekDayKeys } from './localDay';
import { summarizeProgression } from './progressionMath';
import { completedLocalDays, healthKitWorkoutDays } from './workoutDays';
import { endOfLocalWeek } from './weeklyReviewFreshness';
import type { WeightReading } from './weightTrend';
import type { WorkoutEntry } from './brain/tools';
import { addDays, weekdayOf } from './timeline/types';

// ═══ PRNG and small helpers ═════════════════════════════════════════════════════════════════════════════

type Rng = () => number;

/** Deterministic PRNG (mulberry32), same as lib/insights/nullCanary.test.ts. */
function makeRandom(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const num = (r: Rng, lo: number, hi: number): number => lo + r() * (hi - lo);
const chance = (r: Rng, p: number): boolean => r() < p;
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const pad2 = (n: number): string => String(n).padStart(2, '0');

function gauss(r: Rng): number {
  const u = Math.max(1e-9, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function weighted<T>(r: Rng, table: ReadonlyArray<readonly [T, number]>): T {
  let x = r() * table.reduce((s, [, w]) => s + w, 0);
  for (const [value, w] of table) {
    x -= w;
    if (x < 0) return value;
  }
  return table[table.length - 1][0];
}

function shuffled<T>(r: Rng, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ═══ The synthetic user ═════════════════════════════════════════════════════════════════════════════════

const TZ = 'UTC';
/** A Monday. todayKey = this + whole weeks + (user index % 7), so every weekday is hit equally often. */
const MONDAY0 = '2026-01-05';

const KINDS: readonly GoalKind[] = ['weight_loss', 'muscle', 'endurance', 'general'];
const SEED_BASE: Record<GoalKind, number> = { weight_loss: 310_000, muscle: 320_000, endurance: 330_000, general: 340_000 };
/** Users per goal kind. Tuned so the whole file runs in well under 30 s (weight loss is the slow surface: ~70 days of intake + the week plan). */
const USERS: Record<GoalKind, number> = { weight_loss: 250, muscle: 300, endurance: 300, general: 250 };

/** A row of `daily_metrics` 'workouts' payload, as queryWorkouts returns it (distance in metres). */
interface RawWorkout { date: string; type: string | null; durationMin: number | null; distanceM: number | null }
/** A `workout_sets` row. */
interface RawSet { day: string; exercise: string; display: string | null; reps: number; loadKg: number | null; rpe: number | null; isWarmup: boolean }
/** What resolveDailyIntake resolved for one day that has data. */
interface RawIntake { kcal: number; proteinG: number; source: 'logged' | 'healthkit' }

interface FuzzUser {
  seed: number;
  kind: GoalKind;
  index: number;
  /** Which messy features this user carries (for the failure message). */
  tags: string[];
  /** The fixed "today" (also the review's run day). */
  todayKey: string;
  units: 'metric' | 'imperial';
  sex: 'male' | 'female';
  user: {
    targetWeightKg: number | null;
    targetDate: string | null;
    weeklySessions: number | null;
    weeklyDistanceKm: number | null;
    raceDate: string | null;
    raceDistanceKm: number | null;
    goalStartWeightKg: number | null;
    /** Local day goal_started_at falls on; null for a user without one (legacy rows). */
    goalStartedDay: string | null;
    createdDay: string;
    sleepGoalMinutes: number;
  };
  budget: {
    mode: 'auto' | 'custom' | 'none';
    targetKcal: number | null;
    proteinG: number | null;
    formulaTdee: number | null;
    learnedTdee: number | null;
    tdeeConfidence: string | null;
  };
  weights: WeightReading[];
  workouts: RawWorkout[];
  sets: RawSet[];
  intake: Map<string, RawIntake>;
  restingHr: DayValue[];
  hrv: DayValue[];
  sleepMinutes: DayValue[];
}

// ── history shape: which days a user is "around" ────────────────────────────────────────────────────────

interface Shape { span: number; tailGap: number; midGapStart: number; midGapLen: number }

function makeShape(r: Rng, tags: string[], regular: boolean): Shape {
  const length = weighted<'none' | 'new' | 'short' | 'medium' | 'long'>(r, regular ? [['medium', 35], ['long', 65]] : [['none', 8], ['new', 14], ['short', 16], ['medium', 28], ['long', 34]]);
  const span = length === 'none' ? 0 : length === 'new' ? int(r, 1, 6) : length === 'short' ? int(r, 7, 20) : length === 'medium' ? int(r, 28, 60) : int(r, 61, 180);
  // A long quiet stretch right before today (a returning user) or a short one. A "regular" user is still around today.
  const tailGap = regular ? (chance(r, 0.85) ? 0 : int(r, 1, 6)) : chance(r, 0.3) ? int(r, 10, 60) : chance(r, 0.15) ? int(r, 1, 9) : 0;
  const hasMid = span >= 30 && chance(r, 0.3);
  const midGapLen = hasMid ? int(r, 10, 60) : 0;
  const midGapStart = hasMid ? tailGap + int(r, 5, Math.max(5, span - 5)) : 0;
  tags.push(span === 0 ? 'no-history' : `history:${span}d`);
  if (tailGap >= 10) tags.push(`tail-gap:${tailGap}d`);
  if (hasMid) tags.push(`mid-gap:${midGapLen}d`);
  return { span, tailGap, midGapStart, midGapLen };
}

/** `ago` = days before today. Active = inside the history window and outside the gaps. */
const isActive = (s: Shape, ago: number): boolean =>
  ago >= s.tailGap && ago < s.tailGap + s.span && !(s.midGapLen > 0 && ago >= s.midGapStart && ago < s.midGapStart + s.midGapLen);

// ── weigh-ins (getWeightReadings: manual/coach events + HealthKit body mass, in no guaranteed order) ───────────────

function genWeights(r: Rng, kind: GoalKind, today: string, shape: Shape, tags: string[], regular: boolean): { readings: WeightReading[]; current: number } {
  const w0 = weighted<() => number>(r, [[() => num(r, 55, 95), 36], [() => pick(r, [num(r, 40, 55), num(r, 95, 140)]), 50], [() => pick(r, [num(r, 30, 40), num(r, 140, 250)]), 14]])();
  const perWeek = kind === 'weight_loss' ? num(r, -1.3, 0.7) : kind === 'muscle' ? num(r, -0.4, 0.9) : num(r, -0.5, 0.5);
  const density = regular
    ? weighted(r, [[0.5, 25], [0.8, 45], [1, 30]])
    : kind === 'weight_loss'
      ? weighted(r, [[0, 4], [0.12, 14], [0.35, 22], [0.7, 30], [1, 20]])
      : weighted(r, [[0, 24], [0.1, 20], [0.3, 22], [0.6, 20], [0.9, 14]]);
  const dupP = pick(r, [0, 0, 0.1, 0.5]);
  const healthkitShare = pick(r, [0, 0.3, 1]);
  const shuffle = chance(r, 0.5);
  const single = !regular && chance(r, 0.06);

  const make = (ago: number, kg: number): WeightReading[] => {
    const day = addDays(today, -ago);
    const out: WeightReading[] = [];
    const count = 1 + (chance(r, dupP) ? int(r, 1, 2) : 0);
    for (let i = 0; i < count; i++) {
      const source = chance(r, healthkitShare) ? 'healthkit' : chance(r, 0.15) ? 'coach' : 'manual';
      let value = kg + (i === 0 ? 0 : gauss(r) * 0.6);
      if (chance(r, 0.02)) value *= pick(r, [2.2046, 0.4536]); // lb typed as kg (or the reverse)
      value = clamp(value, 20, 400);
      // A reading's `localDay` can differ from the UTC date of its instant (the user's timezone).
      const dayShift = chance(r, 0.06) ? pick(r, [-1, 1]) : 0;
      out.push({
        measuredAt: source === 'healthkit' ? `${day}T12:00:00.000Z` : `${addDays(day, dayShift)}T${pad2(int(r, 5, 22))}:${pad2(int(r, 0, 59))}:00.000Z`,
        valueKg: source === 'healthkit' ? Math.round(value * 10_000) / 10_000 : round1(value),
        source,
        localDay: day,
      });
    }
    return out;
  };

  let readings: WeightReading[] = [];
  let level = w0;
  const oldest = shape.tailGap + shape.span - 1;
  for (let ago = oldest; ago >= 0; ago--) {
    level = clamp(level + perWeek / 7 + gauss(r) * 0.12, 30, 300);
    if (!isActive(shape, ago) || !chance(r, density)) continue;
    readings.push(...make(ago, level + gauss(r) * 0.4));
  }
  if (single) {
    const ago = pick(r, [0, 1, 5, 12, 40]);
    readings = make(ago, w0);
    tags.push(`single-weighin:${ago}d-ago`);
  } else if (readings.length === 0) {
    tags.push('no-weighins');
  } else {
    tags.push(`weighins:${readings.length}${dupP > 0 ? ',dupes' : ''}${shuffle ? ',unsorted' : ''}`);
  }
  if (shuffle) readings = shuffled(r, readings);
  return { readings, current: readings.length > 0 ? readings[readings.length - 1].valueKg : w0 };
}

// ── workouts (daily_metrics 'workouts' payload items) ─────────────────────────────────────────────────

const OTHER_TYPES = ['Walking', 'Cycling', 'Swimming', 'Yoga', 'Hiking', 'Elliptical', 'HIIT', 'Rowing', 'Cardio', 'Other', 'Workout'] as const;

function genWorkouts(r: Rng, kind: GoalKind, today: string, shape: Shape, tags: string[], regular: boolean, race: { date: string | null; km: number | null }): RawWorkout[] {
  const perWeek = regular ? weighted(r, [[2, 20], [3, 30], [4, 30], [5, 20]]) : weighted(r, [[0, 10], [1, 12], [2, 18], [3, 22], [4, 18], [5, 12], [6, 8]]);
  const style = kind === 'endurance'
    ? weighted<'runner' | 'cross'>(r, [['runner', 80], ['cross', 20]])
    : kind === 'muscle'
      ? weighted<'strength' | 'mixed' | 'none'>(r, [['strength', 50], ['mixed', 20], ['none', 30]])
      : weighted<'mixed' | 'runner' | 'strength'>(r, [['mixed', 60], ['runner', 25], ['strength', 15]]);
  const baseKm = pick(r, [2, 4, 6, 8, 12, 20]);
  const missingDistance = chance(r, 0.15) ? 0.5 : 0.05; // a user whose watch rarely records distance
  const rows: RawWorkout[] = [];

  const duration = (typicalMin: number): number | null => {
    const x = r();
    if (x < 0.04) return null;
    if (x < 0.1) return int(r, 1, 9); // below HealthKit's 10-minute "real workout" floor
    if (x < 0.13) return int(r, 150, 400);
    return Math.max(1, Math.round(typicalMin * num(r, 0.6, 1.5)));
  };
  const run = (date: string, long: boolean): RawWorkout => {
    let km = baseKm * num(r, 0.5, 1.6) * (long ? 1.8 : 1);
    const x = r();
    if (x < 0.03) km = 40;
    else if (x < 0.05) km = 0;
    const distanceM = km === 0 ? 0 : chance(r, missingDistance) ? null : chance(r, 0.5) ? Math.round(km * 1000) : km * 1000 + r();
    const pace = num(r, 4.2, 8.8);
    return { date, type: 'Running', durationMin: chance(r, 0.05) ? null : km === 40 ? Math.round(40 * pace) : duration(Math.max(8, (km || 4) * pace)), distanceM };
  };
  const other = (date: string): RawWorkout => {
    const type = pick(r, OTHER_TYPES);
    const withDistance = type === 'Walking' || type === 'Cycling' || type === 'Hiking' || type === 'Swimming' || type === 'Rowing';
    const km = type === 'Cycling' ? num(r, 5, 100) : type === 'Swimming' ? num(r, 0.3, 3) : num(r, 0.5, 9);
    return { date, type, durationMin: duration(40), distanceM: withDistance && !chance(r, 0.25) ? Math.round(km * 1000) : null };
  };
  const strength = (date: string): RawWorkout => ({
    date,
    type: chance(r, 0.97) ? 'Strength Training' : null, // a payload item with no `type`
    durationMin: duration(55),
    distanceM: null,
  });

  const oldest = shape.tailGap + shape.span - 1;
  for (let ago = oldest; ago >= 0; ago--) {
    if (!isActive(shape, ago) || !chance(r, perWeek / 7)) continue;
    const date = addDays(today, -ago);
    const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
    const count = chance(r, 0.12) ? 2 : 1;
    for (let i = 0; i < count; i++) {
      if (style === 'runner') rows.push(chance(r, 0.8) ? run(date, dow === 6) : other(date));
      else if (style === 'cross') rows.push(chance(r, 0.35) ? run(date, false) : other(date));
      else if (style === 'strength') rows.push(chance(r, 0.85) ? strength(date) : other(date));
      else if (style === 'mixed') rows.push(pick(r, [() => run(date, false), () => strength(date), () => other(date), () => other(date)])());
    }
  }
  // The race itself, logged on race day (a run of about the race distance), for a race that is today or already run.
  if (race.date != null && race.date <= today && race.date >= addDays(today, -20) && kind === 'endurance' && chance(r, 0.6)) {
    const km = (race.km ?? pick(r, [5, 10, 21.1, 42.2])) * num(r, 0.9, 1.04);
    rows.push({ date: race.date, type: 'Running', durationMin: Math.round(km * num(r, 4.5, 8)), distanceM: Math.round(km * 1000) });
  }
  // A user with ONE session on record.
  if (!regular && rows.length > 1 && chance(r, 0.07)) {
    const keep = pick(r, rows);
    rows.splice(0, rows.length, ...rows.filter(w => w.date === keep.date).slice(0, 1));
    tags.push('single-workout');
  }
  if (rows.length > 0) tags.push(`workouts:${style}x${rows.length}`);
  // queryWorkouts: ORDER BY date DESC, the items of one day in payload order.
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// ── logged strength sets (workout_sets) ───────────────────────────────────────────────────────────────

const MAIN_LIFTS: ReadonlyArray<readonly [string, number]> = [['Squat', 100], ['Bench Press', 70], ['Deadlift', 120], ['Overhead Press', 45], ['Barbell Row', 60]];
const ACCESSORIES: ReadonlyArray<readonly [string, number]> = [
  ['Romanian Deadlift', 80], ['DB Curl', 14], ['lat pulldown', 50], ['Leg Press', 140], ['Pull-ups', 0], ['dips', 0], ['Hip Thrust', 90], ['face pulls', 20], ['calf raise', 60],
];
const UNUSUAL: ReadonlyArray<readonly [string, number]> = [
  ['Zercher squat', 60], ['Landmine press', 30], ['Farmer carry', 40], ['treadmill sprint', 0], ['Ab wheel rollout', 0], ['GHD raise', 0], ['Sled push (plates)', 100],
  ['x', 10], ['Cable Crunch #3', 35], ['Plank', 0], ['3-way hip thrust!!', 50], ['a very long exercise name that goes on and on far past any sensible width', 20],
  // Long but real names (a typed or voice-transcribed exercise is stored as given, with no length limit anywhere on the write path).
  ['Single-arm dumbbell Romanian deadlift', 24], ['Seated single arm dumbbell overhead press', 18], ['Incline dumbbell bench press with pause reps', 26],
];

function genSets(r: Rng, kind: GoalKind, today: string, shape: Shape, tags: string[], regular: boolean): RawSet[] {
  const wants = kind === 'muscle' ? regular || chance(r, 0.85) : chance(r, 0.2);
  if (!wants) return [];
  const perWeek = weighted(r, [[1, 14], [2, 22], [3, 30], [4, 22], [5, 8], [6, 4]]);
  const plan = weighted<'one' | 'main' | 'mixed' | 'unusual'>(r, [['one', 15], ['main', 40], ['mixed', 25], ['unusual', 20]]);
  const scale = num(r, 0.3, 1.8);
  const fixedLift = pick(r, MAIN_LIFTS);
  const growthPerSession = chance(r, 0.5) ? num(r, 0, 0.4) : num(r, -0.2, 0);
  const roundTo = chance(r, 0.7) ? 2.5 : 0;
  const rows: RawSet[] = [];
  let sessions = 0;

  const oldest = shape.tailGap + shape.span - 1;
  for (let ago = oldest; ago >= 0; ago--) {
    if (!isActive(shape, ago) || !chance(r, perWeek / 7)) continue;
    // Occasionally two sessions on one day (a morning and an evening): the same `local_day` twice.
    for (let again = chance(r, 0.1) ? 2 : 1; again > 0; again--) {
      sessions += 1;
      const day = addDays(today, -ago);
      const pool = plan === 'one' ? [fixedLift] : plan === 'main' ? MAIN_LIFTS : plan === 'mixed' ? [...MAIN_LIFTS, ...ACCESSORIES] : UNUSUAL;
      const chosen = plan === 'one' ? [fixedLift] : shuffled(r, pool).slice(0, int(r, 1, Math.min(4, pool.length)));
      for (const [name, base] of chosen) {
        const canon = canonicalExercise(name);
        if (canon.key === '') continue;
        const display = weighted<string | null>(r, [[canon.display, 80], [name, 15], [null, 5]]);
        const setCount = int(r, 1, 6);
        for (let s = 0; s < setCount; s++) {
          const bodyweight = base === 0;
          let load: number | null = bodyweight ? null : Math.max(0, base * scale * (1 + growthPerSession * sessions * 0.01) * num(r, 0.85, 1.1));
          if (load != null) load = roundTo > 0 ? Math.round(load / roundTo) * roundTo : round2(load);
          if (load != null && chance(r, 0.02)) load = 0;
          const warmup = s === 0 && chance(r, 0.25);
          rows.push({
            day,
            exercise: canon.key,
            display,
            reps: weighted(r, [[1, 5], [3, 8], [5, 25], [8, 25], [10, 20], [12, 10], [15, 4], [20, 2], [60, 1]]),
            loadKg: warmup && load != null ? round1(load * 0.5) : load,
            rpe: chance(r, 0.7) ? null : chance(r, 0.03) ? 0 : int(r, 6, 10),
            isWarmup: warmup,
          });
        }
      }
    }
  }
  // A user with ONE logged set on record.
  if (!regular && rows.length > 1 && chance(r, 0.07)) {
    rows.splice(1);
    tags.push('single-set');
  }
  if (rows.length > 0) tags.push(`sets:${plan}x${rows.length}`);
  return rows;
}

// ── intake (resolveDailyIntake) ───────────────────────────────────────────────────────────────────────

function genIntake(r: Rng, kind: GoalKind, today: string, shape: Shape, tags: string[], regular: boolean): Map<string, RawIntake> {
  const density = regular
    ? weighted(r, [[0.6, 25], [0.85, 40], [1, 35]])
    : kind === 'weight_loss'
      ? weighted(r, [[0, 10], [0.15, 15], [0.5, 20], [0.85, 30], [1, 25]])
      : weighted(r, [[0, 35], [0.15, 15], [0.5, 20], [0.85, 18], [1, 12]]);
  const healthkit = chance(r, 0.2);
  const weekendBinge = chance(r, 0.2);
  const center = num(r, 1400, 3000);
  const map = new Map<string, RawIntake>();
  const oldest = shape.tailGap + shape.span - 1;
  for (let ago = oldest; ago >= 0; ago--) {
    if (!isActive(shape, ago) || !chance(r, density)) continue;
    const day = addDays(today, -ago);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    let kcal = clamp(center + gauss(r) * 350 + (weekendBinge && (dow === 0 || dow === 6) ? 600 : 0), 300, 4500);
    const x = r();
    if (x < 0.03) kcal = 0; // a 0 kcal placeholder meal still counts as "logged"
    else if (x < 0.11) kcal = num(r, 50, 600); // a half-logged day
    else if (x < 0.13) kcal = num(r, 6000, 30_000); // a typo
    kcal = Math.round(kcal);
    const proteinG = kcal === 0 ? 0 : Math.round(kcal * num(r, 0.04, 0.14) / 1);
    if (healthkit && kcal > 0) map.set(day, { kcal, proteinG: chance(r, 0.3) ? 0 : proteinG, source: 'healthkit' });
    else map.set(day, { kcal, proteinG, source: 'logged' });
  }
  if (map.size > 0) tags.push(`intake:${map.size}d${healthkit ? ',healthkit' : ''}`);
  return map;
}

// ── vitals (queryMetricPoints: one point per day, ascending) ──────────────────────────────────────────

function genVitals(r: Rng, today: string, shape: Shape, tags: string[]): Pick<FuzzUser, 'restingHr' | 'hrv' | 'sleepMinutes'> {
  const mode = weighted<'none' | 'sparse' | 'dense'>(r, [['none', 45], ['sparse', 20], ['dense', 35]]);
  const out = { restingHr: [] as DayValue[], hrv: [] as DayValue[], sleepMinutes: [] as DayValue[] };
  if (mode === 'none') return out;
  const rhr = num(r, 45, 75);
  const hrv = num(r, 25, 90);
  const sleep = num(r, 330, 510);
  const oldest = shape.tailGap + shape.span - 1;
  for (let ago = oldest; ago >= 0; ago--) {
    if (!isActive(shape, ago)) continue;
    const day = addDays(today, -ago);
    const p = mode === 'dense' ? 0.9 : 0.2;
    if (chance(r, p)) out.restingHr.push({ day, value: round1(clamp(rhr + gauss(r) * 3, 35, 110)) });
    if (chance(r, p)) out.hrv.push({ day, value: round1(clamp(hrv + gauss(r) * 12, 8, 220)) });
    if (chance(r, p)) out.sleepMinutes.push({ day, value: chance(r, 0.01) ? 0 : Math.round(clamp(sleep + gauss(r) * 55, 60, 780)) });
  }
  tags.push(`vitals:${mode}`);
  return out;
}

// ── the user row (goal columns), budget ────────────────────────────────────────────────────────────────

function genTargetWeight(r: Rng, kind: GoalKind, current: number): number | null {
  const none = kind === 'weight_loss' ? 0.2 : kind === 'muscle' ? 0.35 : 0.88;
  if (chance(r, none)) return null;
  const x = r();
  let target: number;
  if (x < 0.06) target = current; // target equal to the current weight
  else if (x < 0.09) target = pick(r, [30, 300]);
  else if (kind === 'muscle' ? x < 0.35 : x < 0.8) target = current - num(r, 1, 40);
  else target = current + num(r, 1, 30); // above the current weight (wrong way for a fat-loss goal)
  return round1(clamp(target, 30, 300));
}

function genBudget(r: Rng, sex: 'male' | 'female'): FuzzUser['budget'] {
  const mode = weighted<'auto' | 'custom' | 'none'>(r, [['auto', 45], ['custom', 40], ['none', 15]]);
  const floor = sex === 'male' ? 1500 : 1200;
  if (mode === 'none') return { mode, targetKcal: null, proteinG: null, formulaTdee: null, learnedTdee: null, tdeeConfidence: null };
  if (mode === 'custom') {
    const kcal = weighted<() => number>(r, [[() => int(r, 800, 1200), 10], [() => int(r, 1200, 3500), 80], [() => int(r, 3500, 6000), 10]])();
    return { mode, targetKcal: kcal, proteinG: Math.round(kcal * 0.3 / 4), formulaTdee: null, learnedTdee: null, tdeeConfidence: null };
  }
  const formula = Math.round(num(r, 1400, 3800));
  return {
    mode,
    targetKcal: Math.round(clamp(formula - num(r, -400, 900), floor, 5000)),
    proteinG: int(r, 60, 240),
    formulaTdee: formula,
    learnedTdee: chance(r, 0.5) ? null : Math.round(formula + num(r, -450, 450)),
    tdeeConfidence: pick(r, [null, 'none', 'low', 'medium', 'high']),
  };
}

function makeUser(kind: GoalKind, index: number): FuzzUser {
  const seed = SEED_BASE[kind] + index;
  const r = makeRandom(seed);
  const tags: string[] = [];
  const todayKey = addDays(MONDAY0, 7 * int(r, 8, 60) + (index % 7));
  const units = chance(r, 0.4) ? 'imperial' : 'metric';
  const sex = chance(r, 0.5) ? 'male' : 'female';
  tags.push(units, weekdayOf(todayKey));

  // ~40% are "regular" users (months of logging, around today) so the mature code paths (pace, ETA, plateau, week plan, lift trends) run on messy details too.
  const regular = chance(r, 0.4);
  if (regular) tags.push('regular');
  const shape = makeShape(r, tags, regular);
  const { readings, current } = genWeights(r, kind, todayKey, shape, tags, regular);

  // The endurance columns come first: a race that is today or just over has its race-day run in the workouts.
  const endurance = kind === 'endurance';
  const weeklyDistanceKm = chance(r, endurance ? 0.25 : 0.9)
    ? null
    : pick(r, [1, 1, 3, 5, 10, 12.5, 20, 30, 45, 60, 100, 150, 300]);
  const hasRace = endurance ? chance(r, 0.6) : chance(r, 0.06);
  const raceOffset = weighted<() => number>(r, [
    [() => -int(r, 1, 14), 12], [() => -int(r, 15, 120), 4], [() => 0, 6], [() => 1, 5], [() => int(r, 2, 14), 18], [() => int(r, 15, 90), 30], [() => int(r, 91, 400), 20],
  ])();
  const raceDate = hasRace ? addDays(todayKey, raceOffset) : null;
  const raceDistanceKm = chance(r, hasRace ? 0.15 : 0.7) ? null : pick(r, [5, 10, 21.1, 42.2, 15, 3, 1, 50, 100, 250, 7.5, 21.1, 42.2]);
  if (raceDate) tags.push(`race:${raceOffset >= 0 ? '+' : ''}${raceOffset}d/${raceDistanceKm ?? 'nokm'}`);

  const workouts = genWorkouts(r, kind, todayKey, shape, tags, regular, { date: raceDate, km: raceDistanceKm });
  const sets = genSets(r, kind, todayKey, shape, tags, regular);
  const intake = genIntake(r, kind, todayKey, shape, tags, regular);
  const vitals = genVitals(r, todayKey, shape, tags);
  const budget = genBudget(r, sex);
  if (budget.mode === 'none') tags.push('budget:none');
  else tags.push(`budget:${budget.mode}`);

  // The goal's start. Mostly in the past; sometimes today, and (a timezone switch) the day after today.
  const startedAgo = weighted<() => number | null>(r, [
    [() => null, 8], [() => -1, 2], [() => 0, 5], [() => int(r, 1, 6), 14], [() => int(r, 7, 27), 20], [() => int(r, 28, 120), 31], [() => int(r, 121, 500), 20],
  ])();
  const goalStartedDay = startedAgo == null ? null : addDays(todayKey, -startedAgo);
  const createdDay = addDays(goalStartedDay ?? todayKey, -(chance(r, 0.3) ? 0 : int(r, 0, 400)));
  const goalStartWeightKg = chance(r, 0.35) ? null : round1(clamp(current + num(r, -15, 15), 30, 300));
  if (goalStartedDay == null) tags.push('no-goal-start');
  else if (goalStartedDay >= todayKey) tags.push(goalStartedDay === todayKey ? 'goal-starts-today' : 'goal-starts-tomorrow');

  const targetWeightKg = genTargetWeight(r, kind, current);
  const dateX = r();
  const targetDate = dateX < 0.35 ? null
    : dateX < 0.7 ? addDays(todayKey, int(r, 1, 400))
      : dateX < 0.75 ? todayKey
        : addDays(todayKey, -int(r, 1, 300));
  const weeklySessions = chance(r, 0.3) ? null : weighted(r, [[1, 3], [2, 10], [3, 22], [4, 22], [5, 14], [6, 8], [7, 3], [10, 2], [14, 1]]);

  const sleepGoalMinutes = chance(r, 0.75) ? 480 : int(r, 240, 720);

  return {
    seed, kind, index, tags, todayKey, units, sex,
    user: { targetWeightKg, targetDate, weeklySessions, weeklyDistanceKm, raceDate, raceDistanceKm, goalStartWeightKg, goalStartedDay, createdDay, sleepGoalMinutes },
    budget, weights: readings, workouts, sets, intake, ...vitals,
  };
}

// ═══ Loader mirrors: rows -> surface inputs ═════════════════════════════════════════════════════════════
// Each builder says which loader block it copies. `realNow` is the clock the DATABASE queries run on (the loaders'
// queryMetricPoints / getSetsSince / getWeightReadings ignore the `now` option and use the real clock), `todayKey`
// is the local day the surface is evaluated for. They differ for the review's goal-progress read (as of last Sunday).

/** lib/goalProgressLoader.ts trailingDayKeys. */
function trailingDayKeys(todayKey: string, n: number): string[] {
  const keys = [todayKey];
  for (let i = 1; i < n; i++) keys.unshift(previousDayKey(keys[0]));
  return keys;
}

/** getWeightReadings(userId, lookbackDays). */
function weightReadingsAt(u: FuzzUser, realNow: string, lookbackDays: number): WeightReading[] {
  const from = addDays(realNow, -lookbackDays);
  return u.weights.filter(w => w.localDay <= realNow && w.localDay >= from);
}

interface SetRow {
  exercise: string;
  exercise_display: string | null;
  performed_at: Date;
  local_day: string;
  rpe: number | null;
  reps: number;
  load_kg: number | null;
  is_warmup: boolean;
}

/** getSetsSince(userId, days): ORDER BY performed_at (all the sets of a session share one instant). */
function setRowsAt(u: FuzzUser, realNow: string, days: number): SetRow[] {
  const from = addDays(realNow, -days);
  return u.sets
    .filter(s => s.day <= realNow && s.day >= from)
    .map(s => ({
      exercise: s.exercise,
      exercise_display: s.display,
      performed_at: new Date(`${s.day}T18:00:00.000Z`),
      local_day: s.day,
      rpe: s.rpe,
      reps: s.reps,
      load_kg: s.loadKg,
      is_warmup: s.isWarmup,
    }))
    .sort((a, b) => a.performed_at.getTime() - b.performed_at.getTime());
}

/** queryWorkouts(userId, days): daily_metrics 'workouts' rows with date >= realNow - days, newest first. */
function workoutEntriesAt(u: FuzzUser, realNow: string, days: number): WorkoutEntry[] {
  const from = addDays(realNow, -Math.max(1, Math.min(30, Math.round(days))));
  return u.workouts
    .filter(w => w.date >= from && w.date <= realNow)
    .map(w => ({ date: w.date, type: w.type, durationMin: w.durationMin, distanceM: w.distanceM }));
}

/** queryMetricPoints(userId, metric, days): date >= realNow - days, ascending. */
function seriesAt(points: DayValue[], realNow: string, days: number): DayValue[] {
  const from = addDays(realNow, -days);
  return points.filter(p => p.day >= from && p.day <= realNow);
}

/** resolveDailyIntake -> the loaders' intakeRow(): one row per requested day, source 'none' with null values when nothing is logged. */
function intakeRows(u: FuzzUser, dayKeys: string[]): GoalProgressIntakeDay[] {
  return dayKeys.map(day => {
    const i = u.intake.get(day);
    return i ? { day, kcal: i.kcal, proteinG: i.proteinG, source: i.source } : { day, kcal: null, proteinG: null, source: 'none' };
  });
}

function budgetFor(u: FuzzUser, floorKcal: number): GoalProgressBudget | null {
  if (u.budget.mode === 'none') return null;
  return {
    targetKcal: u.budget.targetKcal,
    proteinG: u.budget.proteinG,
    floorKcal,
    formulaTdee: u.budget.formulaTdee,
    learnedTdee: u.budget.learnedTdee,
    tdeeConfidence: u.budget.tdeeConfidence,
  };
}

const workoutBits = (w: WorkoutEntry) => ({
  durationMin: typeof w.durationMin === 'number' && Number.isFinite(w.durationMin) ? w.durationMin : null,
  distanceKm: typeof w.distanceM === 'number' && Number.isFinite(w.distanceM) ? w.distanceM / 1000 : null,
  type: typeof w.type === 'string' ? w.type : null,
});

const strengthEntries = (entries: WorkoutEntry[]): WorkoutEntry[] => entries.filter(w => isStrengthWorkoutType(typeof w.type === 'string' ? w.type : null));

/** lib/runHistoryLoader.ts loadRunHistory: running workouts with a distance > 0 on [day - 77, day], oldest first. */
function runHistoryAt(u: FuzzUser, day: string): Array<{ day: string; km: number; durationMin: number | null }> {
  const from = addDays(day, -77);
  return u.workouts
    .filter(w => w.date >= from && w.date <= day && isRunningWorkoutType(w.type) && typeof w.distanceM === 'number' && Number.isFinite(w.distanceM) && w.distanceM > 0)
    .map(w => ({ day: w.date, km: (w.distanceM as number) / 1000, durationMin: typeof w.durationMin === 'number' && Number.isFinite(w.durationMin) ? w.durationMin : null }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** lib/racePeakLoader.ts loadRacePeakWeekKm. */
function racePeakWeekKmAt(u: FuzzUser, onDays: string[]): number | null {
  const { raceDate, raceDistanceKm } = u.user;
  if (!raceDate || !onDays.some(day => isWindDownPhase(racePhase(raceDate, day, raceDistanceKm)))) return null;
  const to = addDays(raceDate, -peakWeekEndDaysOut(raceDistanceKm));
  const from = addDays(to, -27);
  const runs: Array<{ day: string; km: number }> = [];
  for (const w of u.workouts) {
    if (w.date < from || w.date > to) continue;
    if (!isRunningWorkoutType(w.type)) continue;
    if (typeof w.distanceM !== 'number' || !Number.isFinite(w.distanceM) || w.distanceM <= 0) continue;
    runs.push({ day: w.date, km: w.distanceM / 1000 });
  }
  return peakWeekKmBeforeTaper(runs, raceDate, raceDistanceKm);
}

/** lib/goalProgressLoader.ts loadGoalProgress. */
function buildGoalInput(u: FuzzUser, todayKey: string, realNow: string): GoalProgressInput {
  const WINDOW_DAYS = 28;
  const dayKeys = trailingDayKeys(todayKey, WINDOW_DAYS);
  const daySet = new Set(dayKeys);

  const progressionSets = setRowsAt(u, realNow, 84);
  const workoutEntries = workoutEntriesAt(u, realNow, WINDOW_DAYS);
  const progression = summarizeProgression(progressionSets);
  const sets = progressionSets.filter(set => dayKeys.includes(set.local_day));
  const exerciseDisplay: Record<string, string> = {};
  for (const set of progressionSets) if (set.exercise_display) exerciseDisplay[set.exercise] = set.exercise_display;

  const strengthDays = new Set<string>([...completedLocalDays(sets), ...healthKitWorkoutDays(strengthEntries(workoutEntries))]);
  const trainingDays = new Set<string>([...completedLocalDays(sets), ...healthKitWorkoutDays(workoutEntries)]);
  const strengthHistoryDays = new Set<string>([...completedLocalDays(progressionSets), ...strengthDays]);
  const workouts = workoutEntries.filter(w => daySet.has(w.date)).map(w => ({ day: w.date, ...workoutBits(w) }));

  const endurance = u.kind === 'endurance';
  const startedAt = u.user.goalStartedDay ? new Date(`${u.user.goalStartedDay}T12:00:00.000Z`) : null;
  const hkSeries = (points: DayValue[]) => seriesAt(points, realNow, WINDOW_DAYS);

  return {
    goal: u.kind,
    todayKey,
    target: { weightKg: u.user.targetWeightKg, date: u.user.targetDate, weeklySessions: u.user.weeklySessions, weeklyDistanceKm: u.user.weeklyDistanceKm },
    race: { date: u.user.raceDate, distanceKm: u.user.raceDistanceKm },
    racePeakWeekKm: endurance ? racePeakWeekKmAt(u, [todayKey, mondayOf(todayKey)]) : null,
    runHistory: endurance ? runHistoryAt(u, todayKey) : undefined,
    start: {
      weightKg: u.user.goalStartWeightKg,
      startedAt: startedAt ? startedAt.toISOString() : null,
      startedDay: startedAt ? localDayKey(startedAt, TZ) : null,
    },
    weightReadings: weightReadingsAt(u, realNow, 120),
    intakeDays: intakeRows(u, dayKeys),
    intakeHistoryDays: u.kind === 'weight_loss' ? intakeRows(u, trailingDayKeys(todayKey, 70)) : undefined,
    budget: budgetFor(u, u.sex === 'male' ? 1500 : 1200),
    progression,
    trainingDays: [...trainingDays].filter(d => daySet.has(d)),
    strengthDays: [...strengthDays].filter(d => daySet.has(d)),
    strengthHistoryDays: [...strengthHistoryDays],
    exerciseDisplay,
    workouts,
    restingHr: hkSeries(u.restingHr),
    hrv: hkSeries(u.hrv),
    sleepMinutes: hkSeries(u.sleepMinutes),
    sleepGoalMinutes: u.user.sleepGoalMinutes,
    unitSystem: u.units,
  };
}

function mondayOf(day: string): string {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

/** lib/weeklyReviewLoader.ts computeLastWeekReview. */
function buildReviewInput(
  u: FuzzUser,
  runDay: string,
  parts: { progress: GoalProgress | null; comingWeekProgress: GoalProgress | null; previousNextWeek: string | null },
): WeeklyReviewInput {
  const weekStart = lastCompletedWeekStart(runDay);
  const dayKeys = [...weekDayKeys(addDays(weekStart, -7)), ...weekDayKeys(weekStart)];
  const daySet = new Set(dayKeys);
  const { progress, comingWeekProgress, previousNextWeek } = parts;

  const progressionSets = setRowsAt(u, runDay, 84);
  const progression = summarizeProgression(progressionSets);
  const sets = setRowsAt(u, runDay, 30 + 2);
  const workoutEntries = workoutEntriesAt(u, runDay, 30);
  const displayRows = progressionSets.map(s => ({ exercise: s.exercise, exercise_display: s.exercise_display }));

  const comingWeekPlan = comingWeekProgress?.weightRead?.plan;
  const weightPlan = comingWeekPlan != null && comingWeekPlan.weekStart === addDays(weekStart, 7) ? comingWeekPlan : null;

  const trainingDays = new Set<string>([...completedLocalDays(sets), ...healthKitWorkoutDays(workoutEntries)]);
  const strengthDays = new Set<string>([...completedLocalDays(sets), ...healthKitWorkoutDays(strengthEntries(workoutEntries))]);
  const endurance = u.kind === 'endurance';

  return {
    goal: u.kind,
    weekStart,
    verdict: progress?.verdict ?? 'insufficient_data',
    weightReadings: weightReadingsAt(u, runDay, 90),
    intakeDays: intakeRows(u, dayKeys),
    budget: budgetFor(u, 0),
    trainingDays: [...trainingDays].filter(d => daySet.has(d)),
    strengthDays: [...strengthDays],
    workouts: workoutEntries.filter(w => daySet.has(w.date)).map(w => ({ day: w.date, ...workoutBits(w) })),
    progression,
    restingHr: seriesAt(u.restingHr, runDay, 30),
    hrv: seriesAt(u.hrv, runDay, 30),
    sleepMinutes: seriesAt(u.sleepMinutes, runDay, 30),
    sleepGoalMinutes: u.user.sleepGoalMinutes,
    weeklySessionsTarget: u.user.weeklySessions,
    targetWeightKg: progress?.target.weightKg ?? u.user.targetWeightKg ?? null,
    reachedAt: progress?.reachedAt ?? null,
    previousNextWeek,
    weightPlan,
    weeklyDistanceKmTarget: u.user.weeklyDistanceKm,
    longRun: progress?.longRun ?? null,
    liftReturn: progress?.liftReturn ?? null,
    liftReturns: progress?.liftReturns ?? null,
    cardExplainedEst1rm: progress?.reasons?.some(r => r.kind === 'explainer') ?? false,
    raceDate: endurance ? u.user.raceDate : null,
    raceDistanceKm: endurance ? u.user.raceDistanceKm : null,
    racePeakWeekKm: endurance ? racePeakWeekKmAt(u, [weekStart, addDays(weekStart, 7)]) : null,
    runHistory: endurance ? runHistoryAt(u, addDays(weekStart, 6)) : undefined,
    unitSystem: u.units,
    exerciseDisplay: buildExerciseDisplay(displayRows),
    signupDay: signupLocalDay(new Date(`${u.user.createdDay}T10:00:00.000Z`), TZ),
  };
}

/** lib/brain/brief.ts: the endurance brief's weekly volume (any sport, newest first, last 4 weeks). */
function weeklyVolumeFor(u: FuzzUser): WeeklyVolumeRow[] {
  const buckets = new Map<string, WeeklyVolumeRow>();
  for (const w of workoutEntriesAt(u, u.todayKey, 30)) {
    const key = mondayOf(w.date);
    const row = buckets.get(key) ?? { weekStart: key, sessions: 0, minutes: 0 };
    row.sessions += 1;
    row.minutes += Math.round(typeof w.durationMin === 'number' ? w.durationMin : 0);
    buckets.set(key, row);
  }
  return [...buckets.values()].sort((a, b) => b.weekStart.localeCompare(a.weekStart)).slice(0, 4);
}

// ═══ Checks ═════════════════════════════════════════════════════════════════════════════════════════════

interface Failure {
  /** card | card@verdict | coach | opener | brief | review | alert */
  surface: string;
  check: 'throw' | 'text' | 'number' | 'cap' | 'shape';
  where: string;
  detail: string;
}

const LEAKED = /NaN|undefined|Infinity|\[object|\bnull\b/;
const SPACE_LIKE = '[ \\u00a0\\u202f\\u2009]';
const DOUBLE_SPACE = new RegExp(`${SPACE_LIKE}{2,}`);
const visible = (s: string): string => s.replace(/ /g, '␣').replace(/ /g, '⍽');

/** The coach / brief blocks are prompt text: a card reason is a two-space-indented sub-bullet ("  - Based on ..." in formatGoalProgressLines), which is markup, not stray whitespace. */
const PROMPT_SURFACES = new Set(['coach', 'brief']);

function checkText(out: Failure[], surface: string, where: string, text: string): void {
  const multi = text.includes('\n');
  for (const raw of text.split('\n')) {
    if (multi && raw === '') continue; // blank lines inside a multi-line coach block are fine
    const line = PROMPT_SURFACES.has(surface) ? raw.replace(/^ {2}(?=- )/, '') : raw;
    const leaked = LEAKED.exec(line);
    if (leaked) out.push({ surface, check: 'text', where, detail: `contains "${leaked[0]}": "${visible(line)}"` });
    if (/^\s/.test(line) || /\s$/.test(line)) out.push({ surface, check: 'text', where, detail: `leading or trailing space: "${visible(line)}"` });
    if (DOUBLE_SPACE.test(line)) out.push({ surface, check: 'text', where, detail: `double space: "${visible(line)}"` });
  }
}

/** Walks any output: every string through checkText, every number must be finite. Object keys are not user text. */
function scanValue(out: Failure[], surface: string, value: unknown, path: string): void {
  if (typeof value === 'string') checkText(out, surface, path, value);
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push({ surface, check: 'number', where: path, detail: `${String(value)} is not finite` });
  } else if (Array.isArray(value)) {
    value.forEach((x, i) => {
      if (x === undefined) out.push({ surface, check: 'shape', where: `${path}[${i}]`, detail: 'array element is undefined (JSON turns it into null)' });
      else scanValue(out, surface, x, `${path}[${i}]`);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [k, x] of Object.entries(value)) if (x !== undefined) scanValue(out, surface, x, `${path}.${k}`);
  } else if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    out.push({ surface, check: 'shape', where: path, detail: `unserialisable ${typeof value}` });
  }
}

function checkCard(out: Failure[], surface: string, gp: GoalProgress): void {
  scanValue(out, surface, gp, 'card');
  // The muscle "Building back" headline is allowed the longer rebuild cap (it names the furthest-behind lift); every other headline is clipped to HEADLINE_MAX_CHARS.
  const cap = gp.goal === 'muscle' && gp.verdict === 'building' && gp.liftReturn != null ? REBUILD_HEADLINE_MAX_CHARS : HEADLINE_MAX_CHARS;
  if (typeof gp.headline !== 'string' || gp.headline.trim() === '') out.push({ surface, check: 'shape', where: 'card.headline', detail: `headline is empty: ${JSON.stringify(gp.headline)}` });
  else if (gp.headline.length > cap) out.push({ surface, check: 'cap', where: 'card.headline', detail: `[${gp.headline.length} > ${cap}] "${visible(gp.headline)}"` });
  if (gp.reasons.length > 3) out.push({ surface, check: 'cap', where: 'card.reasons', detail: `${gp.reasons.length} reasons (max 3)` });
  JSON.stringify(gp); // the card is served as JSON
}

function checkReview(out: Failure[], surface: string, review: WeeklyReview): void {
  scanValue(out, surface, review, 'review');
  if (typeof review.headline !== 'string' || review.headline.trim() === '') out.push({ surface, check: 'shape', where: 'review.headline', detail: `headline is empty: ${JSON.stringify(review.headline)}` });
  else if (review.headline.length > REVIEW_HEADLINE_MAX_CHARS) out.push({ surface, check: 'cap', where: 'review.headline', detail: `[${review.headline.length} > ${REVIEW_HEADLINE_MAX_CHARS}] "${visible(review.headline)}"` });
  if (review.stats.length > MAX_REVIEW_STATS) out.push({ surface, check: 'cap', where: 'review.stats', detail: `${review.stats.length} stats (max ${MAX_REVIEW_STATS})` });
  review.stats.forEach((st, i) => {
    const c = st.comparison;
    if (c != null && c.length > STAT_COMPARISON_MAX_CHARS) out.push({ surface, check: 'cap', where: `review.stats[${i}].comparison`, detail: `[${c.length} > ${STAT_COMPARISON_MAX_CHARS}] ${st.label}: "${visible(c)}"` });
  });
  if (typeof review.nextWeek !== 'string' || review.nextWeek.trim() === '') out.push({ surface, check: 'shape', where: 'review.nextWeek', detail: `nextWeek is empty: ${JSON.stringify(review.nextWeek)}` });
  JSON.stringify(review);
}

/** Runs `fn`; a throw is recorded as a failure (with the top of the stack) and returns undefined. */
function guard<T>(out: Failure[], surface: string, where: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    const err = e as Error;
    const stack = (err?.stack ?? '').split('\n').slice(1, 4).map(s => s.trim().replace(/^at /, '')).join(' | ');
    out.push({ surface, check: 'throw', where, detail: `${err?.name ?? 'Error'}: ${err?.message} @ ${stack}` });
    return undefined;
  }
}

const PREVIOUS_NEXT_WEEK_POOL = [
  NO_NEED_TO_TIGHTEN_NEXT_WEEK,
  'Weigh in on a few mornings this week and your plan picks up from where it left off.',
  'Run about 18 km this week, with one long run of 8 km.',
  'Keep the same load on your main lifts and add one set to each.',
];

interface UserResult { failures: Failure[]; card?: GoalProgress; review?: WeeklyReview }

/** Everything the goal surfaces produce for one user. `failures` is empty for a healthy user. */
function runUser(u: FuzzUser): UserResult {
  const out: Failure[] = [];
  const runDay = u.todayKey;
  const kind = u.kind;

  // ── the goal card and the text derived from it ──
  const card = guard(out, 'card', 'computeGoalProgress', () => computeGoalProgress(buildGoalInput(u, u.todayKey, u.todayKey)));
  if (card) {
    checkCard(out, 'card', card);

    const coach = guard(out, 'coach', 'formatGoalProgressLines', () => formatGoalProgressLines(card, u.units));
    if (coach) scanValue(out, 'coach', coach, 'coach');

    const opener: Array<[string, () => string | null]> = [
      ['requiredOpenerLine', () => requiredOpenerLine(card, kind, u.units)],
      ['goalFallbackOpener', () => goalFallbackOpener(card, kind, u.units)],
      ['returningUserOpener', () => returningUserOpener(card)],
      ['goalOpenerLine', () => goalOpenerLine(card, u.units)],
      ['newUserGoalOpener', () => newUserGoalOpener(card.goal, card, u.units)],
    ];
    for (const [name, fn] of opener) {
      const text = guard(out, 'opener', name, fn);
      if (typeof text === 'string') checkText(out, 'opener', name, text);
    }

    const focus: BriefGoalFocus = {
      goal: kind,
      progress: card,
      progression: kind === 'muscle' ? summarizeProgression(setRowsAt(u, u.todayKey, 84)) : undefined,
      weeklyVolume: kind === 'endurance' ? weeklyVolumeFor(u) : undefined,
      todayKey: u.todayKey,
    };
    const brief = guard(out, 'brief', 'buildBriefGoalSection', () => buildBriefGoalSection(focus, u.units));
    if (typeof brief === 'string') checkText(out, 'brief', 'buildBriefGoalSection', brief);
  }

  // A user whose goal progress failed to load (the loaders swallow that) still gets an opener and a brief.
  for (const [name, fn] of [
    ['requiredOpenerLine(null)', () => requiredOpenerLine(null, kind, u.units)],
    ['goalFallbackOpener(null)', () => goalFallbackOpener(null, kind, u.units)],
    ['newUserGoalOpener(kind)', () => newUserGoalOpener(kind, null, u.units)],
  ] as Array<[string, () => string | null]>) {
    const text = guard(out, 'opener', name, fn);
    if (typeof text === 'string') checkText(out, 'opener', name, text);
  }
  const briefNone = guard(out, 'brief', 'buildBriefGoalSection(null)', () => buildBriefGoalSection({ goal: kind, progress: null, todayKey: u.todayKey }, u.units));
  if (typeof briefNone === 'string') checkText(out, 'brief', 'buildBriefGoalSection(null)', briefNone);

  // ── the Monday review: its goal-progress read is as of last Sunday, on the real clock `runDay` ──
  const weekStart = lastCompletedWeekStart(runDay);
  const verdictAsOf = localDayKey(endOfLocalWeek(weekStart, TZ), TZ);
  const verdictCard = guard(out, 'card@verdict', 'computeGoalProgress', () => computeGoalProgress(buildGoalInput(u, verdictAsOf, runDay)));
  if (verdictCard) checkCard(out, 'card@verdict', verdictCard);

  const r = makeRandom(u.seed ^ 0x5bd1e995);
  const previousNextWeek = chance(r, 0.4) ? null : pick(r, PREVIOUS_NEXT_WEEK_POOL);
  const parts = { progress: verdictCard ?? null, comingWeekProgress: kind === 'weight_loss' ? card ?? null : null };
  const review = guard(out, 'review', 'computeWeeklyReview', () => computeWeeklyReview(buildReviewInput(u, runDay, { ...parts, previousNextWeek })));
  if (review) {
    checkReview(out, 'review', review);
    const alert = guard(out, 'alert', 'weeklyReviewAlert', () => weeklyReviewAlert(review));
    if (alert) scanValue(out, 'alert', alert, 'alert');
    // The same review recomputed with this week's tip as "last week's": the no-repeat branch.
    const again = guard(out, 'review', 'computeWeeklyReview(previousNextWeek=own)', () => computeWeeklyReview(buildReviewInput(u, runDay, { ...parts, previousNextWeek: review.nextWeek })));
    if (again) checkReview(out, 'review', again);
  }
  return { failures: out, card, review };
}

const checkUser = (u: FuzzUser): Failure[] => runUser(u).failures;

// ═══ Reporting ══════════════════════════════════════════════════════════════════════════════════════════

function summarize(u: FuzzUser): string {
  const t = u.user;
  const bits = [
    `seed=${u.seed} kind=${u.kind} index=${u.index} today=${u.todayKey} (${weekdayOf(u.todayKey)}) units=${u.units} sex=${u.sex}`,
    `target={kg:${t.targetWeightKg} date:${t.targetDate} sessions:${t.weeklySessions} km/wk:${t.weeklyDistanceKm}} race={${t.raceDate}/${t.raceDistanceKm}km}`,
    `goalStart={day:${t.goalStartedDay} kg:${t.goalStartWeightKg}} budget=${u.budget.mode}(${u.budget.targetKcal}kcal)`,
    `rows={weighins:${u.weights.length} workouts:${u.workouts.length} sets:${u.sets.length} intakeDays:${u.intake.size} rhr:${u.restingHr.length} hrv:${u.hrv.length} sleep:${u.sleepMinutes.length}}`,
    `tags=[${u.tags.join(' ')}]`,
  ];
  return bits.join('\n      ');
}

function dump(u: FuzzUser): string {
  return JSON.stringify({ ...u, intake: [...u.intake.entries()] }, null, 1);
}

const normalize = (f: Failure): string =>
  `${f.surface} | ${f.check} | ${f.where.replace(/\[\d+\]/g, '[]')} | ${f.detail.replace(/\d+(\.\d+)?/g, '#').replace(/"[^"]{40,}"/g, '"…"').slice(0, 90)}`;

function describeFailures(kind: GoalKind, count: number, failures: Array<{ user: FuzzUser; failure: Failure }>): string {
  const groups = new Map<string, Array<{ user: FuzzUser; failure: Failure }>>();
  for (const x of failures) {
    const key = normalize(x.failure);
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  const lines = [`${kind}: ${failures.length} failure(s) in ${groups.size} distinct signature(s) over ${count} users`];
  for (const [key, xs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    const users = new Set(xs.map(x => x.user.index));
    lines.push(`\n  [${xs.length} failure(s), ${users.size} user(s)] ${key}`);
    const first = xs[0];
    lines.push(`    ${first.failure.surface}/${first.failure.where}: ${first.failure.detail}`);
    lines.push(`    e.g. ${summarize(first.user)}`);
    lines.push(`    other users: ${[...users].slice(1, 8).map(i => `${kind}:${i}`).join(' ') || '(none)'}`);
  }
  return lines.join('\n');
}

const only = process.env.FUZZ_ONLY?.split(':');

// ═══ The tests ══════════════════════════════════════════════════════════════════════════════════════════

test('the generator is deterministic and covers every weekday', () => {
  assert.equal(weekdayOf(MONDAY0), 'Mon');
  for (const kind of KINDS) {
    const a = makeUser(kind, 5);
    const b = makeUser(kind, 5);
    assert.equal(dump(a), dump(b), `${kind}: the same seed must give the same user`);
    const weekdays = new Set(Array.from({ length: 14 }, (_, i) => weekdayOf(makeUser(kind, i).todayKey)));
    assert.equal(weekdays.size, 7, `${kind}: 14 consecutive users must hit all 7 weekdays`);
  }
});

/** FUZZ_USERS=5000 hunts deeper than the committed run (users beyond USERS are generated the same way, just more of them). */
const countFor = (kind: GoalKind): number => Number(process.env.FUZZ_USERS) || USERS[kind];

for (const kind of KINDS) {
  test(`${kind}: ${USERS[kind]} messy users, every goal surface (card, coach text, opener, brief, weekly review, push alert)`, t => {
    const started = Date.now();
    const failures: Array<{ user: FuzzUser; failure: Failure }> = [];
    let ran = 0;
    // What the users actually produced. The fuzz must not pass merely because the generator went degenerate (everyone "insufficient_data"):
    // the same trap lib/insights/nullCanary.test.ts closes with its "still finds a planted effect" test.
    const verdicts = new Map<string, number>();
    const phases = new Map<string, number>();
    const weightStates = new Map<string, number>();
    let reviews = 0;
    let sufficientReviews = 0;
    let reviewsWithSlip = 0;
    let liftReturnCards = 0;
    for (let index = 0; index < countFor(kind); index++) {
      if (only && (only[0] !== kind || Number(only[1]) !== index)) continue;
      const user = makeUser(kind, index);
      if (process.env.FUZZ_DUMP) console.log(dump(user));
      const result = runUser(user);
      if (process.env.FUZZ_PRINT) console.log(JSON.stringify({ card: result.card, review: result.review }, null, 1));
      ran += 1;
      for (const failure of result.failures) failures.push({ user, failure });
      const card = result.card;
      if (card) {
        verdicts.set(card.verdict, (verdicts.get(card.verdict) ?? 0) + 1);
        if (card.race?.phase) phases.set(card.race.phase, (phases.get(card.race.phase) ?? 0) + 1);
        if (card.weightRead?.state) weightStates.set(card.weightRead.state, (weightStates.get(card.weightRead.state) ?? 0) + 1);
        if (card.liftReturn) liftReturnCards += 1;
      }
      if (result.review) {
        reviews += 1;
        if (result.review.dataSufficiency.sufficient) sufficientReviews += 1;
        if (result.review.slip) reviewsWithSlip += 1;
      }
    }
    const show = (m: Map<string, number>): string => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}=${n}`).join(' ') || '(none)';
    t.diagnostic(`${kind}: ${ran} users in ${Date.now() - started} ms; reviews ${reviews}, sufficient ${sufficientReviews}, with a slip ${reviewsWithSlip}`);
    t.diagnostic(`${kind}: card verdicts ${show(verdicts)}; race phases ${show(phases)}; weight reads ${show(weightStates)}; cards in a lift return ${liftReturnCards}`);
    assert.equal(failures.length, 0, describeFailures(kind, ran, failures));

    if (only) return; // a single-user repro has no spread to judge
    const decided = ran - (verdicts.get('insufficient_data') ?? 0) - (verdicts.get('needs_target') ?? 0);
    assert.ok(decided / ran >= 0.3, `${kind}: only ${decided}/${ran} cards reached a real verdict: the generator went degenerate (${show(verdicts)})`);
    assert.ok(sufficientReviews / ran >= 0.3, `${kind}: only ${sufficientReviews}/${ran} weekly reviews had enough data: the generator went degenerate`);
    assert.ok(reviewsWithSlip >= 10, `${kind}: only ${reviewsWithSlip} reviews carried a slip`);
    if (kind === 'muscle') assert.ok(liftReturnCards >= 5, `muscle: only ${liftReturnCards} cards were in a return from a break (the building-back headlines went untested)`);
    if (kind === 'endurance') for (const phase of ['taper', 'race_week', 'recovery']) assert.ok((phases.get(phase) ?? 0) >= 5, `endurance: only ${phases.get(phase) ?? 0} cards in the ${phase} phase (${show(phases)})`);
    if (kind === 'weight_loss') assert.ok(weightStates.size >= 4, `weight_loss: only ${weightStates.size} weight-read states seen (${show(weightStates)})`);
  });
}

// Exposed so a failure can be minimised from a scratch script (import this module with FUZZ_ONLY=none:0 to skip the sweeps).
export { makeUser, buildGoalInput, buildReviewInput, runUser };
