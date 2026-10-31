/**
 * Shared types and calendar helpers for the day-by-day timeline suite (see README.md).
 * Pure: no DB, no network, no clock.
 */
import type { GoalKind, GoalProgress } from '../goalProgress';
import type { WeeklyReview } from '../weeklyReview';

export type Units = 'metric' | 'imperial';

export interface WeighIn { day: string; kg: number }
/** HealthKit-like workout row: the shape daily_metrics 'workouts' payload items have (distance in metres). */
export interface WorkoutRow { day: string; type: string; durationMin: number | null; distanceM: number | null }
export interface SetRow { day: string; exercise: string; display: string; reps: number; loadKg: number | null; rpe: number | null; isWarmup: boolean }
export interface IntakeRow { day: string; kcal: number; proteinG: number }

/** A synthetic user history: raw ROWS (what the DB would hold), never inputs. engine.ts turns rows into inputs. */
export interface Scenario {
  name: string;
  title: string;
  goal: GoalKind;
  profile: { sex: 'male' | 'female'; age: number; heightCm: number; startWeightKg: number; units: Units };
  day0: string;
  /** Last day index stepped (inclusive). */
  lastDay: number;
  user: {
    targetWeightKg: number | null;
    targetDate: string | null;
    weeklySessions: number | null;
    weeklyDistanceKm: number | null;
    raceDate: string | null;
    raceDistanceKm: number | null;
    goalStartWeightKg: number | null;
    /** Local day goal_started_at / users.created_at fall on. */
    goalStartedDay: string;
    createdDay: string;
    sleepGoalMinutes: number;
  };
  /** Approximation of resolveDietBudget(): custom-style target; the floor is sex-aware (engine.ts). */
  budget: { targetKcal: number | null; proteinG: number | null };
  weighIns: WeighIn[];
  workouts: WorkoutRow[];
  sets: SetRow[];
  intake: IntakeRow[];
  inputNotes: string[];
  /** Only these day indexes are stepped (the imperial variant). Default: all. */
  dayFilter?: (idx: number, date: string) => boolean;
  /**
   * Wave 27: Injury facts the user logged (nodes of type Injury): the label as stored, the local day it was logged (nodes.created_at)
   * and, when the user later retired it (resolve_fact), the local day it stopped being active. engine.ts feeds the real picker
   * (lib/injuryCheckIn.ts) the facts that are active on the day it steps. Absent: no injury facts.
   */
  injuries?: Array<{ label: string; loggedDay: string; resolvedDay?: string }>;
}

/** One Monday weekly review as the loader would produce it (plus the push alert text). */
export interface ReviewResult {
  weekStart: string;
  /** The day the review job runs on (a Monday). */
  runDay: string;
  /** The `todayKey` the goal-progress verdict was evaluated at (Sunday = endOfLocalWeek). */
  verdictAsOf: string;
  progress: GoalProgress;
  racePeakWeekKm: number | null;
  review: WeeklyReview;
  alert: { title: string; body: string };
}

/**
 * Everything the app would show on one simulated day (state = END of that day).
 * `card` is the whole GET /api/goal/progress payload; `reasons` and `distanceText` are views onto it.
 */
export interface DaySnapshot {
  scenario: string;
  /** Day index since the scenario's day 0. */
  idx: number;
  date: string;
  weekday: string;
  /** One line describing what the synthetic user logged that day (input, not app output). */
  activity: string;
  race: { daysToRace: number; phase: string } | null;
  card: GoalProgress | null;
  reasons: GoalProgress['reasons'];
  distanceText: string | null;
  /** formatGoalProgressLines: the coach's "Goal progress" block. */
  coach: string[] | null;
  /** requiredOpenerLine / goalFallbackOpener (the model's extra sentence cannot be produced). */
  opener: { required: string | null; fallback: string | null } | null;
  /** The weekly review of the week just finished; Mondays from day 7 only. */
  review: ReviewResult | null;
  /** Exceptions thrown by the real functions that day (empty on a healthy day). */
  errors: string[];
}

// ── Tiny date helpers (calendar math, no timezone) ──────────────────────────

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dayDiff(a: string, b: string): number {
  const f = (s: string): number => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
  return f(a) - f(b);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
