/**
 * Vital — goal progress as prompt text (pure, no DB or Next.js imports)
 *
 * Renders the deterministic goal-progress verdict (lib/goalProgress.ts) for
 * the two LLM surfaces — the coach's context (lib/brain/context.ts) and the
 * daily brief (lib/claude.ts) — so neither can contradict the Trends/Today
 * goal card. Weight numbers are shown in the user's unit; storage stays kg.
 */

import type { GoalKind, GoalProgress } from './goalProgress';
import { RACE_EVE_LINE, RESTART_LONG_RUN_MAX_SHARE, STRIDES_COPY, floorLongRunKm, formatRaceTime, formatTargetLongRun, isWindDownPhase, lightWeekLine, longRunCapNote, midWeekRestartText, racePaceReps, recoveryWeek, restOfWeekPhrase, roundLongRunKm, skippedCutbackHoldReason } from './enduranceProgression';
import type { ProgressionSummary } from './workoutRepository';
import { plainSpaces } from './displayText';
import { liftBaselineLabel, liftChange4w, liftLapseMinDays, liftReturnDisplay, pickHeadlineLift, rankLifts } from './liftChange';
import { weekStartKeyForDay } from './localDay';
import { KM_PER_MILE, LB_PER_KG } from './metricFormat';
import { shortDate } from './brain/openerText';
import { isInstruction } from './weightWeekPlan';
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

function distKm(km: number, units: UnitSystem): string {
  return units === 'imperial' ? `${(km / KM_PER_MILE).toFixed(1)} mi` : `${km.toFixed(1)} km`;
}

function signedWt(kg: number, units: UnitSystem, digits = 1): string {
  return `${kg > 0 ? '+' : ''}${wt(kg, units, digits)}`;
}

/** A planned distance (the long run) in the coach's plain spaces: imperial rounded to the nearest half mile. */
function longRunText(km: number, units: UnitSystem): string {
  return plainSpaces(formatTargetLongRun(km, units === 'imperial' ? 1 / KM_PER_MILE : 1));
}

/** "21.1 km in 2:01" for the race the runner just ran (the time only when known). */
function racedText(completed: { km: number; durationMin: number | null }, units: UnitSystem): string {
  const time = formatRaceTime(completed.durationMin);
  return `${distKm(completed.km, units)}${time ? ` in ${plainSpaces(time)}` : ''}`;
}

/**
 * One line for the race lifecycle so the coach never pushes volume in a taper,
 * race week or recovery: the phase and this week's target (the same number as
 * `distance.stepTargetKm`, which carries the phase target in these weeks). Race
 * day and the day after have their own variants: before a race-length run is
 * logged, "start relaxed"; once it is, "the race is done — congratulate them".
 * Null in the build phase and without a race.
 */
function racePhaseLine(gp: GoalProgress, units: UnitSystem): string | null {
  const race = gp.race;
  if (!race || !isWindDownPhase(race.phase)) return null;
  const target = gp.distance != null ? distKm(gp.distance.stepTargetKm, units) : null;
  const longRun = gp.distance?.plan?.longRunKm;
  const rep = plainSpaces(racePaceReps(units === 'imperial' ? 1 / KM_PER_MILE : 1));
  switch (race.phase) {
    case 'taper':
      // Wave 23e: the taper's km are run before its long run: skip it (the card says the same).
      if (gp.distance?.plan?.longRunTrim?.weekDone === true) {
        return `- Race phase: taper${target ? ` — this week's target ~${target}` : ''}; the week's km are done: skip the long run (rest or a 20-min jog), plus ${rep} at race pace midweek if not yet run — do not push volume`;
      }
      // Wave 23e P3-m: a taper week at last week's own volume holds it ("hold the volume at ~22.0 km (75% of the ~29.3 km peak)"), it does not cut it.
      return `- Race phase: taper${target ? ` — this week's target ~${target}` : ''}; ${gp.distance?.plan?.taperHold === true && target != null && gp.distance.plan.taperPeakKm != null ? `hold the volume at ~${target} (${Math.round((gp.distance.stepTargetKm / gp.distance.plan.taperPeakKm) * 100)}% of the ~${distKm(gp.distance.plan.taperPeakKm, units)} peak)` : 'cut volume'}, ${longRun != null ? `long run ${longRunText(longRun, units)} easy, ` : 'keep the long run easy, '}plus ${rep} at race pace midweek — do not push volume or build the long run`;
    case 'race_week':
      if (race.daysToGo === 0) {
        return race.completed
          ? `- Race phase: race day, and the race is DONE (${racedText(race.completed, units)}) — congratulate them; recovery starts now, no training advice`
          : '- Race phase: race day — warm up easy and start relaxed; no training advice, no volume talk';
      }
      if (race.daysToGo === 1) {
        return `- Race phase: race tomorrow — ${plainSpaces(RACE_EVE_LINE.replace(/^Race tomorrow — /, ''))}; no training advice, no volume talk, no remarks about this week's distance`;
      }
      return `- Race phase: race week${target ? ` — ~${target} before the race at most` : ''}; short easy runs, rest 1–2 days before race day — no new volume or hard sessions`;
    case 'recovery': {
      const done = race.completed && (race.daysSince ?? 99) <= 1 ? `just raced (${racedText(race.completed, units)}) — congratulate them; ` : '';
      const week = recoveryWeek(race.daysSince ?? 1);
      // The next-goal nudge is for recovery week 1 only, and never offers a weekly distance target the runner already has.
      const next = week === 1
        ? gp.target.weeklyDistanceKm != null
          ? ' — the next step is a new goal (a new race or maintenance)'
          : ' — the next step is a new goal (a new race, a weekly distance target, or maintenance)'
        : '';
      return `- Race phase: ${done}recovery week ${week} after the race${target ? ` — easy only, up to ${target}` : ' — easy only'}; do not push volume or intensity${next}`;
    }
  }
}

/**
 * "This week's target" for the build weeks, from the same week plan the goal card
 * and the weekly review read — one number, and what to do with it. Not in
 * taper / race week / recovery (the race phase line owns those).
 */
function weekTargetLine(gp: GoalProgress, units: UnitSystem): string | null {
  const line = weekTargetBase(gp, units);
  const trim = gp.distance?.plan?.longRunTrim;
  if (line == null || trim == null) return line;
  // Wave 23e / 24e: the week's km plus the planned long run were over the week's limit (or the week's km are all but run): the rest of the week is worded by
  // `restOfWeekPhrase`, the ONE wording the card's remaining-km line, plan line and headline use too. On the last day with today's run in, the numbers are
  // Saturday's and there is nothing left to say (the plan line keeps the trimmed long run).
  if (trim.afterRun === true) return line;
  const plan = gp.distance?.plan;
  const unitsPerKm = units === 'imperial' ? 1 / KM_PER_MILE : 1;
  const target = plan?.targetKm ?? gp.distance?.stepTargetKm ?? null;
  const core = plainSpaces(restOfWeekPhrase(trim, { unitsPerKm, longRunKm: plan?.longRunKm ?? null, longRunAhead: plan?.longRunAhead === true, form: 'coach', targetKm: target }));
  const note = ` — ${core}`;
  return `${line}${note}`;
}

function weekTargetBase(gp: GoalProgress, units: UnitSystem): string | null {
  const d = gp.distance;
  if (!d || isWindDownPhase(gp.race?.phase)) return null;
  const plan = d.plan;
  const goal = distKm(d.targetKm, units);
  if (!plan) {
    // No plan (nothing measured yet): the safe step over last week when it is below the goal.
    return d.stepTargetKm < d.targetKm
      ? `- This week's target: build to ~${distKm(d.stepTargetKm, units)} (a safe ~10% step over last week); the ${goal}/week goal comes after — do not push past the step this week`
      : null;
  }
  const t = plan.targetKm != null ? distKm(plan.targetKm, units) : null;
  // (A trimmed long run is said once, by the note `weekTargetLine` adds - "keep Sunday's long run to ~6 km" - not also as "long run 6 km held / eased".)
  const trimmed = plan.longRunTrim != null;
  const lr = plan.longRunKm != null && !trimmed ? `long run ${longRunText(plan.longRunKm, units)}` : null;
  const back = plan.comebackKm != null ? distKm(plan.comebackKm, units) : null;
  const strides = plan.strides ? `; ${STRIDES_COPY}` : '';
  // Days off in the week (or well behind its pace from Friday): the same line the card shows, as an instruction.
  if (plan.lightWeek) {
    const line = plainSpaces(lightWeekLine({ reason: 'days_off', daysOff: 0, longRunCapKm: plan.longRunKm }, units === 'imperial' ? 1 / KM_PER_MILE : 1));
    return `- This week's target: ${line.charAt(0).toLowerCase()}${line.slice(1)}; no catch-up volume, and do not call the week behind`;
  }
  // The week before a taper whose target is out of reach (or done short): easing off is fine - the card's own plan line, as an instruction.
  if (plan.easingOff) {
    const line = plainSpaces(plan.purpose);
    return `- This week's target: ${line.charAt(0).toLowerCase()}${line.slice(1)}; no catch-up volume, and do not call the week behind`;
  }
  // Every 4th plain build / maintain week: ~80% of the week it replaces, the long run held.
  if (plan.cutback) {
    // The long run is held where it was - unless the lowered week cannot carry it (never more than half of it): then it is "eased".
    const last = gp.longRun?.lastKm;
    const unitsPerKm = units === 'imperial' ? 1 / KM_PER_MILE : 1;
    const eased = plan.longRunKm != null && last != null && (last - plan.longRunKm) * unitsPerKm >= 0.5 - 1e-9;
    const longPart = plan.longRunKm == null || trimmed ? '' : eased ? `; long run eased to ${longRunText(plan.longRunKm, units)} (half the week)` : `; ${lr} held`;
    return `- This week's target: a cutback week, ~${t}${longPart} — absorb the last three weeks; do not push past it${strides}`;
  }
  switch (plan.kind) {
    case 'baseline':
      return "- This week's target: none yet — a baseline week; next week's step is built from this week's total";
    case 'build': {
      // The step the plan actually asks for, not a fixed "~10%": a comeback after a break climbs faster.
      // Wave 23e: the week after a cutback steps from the last full week before it - said so, so the coach never quotes the % against the cutback.
      const stepBase = plan.stepAfterCutback === true && plan.stepBaseKm != null ? distKm(plan.stepBaseKm, units) : null;
      const step = plan.stepPct != null
        ? `a ${plan.stepPct > 0 ? '+' : plan.stepPct < 0 ? '−' : ''}${Math.abs(plan.stepPct)}% step on ${stepBase != null ? `your last full week (${stepBase}), back on the build after the cutback` : 'last week'}`
        : 'the next step over last week';
      const climb = back != null && plan.targetKm != null && plan.comebackKm != null && plan.targetKm < plan.comebackKm - 0.5
        ? `, climbing back toward the ~${back} week from before the break`
        : '';
      // A comeback target lifted above the plain step is a ceiling for a careful comeback ("up to"), not a bar to clear.
      if (plan.upTo) {
        // Last week ran a touch over its ceiling: that is fine, and the ceiling climbs from the ceiling (never from the overshoot).
        if (plan.overCap) {
          return `- This week's target: build up to ~${t} (last week ran a touch over its ceiling — fine, said once; the new ceiling climbs from the old one, not from the overshoot${climb}${lr ? `; ${lr}` : ''}); the ${goal}/week goal comes after — do not push past it this week${strides}`;
        }
        return `- This week's target: build up to ~${t} (a ceiling for a careful comeback${climb}${lr ? `; ${lr}` : ''}); the ${goal}/week goal comes after — do not push past it this week${strides}`;
      }
      return `- This week's target: build to ~${t} (${step}${climb}${lr ? `; ${lr}` : ''}); the ${goal}/week goal comes after — do not push past the step this week${strides}`;
    }
    case 'maintain': {
      // The long run keeps growing only toward a peak it has not reached yet, in the runner's unit.
      const lrc = gp.longRun;
      // A held long run (after last week's jump) is not growing, whatever the peak says.
      const growing = plan.longRunHeld !== true && lrc != null && lrc.targetPeakKm != null
        && roundLongRunKm(lrc.peakKm, units === 'imperial' ? 1 / KM_PER_MILE : 1) < roundLongRunKm(lrc.targetPeakKm, units === 'imperial' ? 1 / KM_PER_MILE : 1);
      const grow = growing ? ` (the long run keeps growing ~${units === 'imperial' ? '1 mi' : '2 km'} a week toward its peak)` : '';
      if (plan.goalReachedBefore === false) {
        return `- This week's target: build to the ${goal}/week goal${lr ? `; ${lr}${plan.longRunHeld ? ' (held)' : grow}` : ''}, the rest easy — the first week at the goal, do not go past it${strides}`;
      }
      // Wave 23e P3-c: reached before, but last week fell short of it (a cutback, a 28 km week): back TO the goal, not "hold" a number he has not just run.
      if (plan.lastAtGoal === false) {
        return `- This week's target: build back to the ${goal}/week goal${lr ? `; ${lr}${plan.longRunHeld ? ' (held)' : grow}` : ''}, the rest easy — last week was under it, so build back to the goal and do not go past it${strides}`;
      }
      return `- This week's target: hold the ${goal}/week goal${lr ? `; ${lr}${plan.longRunHeld ? ' (held)' : grow}` : ''}, the rest easy — the runner is at the goal, do not add volume${strides}`;
    }
    case 'hold':
      // A cutback week that ran more than 10% over its lowered number: hold at the week it replaced.
      if (plan.skippedCutback) {
        const why = skippedCutbackHoldReason(plan.lastKm, plan.targetKm ?? 0, units === 'imperial' ? 1 / KM_PER_MILE : 1);
        return `- This week's target: hold ~${t} — last week's cutback ran as a normal week (fine, not a failure); ${why.easier ? 'an easier week before building again, so ' : ''}do not build 10% on it, and do not scold${strides}`;
      }
      // A comeback week far past its "up to" ceiling: stay at that ceiling.
      if (plan.overCapRead === 'well') {
        return `- This week's target: stay at ~${t} — last week was well over its comeback ceiling (a spike); do not build on the jump, and do not praise the extra distance${strides}`;
      }
      return `- This week's target: hold ~${t} — last week was over the ${plan.lastCutback === true ? 'cutback' : 'safe step'}; do not push higher or step up from the jump${strides}`;
    case 'restart': {
      // Wave 23e P3-h: on a break the plan's long run comes from the week's own number, but the line quotes the RESTART number (a lower band past two weeks
      // off): the long run shown with it is at most 40% of that number ("restart at ~12 km; long run 4.5 km", never 6.5 km = 54%).
      const restartKm = plan.restartKm ?? plan.targetKm;
      const unitsPerKm = units === 'imperial' ? 1 / KM_PER_MILE : 1;
      const restartLongKm = plan.longRunKm != null && restartKm != null
        ? Math.min(plan.longRunKm, floorLongRunKm(restartKm * RESTART_LONG_RUN_MAX_SHARE, unitsPerKm))
        : plan.longRunKm;
      const restartLr = restartLongKm != null && restartLongKm > 0 ? `long run ${longRunText(restartLongKm, units)}` : null;
      // Wave 24e: a restart that begins mid-week is scaled to the days left (the next Monday is the full restart week).
      const mid = plan.midWeekRestart;
      const upk = units === 'imperial' ? 1 / KM_PER_MILE : 1;
      if (mid != null && !mid.pending) {
        const stub = plainSpaces(midWeekRestartText(mid, upk, 'stub'));
        return `- This week's target: ${stub.charAt(0).toLowerCase()}${stub.slice(1)} — the runner is coming back from a break; do not push toward the ${goal}/week goal yet`;
      }
      const ifToday = mid != null ? `; if they start today: ${plainSpaces(midWeekRestartText(mid, upk, 'pending')).replace(/^Starting today\? /, '')}` : '';
      return `- This week's target: restart at ~${plan.restartKm != null ? distKm(plan.restartKm, units) : t} with easy runs${restartLr ? `; ${restartLr}` : ''}${ifToday} — the runner is coming back from a break${back ? ` (the weeks after climb back toward ~${back})` : ''}; do not push toward the ${goal}/week goal yet`;
    }
    case 'rebuild': {
      const atGoal = plan.targetKm != null && plan.targetKm >= d.targetKm - 1e-9;
      return `- This week's target: rebuilding after the race, ~${t}, easy runs${atGoal ? '' : '; add about 10% a week'}`;
    }
    default:
      return null;
  }
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
  const read = gp.weightRead;
  const plan = read?.plan ?? null;
  // A fat-loss payload that carries `current.trendKg` has ONE displayed weight: `current.weightKg` is the weekly average
  // (else the latest scale reading) and the smoothed trend is the chart's alone, so the coach quotes the average.
  const oneWeight = gp.goal === 'weight_loss' && gp.current.trendKg !== undefined;
  if (gp.current.weightKg != null && oneWeight) {
    nowBits.push(read?.weekMeanKg != null ? `weekly average ${wt(read.weekMeanKg, units)} (the one weight to quote; the chart's smoothed trend is not)` : `latest scale reading ${wt(gp.current.weightKg, units)} (the one weight to quote)`);
    if (gp.current.startWeightKg != null && gp.current.changeKg != null) {
      nowBits.push(`${signedWt(gp.current.changeKg, units)} since start at ${wt(gp.current.startWeightKg, units)}`);
    }
    if (read?.scaleKg != null && read.weekMeanKg != null) nowBits.push(`latest scale reading ${wt(read.scaleKg, units)}`);
  } else if (gp.current.weightKg != null) {
    // The trend is smoothed (it lags the scale by about ten days); the scale and weekly average are what the user sees.
    nowBits.push(`trend ${wt(gp.current.weightKg, units)}${read?.scaleKg != null ? ' (smoothed)' : ''}`);
    if (gp.current.startWeightKg != null && gp.current.changeKg != null) {
      // A fat-loss goal measures progress from ONE weight (the weekly average, else the latest scale reading), not the trend.
      const basis = gp.goal === 'weight_loss' && read?.scaleKg != null
        ? ` (${read.weekMeanKg != null ? 'weekly average' : 'latest scale reading'})`
        : '';
      nowBits.push(`${signedWt(gp.current.changeKg, units)} since start at ${wt(gp.current.startWeightKg, units)}${basis}`);
    }
  }
  if (read?.scaleKg != null && !oneWeight) {
    nowBits.push(`scale ${wt(read.scaleKg, units)}${read.weekMeanKg != null ? `, weekly average ${wt(read.weekMeanKg, units)}` : ''}`);
  }
  if (gp.ratePerWeek.kg != null) {
    const pct = gp.ratePerWeek.pctBodyweight != null ? ` (${gp.ratePerWeek.pctBodyweight}% bw)` : '';
    // The pace is a line through the raw weigh-ins of the last 3 weeks (lib/weightPace.ts) for a weight-loss goal.
    const weeks = Math.round((read?.paceWindowDays ?? 21) / 7);
    // "On pace" resting on two paces that straddle the date (wave 22w): the range, so the rate does not argue with the call.
    const earlierKg = plan?.earlierPace != null && plan.earlierPace.kgPerWeek < 0 && gp.ratePerWeek.kg < 0 ? plan.earlierPace.kgPerWeek : null;
    // With the newest weigh-in a week old or more the window ended then (wave 22w): "over the 3 weeks of weigh-ins up to May 10".
    const upTo = gp.goal === 'weight_loss' && (gp.lastWeighInDaysAgo ?? 0) >= 7 ? shortDate(read?.scaleDay) : null;
    const overWeeks = gp.goal === 'weight_loss'
      ? (upTo != null ? ` over the ${weeks} weeks of weigh-ins up to ${upTo}` : ` over the last ${weeks} weeks of weigh-ins`)
      : '';
    if (earlierKg != null && plan?.earlierPaceStraddles === true) {
      // The two paces really land on opposite sides of the target date (wave 22w): the range, so the rate does not argue with the call.
      const slow = signedWt(Math.max(gp.ratePerWeek.kg, earlierKg), units, 2).replace(/ (kg|lb)$/, '');
      nowBits.push(`rate ${slow} to ${signedWt(Math.min(gp.ratePerWeek.kg, earlierKg), units, 2)}/wk${overWeeks} (two weekly reads either side of the target date)`);
    } else {
      // Both paces land on the same side of the date (wave 23w): the pace is the current one, and the earlier one is said as what it was.
      const was = earlierKg != null ? ` (a week ago the pace was ${wt(Math.abs(earlierKg), units, 2)}/wk)` : '';
      nowBits.push(`rate ${signedWt(gp.ratePerWeek.kg, units, 2)}/wk${pct}${overWeeks}${was}`);
    }
  }
  if (gp.distance?.thisWeekKm != null) nowBits.push(plainSpaces(gp.distance.text));
  // An "on pace" ETA IS the target date (the date to hold, not a projection): it is not called an ETA (wave 22w).
  if (gp.eta && !(gp.goal === 'weight_loss' && gp.eta === gp.target.date)) nowBits.push(`ETA ${gp.eta}`);
  if (gp.onPaceForTargetDate != null) nowBits.push(gp.onPaceForTargetDate ? 'on pace for target date' : 'not on pace for target date');
  if (gp.race) {
    const daysSince = gp.race.daysSince ?? 0;
    const when = gp.race.phase === 'recovery' ? `done ${daysSince} day${daysSince === 1 ? '' : 's'} ago`
      : gp.race.daysToGo === 0 ? 'today'
      : gp.race.weeksToGo === 0 ? `in ${gp.race.daysToGo} day${gp.race.daysToGo === 1 ? '' : 's'}`
      : `in ${gp.race.weeksToGo} week${gp.race.weeksToGo === 1 ? '' : 's'}`;
    lines.push(`- Race: ${gp.race.label} on ${gp.race.date} (${when})`);
    const phaseLine = racePhaseLine(gp, units);
    if (phaseLine) lines.push(phaseLine);
  }
  if (gp.longRun) {
    const dist = (km: number) => distKm(km, units);
    // The cap note is said in the first build week and then at most every 4th - never in a taper, race or recovery week.
    const capNote = gp.longRun.capNoteDue === true && gp.longRun.targetPeakKm != null && gp.longRun.raceTargetKm != null && gp.target.weeklyDistanceKm != null
      ? longRunCapNote({ peakKm: gp.longRun.targetPeakKm, raceTargetKm: gp.longRun.raceTargetKm }, gp.target.weeklyDistanceKm, units === 'imperial' ? 1 / KM_PER_MILE : 1)
      : null;
    const target = gp.longRun.targetPeakKm != null
      ? `; peak target ${longRunText(gp.longRun.targetPeakKm, units)} before the taper${capNote ? ` (${plainSpaces(capNote.charAt(0).toLowerCase() + capNote.slice(1))})` : ''}`
      : '';
    const next = gp.longRun.nextKm != null ? `; next long run ~${longRunText(gp.longRun.nextKm, units)}` : '';
    lines.push(`- Long run (running only): longest run in the last 14 days ${dist(gp.longRun.lastKm)}${next}; 28-day peak ${dist(gp.longRun.peakKm)}${target}`);
  }
  // The ONE target for this week, from the same week plan the app's bar and the weekly review's "Next week" use.
  // The weekly goal comes after it, so the coach must not push straight to the goal.
  const weekTarget = weekTargetLine(gp, units);
  if (weekTarget) lines.push(weekTarget);
  if (nowBits.length) lines.push(`- Now: ${nowBits.join('; ')}`);
  // The week's ONE instruction (lib/weightWeekPlan.ts), the same one the goal card and the weekly review state: decided on the
  // Monday from the weigh-ins through Sunday, so it does not change until the next Monday.
  if (plan && gp.verdict !== 'insufficient_data' && gp.verdict !== 'needs_target') {
    const rule = isInstruction(plan.action)
      ? 'give this one instruction; do not suggest a different calorie change before next Monday'
      : 'no calorie change is asked this week';
    // A plan an event re-made inside its week says so (wave 22w); only a plan decided on its Monday is "the same all week".
    const set = plan.updated
      ? `set ${shortDate(plan.weekStart) ?? plan.weekStart}, updated ${WEEKDAY_ABBR[new Date(`${plan.updated.day}T00:00:00Z`).getUTCDay()]} ${shortDate(plan.updated.day) ?? plan.updated.day}: ${plan.updated.why}`
      : `set ${shortDate(plan.weekStart) ?? plan.weekStart}, the same all week`;
    lines.push(`- This week's plan (${set}): ${plainSpaces(plan.action.text)} — ${rule}`);
    if (plan.staleSince) {
      // The week began with no weigh-in for 7+ days (wave 22w): the numbers above are from that last weigh-in.
      lines.push(`- No weigh-in since ${shortDate(plan.staleSince) ?? plan.staleSince}: say so and ask for a weigh-in; do not read a new pace, date or trend into the old readings.`);
    }
  }

  // Returning from a break: the lifts are rebuilding, never a stall or a reason to deload. While ANY main lift is
  // still under its pre-break best (not only the headline lift) it is a rebuild — and "back" is not said of all of them.
  const returns = gp.liftReturns && gp.liftReturns.length > 0 ? gp.liftReturns : gp.liftReturn ? [gp.liftReturn] : [];
  const rebuilding = returns.filter(r => !r.regained);
  if (rebuilding.length > 0) {
    const back = returns.filter(r => r.regained);
    // Where each rebuilding lift stands whenever there is more than one lift to say it of (some back, or several still rebuilding):
    // the percentage as the card prints it, not the payload's rounded-down one - of whole kg whatever the unit, like the card's
    // number-free standing line (a lb and a kg lifter read the same share).
    const behind = rebuilding.length < returns.length || rebuilding.length > 1 ? ` (${rebuilding.map(r => `${r.name.toLowerCase()} ${liftReturnDisplay(r, false).pct}% of its pre-break best`).join(', ')}${back.length > 0 ? `; ${back.map(r => r.name.toLowerCase()).join(', ')} back` : ''})` : '';
    lines.push(`- Returning from a ${returns[0].breakDays}-day break (ended ${returns[0].endedOn}): lifts are rebuilding${behind} — do not call this a stall or suggest a deload${back.length > 0 ? ', and do not say every lift is back' : ''}.`);
  }

  // When the lifter last trained. A day count past the lapse threshold (scaled to the weekly sessions target) means the
  // lift numbers describe a window that ended before the lapse.
  const sinceLast = gp.goal === 'muscle' ? gp.lastSessionDaysAgo : null;
  if (sinceLast != null) {
    const when = sinceLast === 0 ? 'today' : sinceLast === 1 ? 'yesterday' : `${sinceLast} days ago`;
    const on = sinceLast >= 1 ? shortDate(gp.lastSessionOn) : null;
    lines.push(`- Last strength session ${when}${on ? ` (${on})` : ''}${sinceLast >= liftLapseMinDays(gp.target.weeklySessions) ? ' — do not praise lift progress; ask about getting back in' : ''}`);
  }

  lines.push(`- Verdict: ${gp.verdict} — "${plainSpaces(gp.headline)}"`);
  for (const r of gp.reasons.slice(0, MAX_REASONS)) {
    lines.push(`  - ${plainSpaces(r.text)}${r.tone === 'watch' ? ' (watch)' : ''}`);
  }
  if (read?.state === 'early') {
    lines.push('- Early read: the pace is not settled yet — quote the weekly average against the start (say "on the scale" only for a single latest reading), but no weekly rate, no projected date and no "weeks ahead/behind". Daily swings of ±1 kg are normal.');
  }
  if (read?.state === 'returning') {
    lines.push('- The user is back after a gap in weigh-ins: welcome them back and keep weighing in; do not call the pace too fast or behind until 3 weigh-ins are back.');
  }
  // A card built on a stale read (the week began with no weigh-in for 7+ days) states no fresh scale news: the stale-weigh-in rule above is the one
  // rule, and "the scale is moving again" / a plateau's advice belong to a fresh reading (wave 23w).
  const fresh = !plan?.staleSince;
  if (fresh && read?.state === 'plateau' && plan?.flatWeeks === 2) {
    // Two flat weeks after a confirmed loss (wave 22w): a calm hold. The 21-day line still holds the good weeks, so it must not be called behind.
    lines.push('- Two flat weeks on the raw weekly averages after weeks of steady loss: common, not a failure and not "behind" — the plan holds. No projected date, no calorie cut; give the week\'s one action. If the third week is flat too it becomes a plateau.');
  } else if (fresh && read?.state === 'plateau') {
    const cause = plan?.plateauCause ?? null;
    if (cause?.kind === 'weekends' && cause.weekendAvgKcal != null && cause.weekdayAvgKcal != null) {
      // The logs of the plateau's own weeks name the weekends, and the cause is kept for the whole plateau.
      lines.push(`- Plateau on the raw weekly averages (flat for 3 weeks); the logged weeks name the weekends (weekends averaged ~${Math.round(cause.weekendAvgKcal / 50) * 50} vs ${Math.round(cause.weekdayAvgKcal / 50) * 50} kcal on weekdays): lead with the weekends (don't lead with water; the logged weekends are the clearer lever), and keep that cause for as long as the plateau lasts. Only if still flat 2 weeks after that suggest ~150 kcal less a day.`);
    } else if (cause ? cause.kind === 'intake' : read.intake?.low) {
      // The logs say the calories ran over target: that, not water, is what to lead with.
      const avg = Math.round((cause?.avgKcal ?? read.intake?.avgKcal ?? 0) / 10) * 10;
      const target = cause?.targetKcal ?? read.intake?.targetKcal ?? 0;
      lines.push(`- Plateau on the raw weekly averages (flat for 3 weeks) while the logged days ran over target (averaging ~${avg} vs ${target} kcal): lead with the logs — getting back to target is the first lever (don't lead with water; the logged days over target are the clearer lever). Only if still flat 2 weeks after that suggest ~150 kcal less a day.`);
    } else {
      // The second step is the card's own (wave 24w): someone who logs no food is offered the walks and logging, never a kcal cut there is nothing to check against.
      const cut = plan?.action.text == null || /\btrim ~/.test(plan.action.text);
      lines.push(cut
        ? '- Plateau on the raw weekly averages (flat for 3 weeks): often water — not a failure. Keep the plan; only if still flat in 2 weeks suggest ~150 kcal less a day or two 30-minute walks.'
        : '- Plateau on the raw weekly averages (flat for 3 weeks): often water — not a failure. Keep the plan; only if still flat in 2 weeks suggest two 30-minute walks and logging a few days.');
    }
  }
  if (fresh && read?.state === 'moving_again') {
    lines.push('- The scale is moving again after a plateau: no projected date, never "behind", no calorie cut — say to keep doing what restarted it.');
  }
  if (plan?.farBehind) {
    lines.push("- The projection is more than 8 weeks past the target date: do not quote a projected date or \"weeks behind\" — say the date won't hold, and give the week's one action (move the date or the small trim).");
  }
  if (gp.verdict === 'needs_target') {
    lines.push('- No target set yet — setting one is the only thing missing for a real progress verdict.');
  }
  if (gp.verdict === 'reached') {
    if (plan?.state === 'maintenance') {
      // Past the first week: the new-target / maintenance question has been asked; do not keep asking it.
      lines.push('- Target reached and holding — do not ask again about a new target or maintenance, and do not encourage further loss toward the old target.');
    } else {
      lines.push('- Target reached — the next step is a new target or maintenance; do not encourage further loss/gain toward the old target.');
    }
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
    .sort((a, b) => b.sets - a.sets);
  // With a date the lifts follow the card's order: the shared headline lift first
  // (lib/liftChange.ts pickHeadlineLift), then the most-trained lifts by the same
  // ranking, so the coach names the same lift and number the app does.
  if (anchor) {
    const order = rankLifts(progression, anchor);
    const headline = pickHeadlineLift(progression, anchor)?.exercise ?? null;
    const rank = (key: string): number => (key === headline ? -1 : order.indexOf(key) === -1 ? order.length : order.indexOf(key));
    rows.sort((a, b) => rank(a.exercise) - rank(b.exercise));
  }
  return rows.slice(0, 3).map(r => {
    // The ONE lift-change definition (lib/liftChange.ts) — the same
    // "vs 4 weeks ago" number the Trends card, weekly review and goal reasons
    // quote, so the coach never says a different figure for the same lift.
    const change = anchor ? liftChange4w(r.weeks, anchor) : null;
    if (change) {
      const sign = change.changeKg > 0 ? '+' : change.changeKg < 0 ? '-' : '';
      return `- ${r.exercise}: est. 1RM ${sign}${wt(Math.abs(change.changeKg), units)} ${anchor ? liftBaselineLabel(r.weeks, anchor) : 'vs 4 weeks ago'} (${wt(change.baselineKg, units, 0)} -> ${wt(change.recentKg, units, 0)})`;
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
