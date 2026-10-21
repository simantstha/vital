/**
 * Synthetic user histories for the timeline suite. Everything is deterministic (seeded RNG): the same call
 * always returns the same rows. Each builder records what it generated in `inputNotes`.
 *
 * Add a scenario: write a builder returning a `Scenario` (raw rows only, never inputs), add its name to
 * `SCENARIO_NAMES` and a case to `buildScenario`, then list it in the invariants it is relevant to
 * (lib/timeline/timelineInvariants.test.ts).
 */
import {
  TAPER_LATE_FROM_DAYS,
  enduranceWeekPlan,
  peakWeekKmBeforeTaper,
  racePhaseInfo,
  recoveryWeek,
  weekStepOrGoalKm,
} from '../enduranceProgression';
import { addDays, type IntakeRow, type Scenario, type SetRow, type WeighIn, type WorkoutRow } from './types';

const DAY0 = '2026-03-02'; // a Monday

// ── seeded RNG ──────────────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// ── running helpers ─────────────────────────────────────────────────────────

/** Mon = 0 … Sun = 6. */
interface RunSpec { dow: number; km: number; pace?: number }

/**
 * Splits a week's total km over `dows`: the LAST dow takes `longKm` (when > 0), the rest share the remainder
 * evenly in 0.1 km steps so the week sums exactly to `totalKm`.
 */
function splitWeek(totalKm: number, longKm: number, dows: number[]): RunSpec[] {
  const hasLong = longKm > 0 && dows.length > 1;
  const long = hasLong ? Math.min(longKm, round1(totalKm * 0.6)) : 0;
  const others = hasLong ? dows.slice(0, -1) : dows;
  const rest = round1(totalKm - long);
  const base = Math.floor((rest / others.length) * 10) / 10;
  const specs: RunSpec[] = others.map(dow => ({ dow, km: base }));
  const remainder = round1(rest - base * others.length);
  specs[0].km = round1(specs[0].km + remainder);
  if (hasLong) specs.push({ dow: dows[dows.length - 1], km: long, pace: 6.6 });
  return specs;
}

function runRow(day: string, km: number, pace = 6.2): WorkoutRow {
  return { day, type: 'Running', durationMin: Math.max(12, Math.round(km * pace)), distanceM: Math.round(km * 1000) };
}

function addWeekRuns(rows: WorkoutRow[], weekIdx: number, specs: RunSpec[], skip?: (day: string) => boolean): void {
  for (const s of specs) {
    const day = addDays(DAY0, weekIdx * 7 + s.dow);
    if (skip?.(day)) continue;
    rows.push(runRow(day, s.km, s.pace));
  }
}

const TARGET_KM = 30;
const HALF = 21.1;

/** The plan's own build sequence: each week = the app's stepTargetKm computed from the previous week. */
function buildSequence(startKm: number, weeks: number): number[] {
  const seq = [startKm];
  for (let w = 1; w < weeks; w++) seq.push(weekStepOrGoalKm(seq[w - 1], TARGET_KM));
  return seq;
}

// ── 1. runner_on_plan ───────────────────────────────────────────────────────

export function runnerOnPlan(): Scenario {
  const raceDay = addDays(DAY0, 111); // Sunday that ends week 16 ("16 weeks after day 0")
  const workouts: WorkoutRow[] = [];
  const notes: string[] = [];

  // Weeks 1-13: build. Weekly km = the app's own step (weekStepOrGoalKm) from the week before; long run +1 km/week to 18 km on day 90.
  const build = buildSequence(15, 13);
  build.forEach((km, w) => addWeekRuns(workouts, w, splitWeek(km, 6 + w, [1, 3, 5, 6])));
  notes.push(`Weeks 1-13 (build): weekly km ${build.join(', ')} (each = weekStepOrGoalKm(previous week, 30), i.e. exactly the app's stepTargetKm). 4 runs/week Tue/Thu/Sat + Sunday long run: 6 km in week 1, +1 km/week, 18 km on day 90 (Sunday, exactly 21 days before the race).`);

  const peak = peakWeekKmBeforeTaper(
    workouts.map(w => ({ day: w.day, km: (w.distanceM as number) / 1000 })),
    raceDay,
  ) as number;
  const t1 = Math.round(peak * 0.75);
  const t2 = Math.round(peak * 0.6);
  const t3 = Math.round(peak * 0.4);
  addWeekRuns(workouts, 13, splitWeek(t1, 12, [1, 3, 5, 6])); // W14 taper x0.75
  addWeekRuns(workouts, 14, splitWeek(t2, 9, [1, 3, 5, 6]));  // W15 taper x0.6
  addWeekRuns(workouts, 15, splitWeek(t3, 0, [1, 3, 5]));     // W16 race week x0.4 (Tue/Thu/Sat)
  workouts.push({ day: raceDay, type: 'Running', durationMin: 121, distanceM: Math.round(HALF * 1000) }); // the race
  addWeekRuns(workouts, 16, splitWeek(t3, 0, [1, 3, 5]));     // W17 recovery 1 x0.4
  addWeekRuns(workouts, 17, splitWeek(t2, 0, [1, 3, 5])); // W18 recovery 2 x0.6
  for (const w of [18, 19, 20]) addWeekRuns(workouts, w, splitWeek(20, 7, [1, 3, 5, 6])); // W19-21 ~20 km/wk
  notes.push(`Peak week the app will measure before the taper (real peakWeekKmBeforeTaper over the runs generated so far): ${peak} km.`);
  notes.push(`Week 14 taper x0.75 = ${t1} km; week 15 taper x0.6 = ${t2} km; week 16 race week x0.4 = ${t3} km (Tue/Thu/Sat) + the half marathon (21.1 km, 121 min) on Sunday day 111; week 17 recovery x0.4 = ${t3} km; week 18 recovery x0.6 = ${t2} km; weeks 19-21: 20 km/wk (4 runs).`);

  return {
    name: 'runner_on_plan',
    title: 'Runner who follows the plan (half marathon, 16 weeks)',
    goal: 'endurance',
    profile: { sex: 'female', age: 32, heightCm: 168, startWeightKg: 62, units: 'metric' },
    day0: DAY0,
    lastDay: 147, // Monday after week 21 (reviews week 21)
    user: {
      targetWeightKg: null, targetDate: null, weeklySessions: null, weeklyDistanceKm: TARGET_KM,
      raceDate: raceDay, raceDistanceKm: HALF,
      goalStartWeightKg: null, goalStartedDay: DAY0, createdDay: DAY0, sleepGoalMinutes: 480,
    },
    budget: { targetKcal: 2200, proteinG: 100 },
    weighIns: [],
    workouts,
    sets: [],
    intake: [],
    inputNotes: [
      'Goal: endurance. Weekly distance target 30 km. No weekly-sessions target (spec gave none). Race: half marathon (21.1 km) on day 111 (Sunday).',
      'Goal started and account created on day 0; no history before day 0. No weigh-ins, food logs, sleep, resting HR or HRV.',
      ...notes,
    ],
  };
}

// ── 1b. runner_on_plan_half (added in the wave-19 copy): follows the HALF-MARATHON table ──────────────

/** Plan-perfect runner for the half-marathon phases: build to the peak long run 14 days out, ONE taper week (x0.75), race week x0.5, recovery x0.4 / x0.7. */
export function runnerOnPlanHalf(): Scenario {
  const base = runnerOnPlan();
  const raceDay = base.user.raceDate as string;
  const workouts: WorkoutRow[] = [];
  const build = buildSequence(15, 14); // weeks 1-14
  build.forEach((km, w) => addWeekRuns(workouts, w, splitWeek(km, Math.min(6 + w, 18), [1, 3, 5, 6])));
  const peak = peakWeekKmBeforeTaper(workouts.map(w => ({ day: w.day, km: (w.distanceM as number) / 1000 })), raceDay, HALF) as number;
  const t1 = Math.round(peak * 0.75);
  const t3 = Math.round(peak * 0.5);
  const r1 = Math.round(peak * 0.4);
  const r2 = Math.round(peak * 0.7);
  addWeekRuns(workouts, 14, splitWeek(t1, 12, [1, 3, 5, 6]));   // W15 taper x0.75
  addWeekRuns(workouts, 15, splitWeek(t3, 0, [1, 3, 5]));       // W16 race week x0.5
  workouts.push({ day: raceDay, type: 'Running', durationMin: 121, distanceM: Math.round(HALF * 1000) });
  addWeekRuns(workouts, 16, splitWeek(r1, 0, [1, 3, 5]));       // W17 recovery 1 x0.4
  addWeekRuns(workouts, 17, splitWeek(r2, 0, [1, 3, 5]));       // W18 recovery 2 x0.7
  for (const w of [18, 19, 20]) addWeekRuns(workouts, w, splitWeek(Math.round(r2 * 1.1 ** (w - 17)), 7, [1, 3, 5, 6]));
  return {
    ...base,
    name: 'runner_on_plan_half',
    title: 'Runner who follows the HALF-MARATHON table (14-week build, one taper week, race week x0.5, recovery x0.4 / x0.7)',
    workouts,
    inputNotes: [
      'Same goal/race as runner_on_plan, but the runner follows the wave-19 half-marathon table: peak long run 14 days out (Sunday day 97), taper x0.75 in the week of day 98, race week x0.5, recovery x0.4 (days 1-7) and x0.7 (days 8-14), then +10% a week.',
      `Peak week measured before the taper: ${peak} km; taper ${t1} km, race week ${t3} km + the race, recovery ${r1} / ${r2} km.`,
    ],
  };
}

// ── 2. runner_messy ─────────────────────────────────────────────────────────

export function runnerMessy(): Scenario {
  const raceDay = addDays(DAY0, 111);
  const workouts: WorkoutRow[] = [];
  const notes: string[] = [];

  const plan = buildSequence(15, 13); // the plan the runner is (loosely) following
  const m: number[] = [15, 17, 19, 21, 23]; // weeks 1-5 on plan
  const step5 = weekStepOrGoalKm(m[4], TARGET_KM);
  m[5] = round1(step5 * 1.6); // week 6: spike, 1.6x the step
  m[6] = plan[6]; m[7] = plan[7]; // weeks 7-8 back on plan
  m.forEach((km, w) => {
    if (w === 5) addWeekRuns(workouts, w, splitWeek(km, 12, [1, 3, 5, 6]));
    else addWeekRuns(workouts, w, splitWeek(km, 6 + w, [1, 3, 5, 6]));
  });
  notes.push(`Weeks 1-5 on plan (15, 17, 19, 21, 23 km). Week 6 SPIKE: ${m[5]} km = 1.6 x the app's step of ${step5} km (long run 12 km). Weeks 7-8 back on plan (${m[6]}, ${m[7]} km).`);

  // Week 9: sick from Wednesday (day 58) for 8 days -> first run Thursday of week 10 (day 66).
  workouts.push(runRow(addDays(DAY0, 57), 6.0)); // Tue W9, the only run
  notes.push('Week 9: one 6 km run on Tuesday (day 57), then SICK: zero runs on days 58-65 (8 days, Wed W9 to Wed W10).');
  workouts.push(runRow(addDays(DAY0, 66), 4.0), runRow(addDays(DAY0, 68), 4.0), runRow(addDays(DAY0, 69), 7.0, 6.8)); // W10 Thu/Sat/Sun = 15 km
  notes.push('Week 10: back on Thursday day 66: Thu 4, Sat 4, Sun 7 = 15 km.');
  addWeekRuns(workouts, 10, splitWeek(20, 8, [1, 3, 5, 6])); // W11
  addWeekRuns(workouts, 11, splitWeek(24, 10, [1, 3, 5, 6])); // W12
  addWeekRuns(workouts, 12, splitWeek(28, 14, [1, 3, 5, 6])); // W13 (long run on day 90 = 14 km)
  notes.push('Weeks 11-13: 20, 24, 28 km (long runs 8, 10, 14 km).');
  // IGNORES THE TAPER: peak volume through taper and race week.
  addWeekRuns(workouts, 13, splitWeek(28, 14, [1, 3, 5, 6])); // W14
  addWeekRuns(workouts, 14, splitWeek(28, 14, [1, 3, 5, 6])); // W15
  addWeekRuns(workouts, 15, splitWeek(28, 0, [1, 3, 5]));     // W16 race week: Tue/Thu/Sat 28 km
  workouts.push({ day: raceDay, type: 'Running', durationMin: 135, distanceM: Math.round(HALF * 1000) });
  notes.push('Weeks 14-16 IGNORE THE TAPER: 28 km, 28 km, then 28 km in race week (Tue/Thu/Sat), then the half marathon (21.1 km, 135 min) on Sunday day 111.');
  // After the race: nothing for 10 days (days 112-121), then a gentle return.
  addWeekRuns(workouts, 17, [{ dow: 3, km: 4.0 }, { dow: 5, km: 4.0 }, { dow: 6, km: 5.0 }]); // Thu day 122 onwards
  addWeekRuns(workouts, 18, [{ dow: 1, km: 5.0 }, { dow: 3, km: 5.0 }, { dow: 5, km: 5.0 }]);
  addWeekRuns(workouts, 19, [{ dow: 1, km: 5.0 }, { dow: 3, km: 5.0 }, { dow: 5, km: 5.0 }]);
  notes.push('After the race: NO runs for 10 days (days 112-121). Return on Thursday day 122: week 18 = Thu 4, Sat 4, Sun 5 = 13 km; weeks 19-20 = 3 x 5 km.');

  return {
    name: 'runner_messy',
    title: 'Runner who spikes, gets sick, ignores the taper, races, then stops',
    goal: 'endurance',
    profile: { sex: 'male', age: 36, heightCm: 181, startWeightKg: 78, units: 'metric' },
    day0: DAY0,
    lastDay: 140,
    user: {
      targetWeightKg: null, targetDate: null, weeklySessions: null, weeklyDistanceKm: TARGET_KM,
      raceDate: raceDay, raceDistanceKm: HALF,
      goalStartWeightKg: null, goalStartedDay: DAY0, createdDay: DAY0, sleepGoalMinutes: 480,
    },
    budget: { targetKcal: 2600, proteinG: 120 },
    weighIns: [], workouts, sets: [], intake: [],
    inputNotes: [
      'Same goal/race as runner_on_plan (30 km/wk target, half marathon on day 111). No sessions target; no weigh-ins/food/sleep/HR.',
      ...notes,
    ],
  };
}

// ── 3. runner_no_race ───────────────────────────────────────────────────────

export function runnerNoRace(): Scenario {
  const workouts: WorkoutRow[] = [];
  const notes: string[] = [];
  const seq = buildSequence(15, 6); // weeks 1-6 on plan
  seq.forEach((km, w) => addWeekRuns(workouts, w, splitWeek(km, 6 + w, [1, 3, 5, 6])));
  notes.push(`Weeks 1-6 on plan: ${seq.join(', ')} km (4 runs/week, Sunday long run 6 -> 11 km).`);
  notes.push('Weeks 7-8: NO runs at all (2-week gap).');
  // restart: 3 easy runs, then follow the app's step
  const w9 = 12;
  const w10 = weekStepOrGoalKm(w9, TARGET_KM);
  const w11 = weekStepOrGoalKm(w10, TARGET_KM);
  const w12 = weekStepOrGoalKm(w11, TARGET_KM);
  addWeekRuns(workouts, 8, splitWeek(w9, 5, [1, 3, 6]));
  addWeekRuns(workouts, 9, splitWeek(w10, 5.5, [1, 3, 5, 6]));
  addWeekRuns(workouts, 10, splitWeek(w11, 6, [1, 3, 5, 6]));
  addWeekRuns(workouts, 11, splitWeek(w12, 7, [1, 3, 5, 6]));
  notes.push(`Week 9 restart: ${w9} km in 3 easy runs (Tue/Thu/Sun). Weeks 10-12: ${w10}, ${w11}, ${w12} km (each = weekStepOrGoalKm of the week before).`);

  return {
    name: 'runner_no_race',
    title: 'Runner with a weekly distance goal and no race date; 2-week gap in weeks 7-8',
    goal: 'endurance',
    profile: { sex: 'female', age: 44, heightCm: 165, startWeightKg: 66, units: 'metric' },
    day0: DAY0,
    lastDay: 84,
    user: {
      targetWeightKg: null, targetDate: null, weeklySessions: null, weeklyDistanceKm: TARGET_KM,
      raceDate: null, raceDistanceKm: null,
      goalStartWeightKg: null, goalStartedDay: DAY0, createdDay: DAY0, sleepGoalMinutes: 480,
    },
    budget: { targetKcal: 2000, proteinG: 100 },
    weighIns: [], workouts, sets: [], intake: [],
    inputNotes: [
      'Goal: endurance. Weekly distance target 30 km. NO race date, no race distance, no weekly-sessions target.',
      ...notes,
    ],
  };
}

// ── 4. weight_loss (+ logged variant) ───────────────────────────────────────

/** True (noise-free) weight on day d. */
function trueWeightKg(d: number): number {
  if (d < 35) return 92 - (0.5 / 7) * d;                    // weeks 1-5: -0.5 kg/wk
  if (d < 56) return 92 - 2.5;                              // weeks 6-8: plateau at 89.5
  if (d < 100) return 89.5 - ((89.5 - 84) * (d - 56)) / 44; // weeks 9-15: ~0.88 kg/wk down to 84.0 on day 100
  return 83.9 + 0.15 * Math.sin((d - 100) / 3);             // weeks 15-18: hovering about 83.9
}

function weightHistory(seed: number): { weighIns: WeighIn[]; notes: string[]; trueByDay: Map<string, number> } {
  const r = rng(seed);
  const weighIns: WeighIn[] = [];
  const trueByDay = new Map<string, number>();
  const GAP_FROM = 70, GAP_TO = 81; // 12 days
  for (let w = 0; w < 19; w++) {
    const perWeek = 4 + Math.floor(r() * 3); // 4..6
    const days = [0, 1, 2, 3, 4, 5, 6].sort(() => r() - 0.5).slice(0, perWeek).sort();
    if (w === 0 && !days.includes(0)) days.push(0); // the goal is set on day 0 with a weigh-in
    for (const dow of days) {
      const d = w * 7 + dow;
      if (d > 126) continue;
      if (d >= GAP_FROM && d <= GAP_TO) continue;
      const t = trueWeightKg(d);
      const noise = clamp(gauss(r) * 0.2, -0.4, 0.4);
      let kg = t + noise;
      if (d >= 100) kg = clamp(kg, 83.6, 84.6);
      if (d === 0) kg = 92.0;
      weighIns.push({ day: addDays(DAY0, d), kg: round1(kg) });
      trueByDay.set(addDays(DAY0, d), t);
    }
  }
  return {
    weighIns,
    trueByDay,
    notes: [
      'Underlying (noise-free) weight: day 0-34 (weeks 1-5) -0.5 kg/wk from 92.0 -> 89.5; days 35-55 (weeks 6-8) plateau at 89.5; days 56-99 (weeks 9-15) ~0.88 kg/wk down to 84.0 on day 100 (week 15) [a faster catch-up pace than the early 0.5 kg/wk was required to hit 84 in week 15]; days 100-126 hover around 83.9 (+/-0.15 slow wiggle) so that scale readings sit on both sides of the 84 kg target.',
      'Each weigh-in = underlying weight + noise (normal, sd 0.2, clipped to +/-0.4 kg), rounded to 0.1 kg (production stores round1). 4-6 weigh-ins per week at random weekdays. Day 0 is exactly 92.0. From day 100 weigh-ins are clamped to 83.6-84.6.',
      `No weigh-ins at all for 12 days: days ${GAP_FROM}-${GAP_TO} (all of week 11, through Friday of week 12).`,
    ],
  };
}

export function weightLoss(): Scenario {
  const { weighIns, notes } = weightHistory(20260302);
  return {
    name: 'weight_loss',
    title: 'Weight loss 92 kg -> 84 kg (weigh-ins only)',
    goal: 'weight_loss',
    profile: { sex: 'male', age: 35, heightCm: 180, startWeightKg: 92, units: 'metric' },
    day0: DAY0,
    lastDay: 126,
    user: {
      targetWeightKg: 84, targetDate: addDays(DAY0, 126), weeklySessions: null, weeklyDistanceKm: null,
      raceDate: null, raceDistanceKm: null,
      goalStartWeightKg: 92, goalStartedDay: DAY0, createdDay: DAY0, sleepGoalMinutes: 480,
    },
    budget: { targetKcal: 2000, proteinG: 140 },
    weighIns, workouts: [], sets: [], intake: [],
    inputNotes: [
      'Goal: weight_loss. Target 84 kg by day 126 (18 weeks out, a Monday). goal_start_weight_kg = 92.0 (trend weight when the goal was set on day 0). No weekly-sessions target.',
      'As specified, ONLY weigh-ins are logged: no food, no workouts. (See weight_loss_logged for the same weights plus food logs and workouts.)',
      ...notes,
    ],
  };
}

export function weightLossLogged(): Scenario {
  const base = weightLoss();
  const r = rng(777);
  const intake: IntakeRow[] = [];
  const workouts: WorkoutRow[] = [];
  for (let d = 0; d <= 126; d++) {
    const date = addDays(DAY0, d);
    const dow = d % 7; // Mon = 0
    const inGap = d >= 70 && d <= 81;
    // food logging: ~6 of 7 days, stops during the weigh-in gap
    if (!inGap && r() < 0.86) {
      const plateau = d >= 35 && d < 56;
      const weekend = dow >= 5;
      const kcal = Math.round(1900 + (plateau ? 120 : 0) + (weekend ? 330 : 0) + gauss(r) * 150);
      intake.push({ day: date, kcal, proteinG: Math.round(clamp(138 + gauss(r) * 18, 90, 190)) });
    }
    // three workouts a week (Mon/Wed/Sat) except the gap
    if (!inGap && (dow === 0 || dow === 2 || dow === 5)) {
      workouts.push({ day: date, type: 'Strength Training', durationMin: 45, distanceM: null });
    }
  }
  return {
    ...base,
    name: 'weight_loss_logged',
    title: 'Weight loss 92 kg -> 84 kg (same weigh-ins + food logs + workouts) [EXTRA scenario, not in the brief]',
    user: { ...base.user, weeklySessions: 3 },
    intake,
    workouts,
    inputNotes: [
      'EXTRA scenario added by the harness author: identical weigh-ins to weight_loss, plus a weekly-sessions target of 3, food logging on ~6 of 7 days (kcal ~ 1900 +/-150, +330 on Sat/Sun, +120 during the plateau; protein ~138 g; target 2000 kcal so weekdays are mostly in budget and weekends mostly over), three 45-min "Strength Training" workouts (Mon/Wed/Sat). Food logging and workouts stop during the 12-day weigh-in gap.',
      'Budget approximation: targetKcal 2000 / protein 140 g (a custom budget); formula/learned TDEE absent.',
      ...base.inputNotes.slice(1),
    ],
  };
}

// ── 5. lifter ───────────────────────────────────────────────────────────────

export function lifter(): Scenario {
  const r = rng(4242);
  const sets: SetRow[] = [];
  const weighIns: WeighIn[] = [];
  const notes: string[] = [];

  const lifts: Record<string, { display: string; start: number; incWeeks: number[] }> = {
    squat: { display: 'Squat', start: 100, incWeeks: [2, 3, 4, 6, 7, 8, 12, 13, 14] },
    'bench press': { display: 'Bench Press', start: 80, incWeeks: [2, 4, 6, 8, 12, 14] },
    deadlift: { display: 'Deadlift', start: 120, incWeeks: [2, 3, 5, 7, 8, 12, 13] },
  };
  const cur: Record<string, number> = Object.fromEntries(Object.entries(lifts).map(([k, v]) => [k, v.start]));
  const roundPlate = (kg: number): number => Math.round(kg / 2.5) * 2.5;

  const pushSets = (day: string, ex: string, n: number, reps: number, load: number, rpe: number, warm = true): void => {
    if (warm) {
      sets.push({ day, exercise: ex, display: lifts[ex].display, reps: 5, loadKg: roundPlate(load * 0.5), rpe: null, isWarmup: true });
      sets.push({ day, exercise: ex, display: lifts[ex].display, reps: 3, loadKg: roundPlate(load * 0.75), rpe: null, isWarmup: true });
    }
    for (let i = 0; i < n; i++) sets.push({ day, exercise: ex, display: lifts[ex].display, reps, loadKg: load, rpe, isWarmup: false });
  };

  for (let w = 1; w <= 14; w++) {
    const missed = w === 9 || w === 10;
    for (const ex of Object.keys(lifts)) {
      if (lifts[ex].incWeeks.includes(w) && w !== 5) cur[ex] += 2.5;
      if (w === 11) cur[ex] = roundPlate(cur[ex] * 0.95); // resume slightly lighter (applied once, at the start of week 11)
    }
    const deload = w === 5;
    const f = deload ? 0.85 : 1;
    const nSets = deload ? 2 : 3;
    const base = (w - 1) * 7;
    const L = (ex: string): number => roundPlate(cur[ex] * f);
    if (!missed) {
      // Mon: squat + bench; Tue: deadlift; Thu: bench (volume) ; Sat: squat light + deadlift light
      pushSets(addDays(DAY0, base + 0), 'squat', nSets, 5, L('squat'), 8);
      pushSets(addDays(DAY0, base + 0), 'bench press', nSets, 5, L('bench press'), 8);
      pushSets(addDays(DAY0, base + 1), 'deadlift', deload ? 1 : 2, 5, L('deadlift'), 8);
      pushSets(addDays(DAY0, base + 3), 'bench press', nSets, 8, roundPlate(L('bench press') * 0.85), 8);
      pushSets(addDays(DAY0, base + 5), 'squat', 2, 5, roundPlate(L('squat') * 0.9), 7, false);
      pushSets(addDays(DAY0, base + 5), 'deadlift', 2, 5, roundPlate(L('deadlift') * 0.9), 7, false);
    }
    // weigh-ins 3x a week (Mon/Thu/Sat), slow gain 80.0 +0.2 kg/wk
    for (const dow of [0, 3, 5]) {
      const kg = 80 + 0.2 * (w - 1 + dow / 7) + clamp(gauss(r) * 0.2, -0.4, 0.4);
      weighIns.push({ day: addDays(DAY0, base + dow), kg: round1(kg) });
    }
  }
  notes.push('Lifts (working load for 3-5 reps at RPE 8 on the top sets): squat 100, bench press 80, deadlift 120 kg at week 1; +2.5 kg on weeks squat [2,3,4,6,7,8,12,13,14], bench [2,4,6,8,12,14], deadlift [2,3,5,7,8,12,13] (each lift moves every 1-2 weeks).');
  notes.push('Sessions (4/week): Mon squat 3x5 + bench 3x5; Tue deadlift 2x5; Thu bench 3x8 @85%; Sat light squat 2x5 + light deadlift 2x5 @90%. Mon/Tue/Thu warm-up sets are logged as is_warmup (excluded by the real code).');
  notes.push('Week 5 = DELOAD: loads x0.85 and 2 working sets per lift (1 deadlift set). Weeks 9 and 10 = NO sessions at all. Week 11 resumes at 95% of the last working weights, then increments continue on weeks 12-14.');
  notes.push('Weigh-ins: Mon/Thu/Sat, 80.0 kg + 0.2 kg/week + noise (+/-0.4 clipped), also during the missed weeks. No target weight.');

  return {
    name: 'lifter',
    title: 'Lifter (muscle goal, 4 sessions/week): deload week 5, missed weeks 9-10',
    goal: 'muscle',
    profile: { sex: 'male', age: 28, heightCm: 178, startWeightKg: 80, units: 'metric' },
    day0: DAY0,
    lastDay: 98,
    user: {
      targetWeightKg: null, targetDate: null, weeklySessions: 4, weeklyDistanceKm: null,
      raceDate: null, raceDistanceKm: null,
      goalStartWeightKg: 80, goalStartedDay: DAY0, createdDay: DAY0, sleepGoalMinutes: 480,
    },
    budget: { targetKcal: 2900, proteinG: 160 },
    weighIns, workouts: [], sets, intake: [],
    inputNotes: [
      'Goal: muscle. Weekly sessions target 4. No target weight, no food logs, no HealthKit workouts (strength sessions come from logged sets only). goal_start_weight_kg = 80.0.',
      ...notes,
    ],
  };
}

// ── 5b. lifter variants (wave 21 integration) ───────────────────────────────

/**
 * The lifter in pounds: identical rows (loads are stored in kg), only the display units differ. Locks the 5 lb next-load
 * step and the lb copy of the lift lines, which the metric lifter cannot reach.
 */
export function lifterImperial(): Scenario {
  const base = lifter();
  return {
    ...base,
    name: 'lifter_imperial',
    title: 'Lifter (muscle goal), IMPERIAL display units',
    profile: { ...base.profile, units: 'imperial' },
    inputNotes: [
      'IDENTICAL rows and targets to lifter; only unitSystem differs (imperial: display lb). Loads are stored in kg and shown in lb; the next-load step is 5 lb.',
      ...base.inputNotes.slice(1),
    ],
  };
}

/** The week (1-based) in which the lifter below only gets to the gym once. */
const SHORT_WEEK = 7;

/**
 * The lifter with ONE bad week: in week 7 (days 42-48) only the Thursday session happens. From Saturday the week can no
 * longer reach its 4 sessions while the last session is under the 4-day lapse threshold, which is the one state where
 * "Progressing" has to be held back by the week alone (the lapse covers Mon-Wed, which run 4+ days after last Saturday).
 */
export function lifterShortWeek(): Scenario {
  const base = lifter();
  const from = (SHORT_WEEK - 1) * 7;
  const thursday = addDays(DAY0, from + 3);
  const inWeek = (day: string): boolean => day >= addDays(DAY0, from) && day <= addDays(DAY0, from + 6);
  return {
    ...base,
    name: 'lifter_short_week',
    title: `Lifter (muscle goal) with one short week: only Thursday trained in week ${SHORT_WEEK}`,
    sets: base.sets.filter(set => !inWeek(set.day) || set.day === thursday),
    inputNotes: [
      `Same history as lifter except week ${SHORT_WEEK} (days ${from}-${from + 6}): only the Thursday bench session happens (the Monday, Tuesday and Saturday sessions are dropped).`,
      ...base.inputNotes.slice(1),
    ],
  };
}

// ── imperial variant of runner_on_plan, only around phase transitions ──────

export function runnerOnPlanImperial(phaseKey: (date: string) => string): Scenario {
  const base = runnerOnPlan();
  const dates = Array.from({ length: base.lastDay + 1 }, (_, i) => addDays(base.day0, i));
  const keys = dates.map(phaseKey);
  const keep = new Set<number>();
  keys.forEach((k, i) => {
    if (i > 0 && k !== keys[i - 1]) for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < dates.length) keep.add(j);
  });
  return {
    ...base,
    name: 'runner_on_plan_imperial',
    title: 'Runner who follows the plan, IMPERIAL display units (days around phase transitions only)',
    profile: { ...base.profile, units: 'imperial' },
    dayFilter: idx => keep.has(idx),
    inputNotes: [
      'IDENTICAL history and targets (30 km/wk goal, half marathon) to runner_on_plan; only unitSystem differs (imperial: display mi / lb). Targets are stored in km, so the goal reads 18.6 mi.',
      'Only days within +/-2 days of a race-phase change are written (build/taper-early/taper-late/race-week/recovery-1/recovery-2/none), plus the weekly review on each Monday that falls in those windows.',
      ...base.inputNotes.slice(1),
    ],
  };
}


// ── wave 22e: an obedient runner and a comeback spike (endurance) ──────────────────────────────────────

/** One scripted week of an otherwise obedient runner: `runs` are the week's [dow, km] pairs (Mon = 0). */
type ScriptedWeek = Array<[number, number]>;

/**
 * Builds the rows of a runner who DOES what the app says: each Monday it reads the real week plan (target, long run) from
 * the runs so far and runs exactly that - the cutback week's lowered km and held long run, the taper, race week and the
 * recovery ceilings included. `scripted` replaces chosen weeks (week index from 0) with fixed runs (an illness, an overshoot);
 * the weeks after them are obedient again. Deterministic: the plan is a pure function of the runs so far.
 */
function obedientRuns(opts: {
  weeks: number;
  baselineKm: number;
  race: { date: string; distanceKm: number } | null;
  scripted?: Record<number, ScriptedWeek>;
}): { workouts: WorkoutRow[]; kinds: string[] } {
  const workouts: WorkoutRow[] = [];
  const kinds: string[] = [];
  const toPlanRuns = (): Array<{ day: string; km: number }> =>
    workouts.filter(w => w.type === 'Running' && w.distanceM != null).map(w => ({ day: w.day, km: (w.distanceM as number) / 1000 }));
  for (let w = 0; w < opts.weeks; w++) {
    const monday = addDays(DAY0, w * 7);
    const scripted = opts.scripted?.[w];
    const runs = toPlanRuns();
    const plan = enduranceWeekPlan({
      runs,
      weekStart: monday,
      goalKm: TARGET_KM,
      race: opts.race,
      today: monday,
      racePeakWeekKm: opts.race ? peakWeekKmBeforeTaper(runs, opts.race.date, opts.race.distanceKm) : null,
      unitsPerKm: 1,
      goalStartDay: DAY0,
    });
    kinds.push(`${plan.kind}${plan.cutback ? '/cutback' : ''}${scripted ? '/scripted' : ''}`);
    if (scripted) {
      for (const [dow, km] of scripted) workouts.push(runRow(addDays(monday, dow), km, dow === 6 ? 6.8 : 6.2));
      continue;
    }
    const isRaceOrRecovery = plan.kind === 'race_week' || plan.kind === 'recovery';
    const total = plan.targetKm ?? opts.baselineKm;
    const long = isRaceOrRecovery ? 0 : plan.longRunKm ?? (plan.kind === 'baseline' ? 6 : 0);
    addWeekRuns(workouts, w, splitWeek(total, long, isRaceOrRecovery ? [1, 3, 5] : [1, 3, 5, 6]));
    if (opts.race && addDays(monday, 6) === opts.race.date) {
      workouts.push({ day: opts.race.date, type: 'Running', durationMin: 121, distanceM: Math.round(opts.race.distanceKm * 1000) });
    }
  }
  return { workouts, kinds };
}

/**
 * S1: the same half-marathon goal as runner_on_plan, but the runner follows the APP: the cutback weeks run their lowered km with
 * the long run held, long runs stay at the plan's number, the taper is the planned one. (runner_on_plan builds with the plain
 * 10% step and so skips every cutback; this one walks the "Cutback week done" path.)
 */
export function runnerOnPlanObedient(): Scenario {
  const base = runnerOnPlan();
  const race = { date: base.user.raceDate as string, distanceKm: HALF };
  const { workouts, kinds } = obedientRuns({ weeks: 21, baselineKm: 15, race });
  return {
    ...base,
    name: 'runner_on_plan_obedient',
    title: 'Runner who does exactly what the app says (half marathon, cutback weeks run, taper as planned)',
    workouts,
    inputNotes: [
      'Same goal/race as runner_on_plan (30 km/wk, half marathon day 111). Every Monday the runner reads the real week plan and runs its target km and long run on Tue/Thu/Sat/Sun (race week and recovery: Tue/Thu/Sat).',
      `Week kinds the plan gave, week 1 first: ${kinds.join(', ')}.`,
    ],
  };
}

/**
 * S2: a runner with no race who comes back from an illness and overshoots. Obedient to the plan, then: week 9 one 6 km run and
 * ill (8 days without a run), week 10 back with 15 km, week 11 (the first comeback week, "up to ~18 km") 29 km - a big overshoot
 * that is still below the pre-break median of 30 km. Obedient again afterwards.
 */
export function runnerComebackSpike(): Scenario {
  const noRace = runnerNoRace();
  const SICK_WEEK = 8;
  const { workouts, kinds } = obedientRuns({
    weeks: 14,
    baselineKm: 24,
    race: null,
    scripted: {
      [SICK_WEEK]: [[1, 6.0]],
      [SICK_WEEK + 1]: [[3, 4.0], [5, 4.0], [6, 7.0]],
      [SICK_WEEK + 2]: [[1, 7.0], [3, 5.0], [5, 5.0], [6, 12.0]],
    },
  });
  return {
    ...noRace,
    name: 'runner_comeback_spike',
    title: 'Runner who comes back from an illness and overshoots the first comeback week (15 km, then 29 km; no race)',
    lastDay: 14 * 7,
    workouts,
    inputNotes: [
      'Goal: endurance, weekly distance target 30 km, no race. Starts at 24 km and does what the app says (cutback week included) up to week 8 (30 km weeks).',
      'Week 9: one 6 km run on Tuesday, then ILL: no run for 8 days. Week 10: back on Thursday, Thu 4 + Sat 4 + Sun 7 = 15 km. Week 11 (the first comeback week): 29 km (7/5/5/12), well over the ceiling the app gave and still under the pre-break median of 30 km. Weeks 12-14: obedient again.',
      `Week kinds the plan gave, week 1 first: ${kinds.join(', ')}.`,
    ],
  };
}

// ── registry ────────────────────────────────────────────────────────────────

export const SCENARIO_NAMES = [
  'lifter',
  'lifter_imperial',
  'lifter_short_week',
  'weight_loss',
  'weight_loss_logged',
  'runner_on_plan',
  'runner_on_plan_half',
  'runner_on_plan_imperial',
  'runner_messy',
  'runner_no_race',
  'runner_on_plan_obedient',
  'runner_comeback_spike',
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** The phase label the imperial variant uses to pick the days around each race-phase change. */
function phaseKey(raceDate: string, raceDistanceKm: number | null, date: string): string {
  const info = racePhaseInfo(raceDate, date, raceDistanceKm);
  if (!info) return 'none';
  if (info.daysToRace === 0) return 'race_day';
  if (info.phase === 'taper') return info.daysToRace > TAPER_LATE_FROM_DAYS ? 'taper-early' : 'taper-late';
  if (info.phase === 'recovery') return `recovery-${recoveryWeek(-info.daysToRace)}`;
  return info.phase;
}

/** Builds a fresh copy of the named scenario (builders are pure, so this is cheap and deterministic). */
export function buildScenario(name: ScenarioName): Scenario {
  switch (name) {
    case 'lifter': return lifter();
    case 'lifter_imperial': return lifterImperial();
    case 'lifter_short_week': return lifterShortWeek();
    case 'weight_loss': return weightLoss();
    case 'weight_loss_logged': return weightLossLogged();
    case 'runner_on_plan': return runnerOnPlan();
    case 'runner_on_plan_half': return runnerOnPlanHalf();
    case 'runner_on_plan_imperial': {
      const onPlan = runnerOnPlan();
      return runnerOnPlanImperial(date => phaseKey(onPlan.user.raceDate as string, onPlan.user.raceDistanceKm, date));
    }
    case 'runner_messy': return runnerMessy();
    case 'runner_no_race': return runnerNoRace();
    case 'runner_on_plan_obedient': return runnerOnPlanObedient();
    case 'runner_comeback_spike': return runnerComebackSpike();
  }
}
