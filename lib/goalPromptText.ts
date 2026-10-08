/**
 * Vital — goal progress as prompt text (pure, no DB or Next.js imports)
 *
 * Renders the deterministic goal-progress verdict (lib/goalProgress.ts) for
 * the two LLM surfaces — the coach's context (lib/brain/context.ts) and the
 * daily brief (lib/claude.ts) — so neither can contradict the Trends/Today
 * goal card. Weight numbers are shown in the user's unit; storage stays kg.
 */

import type { GoalKind, GoalProgress } from './goalProgress';
import type { ProgressionSummary } from './workoutRepository';
import { plainSpaces } from './displayText';
import { liftChange4w } from './liftChange';
import { weekStartKeyForDay } from './localDay';
import { KM_PER_MILE, LB_PER_KG } from './metricFormat';
import type { UnitSystem } from './units';

const GOAL_LABELS: Record<GoalKind, string> = {
  weight_loss: 'fat loss',
  muscle: 'muscle gain',
  endurance: 'endurance',
  general: 'general health',
};

const MAX_REASONS = 5;

function wt(kg: number, units: UnitSystem, digits = 1): string {
  const v = units === 'imperial' ? kg * LB_PER_KG : kg;
  return `${v.toFixed(digits)} ${units === 'imperial' ? 'lb' : 'kg'}`;
}

function signedWt(kg: number, units: UnitSystem, digits = 1): string {
  return `${kg > 0 ? '+' : ''}${wt(kg, units, digits)}`;
}

/**
 * Compact (<= ~12 lines) "Goal progress" lines for the coach context.
 * Always includes the verdict + headline so the coach quotes the same call
 * the app shows.
 */
export function formatGoalProgressLines(gp: GoalProgress, units: UnitSystem): string[] {
  const lines: string[] = [];

  const targetBits: string[] = [];
  if (gp.target.weightKg != null) targetBits.push(`target ${wt(gp.target.weightKg, units)}`);
  if (gp.target.date) targetBits.push(`by ${gp.target.date}`);
  if (gp.target.weeklySessions != null) targetBits.push(`${gp.target.weeklySessions} sessions/week`);
  if (gp.target.weeklyDistanceKm != null) {
    targetBits.push(units === 'imperial'
      ? `${(gp.target.weeklyDistanceKm / KM_PER_MILE).toFixed(1)} mi/week`
      : `${gp.target.weeklyDistanceKm.toFixed(1)} km/week`);
  }
  const hasTarget = targetBits.length > 0;
  lines.push(`- Goal: ${GOAL_LABELS[gp.goal]}; ${hasTarget ? targetBits.join(', ') : 'no target set'}`);

  const nowBits: string[] = [];
  if (gp.current.weightKg != null) {
    nowBits.push(`trend ${wt(gp.current.weightKg, units)}`);
    if (gp.current.startWeightKg != null && gp.current.changeKg != null) {
      nowBits.push(`${signedWt(gp.current.changeKg, units)} since start at ${wt(gp.current.startWeightKg, units)}`);
    }
  }
  if (gp.ratePerWeek.kg != null) {
    const pct = gp.ratePerWeek.pctBodyweight != null ? ` (${gp.ratePerWeek.pctBodyweight}% bw)` : '';
    nowBits.push(`rate ${signedWt(gp.ratePerWeek.kg, units, 2)}/wk${pct}`);
  }
  if (gp.distance?.thisWeekKm != null) nowBits.push(plainSpaces(gp.distance.text));
  if (gp.eta) nowBits.push(`ETA ${gp.eta}`);
  if (gp.onPaceForTargetDate != null) nowBits.push(gp.onPaceForTargetDate ? 'on pace for target date' : 'not on pace for target date');
  if (gp.race) {
    const when = gp.race.daysToGo === 0 ? 'today'
      : gp.race.weeksToGo === 0 ? `in ${gp.race.daysToGo} day${gp.race.daysToGo === 1 ? '' : 's'}`
      : `in ${gp.race.weeksToGo} week${gp.race.weeksToGo === 1 ? '' : 's'}`;
    lines.push(`- Race: ${gp.race.label} on ${gp.race.date} (${when})`);
  }
  if (gp.longRun) {
    const dist = (km: number) => (units === 'imperial' ? `${(km / KM_PER_MILE).toFixed(1)} mi` : `${km.toFixed(1)} km`);
    const target = gp.longRun.targetPeakKm != null ? `; peak target ${dist(gp.longRun.targetPeakKm)} before the taper` : '';
    lines.push(`- Long run (running only): last ${dist(gp.longRun.lastKm)}; 28-day peak ${dist(gp.longRun.peakKm)}${target}`);
  }
  if (nowBits.length) lines.push(`- Now: ${nowBits.join('; ')}`);

  lines.push(`- Verdict: ${gp.verdict} — "${plainSpaces(gp.headline)}"`);
  for (const r of gp.reasons.slice(0, MAX_REASONS)) {
    lines.push(`  - ${plainSpaces(r.text)}${r.tone === 'watch' ? ' (watch)' : ''}`);
  }
  if (gp.verdict === 'needs_target') {
    lines.push('- No target set yet — setting one is the only thing missing for a real progress verdict.');
  }
  return lines;
}

// ── Daily brief goal block ──────────────────────────────────────────────────

export interface WeeklyVolumeRow {
  weekStart: string;
  sessions: number;
  minutes: number;
}

export interface BriefGoalFocus {
  goal: GoalKind;
  /** Null when the loader failed or the user is unknown — the block then says progress is unavailable. */
  progress: GoalProgress | null;
  /** Muscle goal: weekly best e1RM per lift (getProgressionSummary). */
  progression?: ProgressionSummary;
  /** User's local day key (YYYY-MM-DD); anchors the shared "vs 4 weeks ago" lift change (lib/liftChange.ts). */
  todayKey?: string;
  /** Endurance goal: all-sport weekly sessions/minutes, newest first. */
  weeklyVolume?: WeeklyVolumeRow[];
}

function topLiftLines(progression: ProgressionSummary, units: UnitSystem, todayKey?: string): string[] {
  const anchor = todayKey ? weekStartKeyForDay(todayKey) : null;
  const rows = Object.entries(progression)
    .map(([exercise, weeks]) => ({
      exercise,
      weeks,
      withE1rm: weeks.filter(w => w.bestEstimatedOneRepMaxKg != null),
      sets: weeks.reduce((s, w) => s + w.totalSets, 0),
    }))
    .filter(r => r.withE1rm.length > 0)
    .sort((a, b) => b.sets - a.sets)
    .slice(0, 3);
  return rows.map(r => {
    // The ONE lift-change definition (lib/liftChange.ts) — the same
    // "vs 4 weeks ago" number the Trends card, weekly review and goal reasons
    // quote, so the coach never says a different figure for the same lift.
    const change = anchor ? liftChange4w(r.weeks, anchor) : null;
    if (change) {
      const sign = change.changeKg > 0 ? '+' : change.changeKg < 0 ? '-' : '';
      return `- ${r.exercise}: est. 1RM ${sign}${wt(Math.abs(change.changeKg), units)} vs 4 weeks ago (${wt(change.baselineKg, units, 0)} -> ${wt(change.recentKg, units, 0)})`;
    }
    const latest = r.withE1rm[r.withE1rm.length - 1].bestEstimatedOneRepMaxKg as number;
    return `- ${r.exercise}: est. 1RM ${wt(latest, units, 0)} (no 4-week comparison yet)`;
  });
}

/**
 * Goal-keyed input block for the daily brief prompt. Fat loss and muscle
 * lean on the verdict + reasons (calorie adherence, protein, sessions, lift
 * e1RM, rate); endurance adds all-sport weekly volume; general is the
 * consistency verdict. Weight-signal and recovery sections are rendered
 * elsewhere in the prompt.
 */
export function buildBriefGoalSection(focus: BriefGoalFocus, units: UnitSystem): string {
  const out: string[] = [`\n## Goal Progress (${GOAL_LABELS[focus.goal]}) — the app shows this same verdict; never contradict it`];
  if (focus.progress) {
    out.push(...formatGoalProgressLines(focus.progress, units));
  } else {
    out.push('- Goal progress is unavailable right now — do not state or imply a progress verdict.');
  }

  if (focus.goal === 'muscle' && focus.progression) {
    const lifts = topLiftLines(focus.progression, units, focus.todayKey);
    if (lifts.length) out.push('Lift progression (top lifts):', ...lifts);
  }

  if (focus.goal === 'endurance' && focus.weeklyVolume?.length) {
    out.push('Weekly training volume, any sport (newest first):');
    for (const w of focus.weeklyVolume) {
      out.push(`- week of ${w.weekStart}: ${w.sessions} session${w.sessions === 1 ? '' : 's'}, ${w.minutes} min`);
    }
  }

  const focusLine: Record<GoalKind, string> = {
    weight_loss: 'Center the day on the trend rate, calorie adherence and the weight signals; frame today\'s meals around the verdict.',
    muscle: 'Center the day on hitting the weekly session target, lift progression and protein.',
    endurance: 'Center the day on weekly volume, load and recovery.',
    general: 'Center the day on consistency — movement, sleep and logging — not on any weight number.',
  };
  out.push(focusLine[focus.goal]);
  return out.join('\n');
}
