/**
 * Wave 23e / G1: a runner who follows the app DAY BY DAY, not just on Mondays.
 *
 * Every run day the runner opens the app BEFORE the run (the card as of that morning: the real `stepDay` over the rows so far),
 * reads the week plan and every daily cap it carries ("keep Sunday's run ≤ N", "keep tomorrow's run ≤ 3 km", the race-week shape,
 * the race-eve shakeout, "skip the long run"), and runs what that implies:
 *  - the plan's remaining km (target - done) spread over the run days still ahead, the long run on its day (Sunday), the race-eve
 *    shakeout reserved on the eve;
 *  - every cap taken as a ceiling on what the rest of the week may add (the tightest wins);
 *  - on the race day the race, on the days of an illness nothing.
 *
 * Deterministic: the runs are a pure function of the app's own output on the rows so far. The rows are cached per process.
 * (Circular import with engine.ts by design: nothing here runs at module load, only inside functions.)
 */
import { computeProgressFor, stepDay } from './engine';
import { extractInstructions, tightestCapKm } from './instructions';
import { addDays, type Scenario, type WorkoutRow } from './types';

export interface ObedientOpts {
  /** The frame (goal, user, race, profile); its own workouts are ignored. */
  base: Scenario;
  /** The runner's last stepped day (inclusive). */
  lastDay: number;
  /** Runs fixed by the script instead of by the card (the baseline week: nothing to read yet), by day index. */
  scripted?: Record<number, number>;
  /** Days the runner is ill: no run, whatever the card says. */
  illDays?: ReadonlySet<number>;
}

const BUILD_RUN_DOWS = [1, 3, 5, 6]; // Tue, Thu, Sat, Sun (Mon = 0)
const EASY_RUN_DOWS = [1, 3, 5]; // race week and recovery weeks: Tue, Thu, Sat
/** "rest or a 15-min shakeout": the runner takes the shakeout, ~15 minutes at an easy pace. */
const SHAKEOUT_KM = 2.5;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function runRowFor(day: string, km: number, pace = 6.2): WorkoutRow {
  return { day, type: 'Running', durationMin: Math.max(12, Math.round(km * pace)), distanceM: Math.round(km * 1000) };
}

/** What one run day asks for, read from that morning's snapshot (the rows up to the day before). */
function kmForDay(scn: Scenario, idx: number, dow: number): { km: number; why: string } {
  const snap = stepDay(scn, idx);
  const card = snap.card;
  const dist = card?.distance;
  const plan = dist?.plan;
  const race = card?.race ?? null;
  if (card == null || dist == null || plan == null) return { km: 0, why: 'no plan' };
  // The race itself, and the shakeout the day before it.
  if (race != null && race.phase !== 'recovery' && race.daysToGo === 0) return { km: race.distanceKm ?? 0, why: 'race day' };
  if (race != null && race.phase !== 'recovery' && race.daysToGo === 1) return { km: SHAKEOUT_KM, why: 'race-eve shakeout' };
  const done = dist.thisWeekKm ?? 0;
  const longRunKm = plan.longRunKm;
  // The runner's long run is on Sunday: it is still ahead on every earlier run day of a week that plans one.
  const longRunAhead = longRunKm != null && dow < 6;
  const longestSoFarKm = Math.max(0, ...scn.workouts.filter(w => w.day >= addDays(snap.date, -dow) && w.day < snap.date && w.type === 'Running').map(w => (w.distanceM ?? 0) / 1000));
  const instructions = extractInstructions(snap, { longestSoFarKm });
  // The week's number: the restart number on a break, else the plan's target (a comeback's "up to" ceiling is run exactly).
  const target = plan.restartKm != null && plan.kind === 'restart' ? plan.restartKm : plan.targetKm;
  if (target == null) return { km: 0, why: 'baseline (scripted)' };
  const cap = tightestCapKm(instructions);
  const budget = Math.max(0, Math.min(target - done, cap));
  const runDows = plan.kind === 'recovery' || plan.kind === 'race_week' ? EASY_RUN_DOWS : BUILD_RUN_DOWS;
  if (!runDows.includes(dow)) return { km: 0, why: 'not a run day this week' };
  const ahead = runDows.filter(d => d > dow);
  const longDay = runDows.includes(6) && longRunKm != null ? 6 : null;
  // Km kept for the days after today: the long run on Sunday, the shakeout on the eve of the race.
  const raceEveDow = race != null && race.phase === 'race_week' && race.daysToGo != null ? dow + race.daysToGo - 1 : null;
  let reserved = 0;
  // A cap on the long run alone ("long run <= ~8 km", "nothing over ~4 km" in a restart that begins mid-week) also limits what is kept for it.
  const longCaps = instructions.filter(i => i.kind === 'long_run_cap').map(i => i.hi);
  if (longDay != null && dow < longDay && longRunAhead) reserved += Math.min(longRunKm as number, ...longCaps);
  if (raceEveDow != null && raceEveDow > dow && raceEveDow <= 6 && ahead.includes(raceEveDow)) reserved += SHAKEOUT_KM;
  // "skip the long run".
  const skipLong = instructions.some(i => i.kind === 'done');
  // Wave 26e group E: "3 short easy runs, each <= ~6 km": no single run goes over it (the week's total is still the plan's number, spread over what is left).
  const runCaps = instructions.filter(i => i.kind === 'per_run_cap').map(i => i.hi);
  if (dow === longDay) {
    const km = Math.min(longRunKm as number, budget, ...longCaps, ...runCaps);
    return { km: skipLong ? 0 : round1(km), why: `long run (plan ${longRunKm}, budget ${round1(budget)})` };
  }
  const daysLeft = runDows.filter(d => d >= dow && d !== longDay && d !== raceEveDow).length || 1;
  const share = Math.min((budget - Math.min(reserved, budget)) / daysLeft, ...runCaps);
  return { km: round1(share), why: `share of ${round1(budget)} km over ${daysLeft} day(s), ${round1(reserved)} km kept for later${runCaps.length > 0 ? `, each run at most ${round1(Math.min(...runCaps))} km` : ''}` };
}

const cache = new Map<string, { workouts: WorkoutRow[]; kinds: string[] }>();

/**
 * Walks the days from 0 to `lastDay`; on each run day the runner reads the real morning card of the rows so far and logs the run
 * it implies. Returns the rows and, for the scenario notes, the plan kind each Monday gave.
 */
export function obedientDayByDay(key: string, opts: ObedientOpts): { workouts: WorkoutRow[]; kinds: string[] } {
  const hit = cache.get(key);
  if (hit) return { workouts: hit.workouts.map(w => ({ ...w })), kinds: [...hit.kinds] };
  const kinds: string[] = [];
  const rows: WorkoutRow[] = [];
  const scn: Scenario = { ...opts.base, workouts: rows };
  const raceDate = opts.base.user.raceDate;
  const raceKm = opts.base.user.raceDistanceKm;
  for (let idx = 0; idx <= opts.lastDay; idx++) {
    const date = addDays(opts.base.day0, idx);
    const dow = idx % 7; // day 0 is a Monday
    if (dow === 0) {
      const gp = computeProgressFor(scn, date);
      const ill = opts.illDays != null && [0, 1, 2, 3, 4, 5, 6].some(i => opts.illDays?.has(idx + i)) ? '/ill' : '';
      kinds.push(`${gp.distance?.plan?.kind ?? (idx === 0 ? 'baseline' : 'none')}${gp.distance?.plan?.cutback ? '/cutback' : ''}${ill}`);
    }
    if (opts.illDays?.has(idx)) continue;
    const scriptedKm = opts.scripted?.[idx];
    let km = 0;
    if (scriptedKm != null) km = scriptedKm;
    else if (raceDate === date) km = raceKm ?? 0;
    else if (BUILD_RUN_DOWS.includes(dow)) km = kmForDay(scn, idx, dow).km;
    if (km <= 0) continue;
    if (km < 1 && raceDate !== date) continue; // under a kilometre is a rest day, not a run
    const row = raceDate === date
      ? { day: date, type: 'Running', durationMin: 121, distanceM: Math.round(km * 1000) } satisfies WorkoutRow
      : runRowFor(date, km, dow === 6 ? 6.8 : 6.2);
    rows.push(row);
  }
  cache.set(key, { workouts: rows.map(w => ({ ...w })), kinds: [...kinds] });
  return { workouts: rows, kinds };
}
