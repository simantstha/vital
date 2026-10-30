/**
 * Vital — the ONE definition of "lift progress" (pure, no DB or Next.js imports).
 *
 * Every surface that quotes a multi-week change in a lift's estimated 1RM —
 * the Trends goal card reason/verdict (lib/goalProgress.ts), the weekly review
 * (lib/weeklyReview.ts) and the iOS Trends Strength card
 * (TrendsStrengthLogic.swift) — uses this definition so the same lift never
 * shows two different numbers.
 *
 * Definition ("vs 4 weeks ago"), on the UTC Monday-start weekly best e1RM
 * buckets from /api/workouts/summary, anchored on a Monday `anchorWeekStart`
 * (the current week for Trends, the reviewed week for the weekly review):
 *   end      = the most recent week with an e1RM among the anchor week and the
 *              two before it (so an empty / just-started current week, e.g. a
 *              Monday before training, is skipped instead of reading as a drop)
 *   recent   = best e1RM across `end` and the week before it
 *   baseline = best e1RM across the two weeks that end 4 weeks before `end`
 *              (end-35d and end-28d)
 *   change   = recent - baseline, rounded to 0.1 kg
 * "Progressing" = change >= +1% of baseline (LIFT_PROGRESS_MIN_FRACTION); a
 * smaller change is a stall — unless the lift is coming back from a break or is
 * in a deload (isLiftStalled, the ONE stall rule for the goal card, the weekly
 * review and the stalled-lift nudge).
 * Both windows need at least one week with an e1RM, otherwise there is no
 * change to report (never invented). Display wording: "+5.8 kg vs 4 weeks ago".
 *
 * Which lift speaks for the user (the "headline lift") is a separate, STABLE
 * rule (rankLifts / pickHeadlineLift): the lift trained in the most sessions
 * over the last 8 weeks that has a comparison; ties follow a fixed order
 * (squat, bench press, deadlift, overhead press, then A-Z). It never depends on
 * which lift moved the most, so the same lift leads from one day to the next.
 * It is also STICKY (headlineLeader): one short week must not hand the lead to
 * another lift for 8 weeks, so lifts within a session of the most-trained are
 * level with it (the fixed order decides) and the lead moves only when another
 * lift is 2+ sessions ahead at two weekly anchors in a row. The iOS ranking
 * (TrendsStrengthLogic.rankedLiftKeys) mirrors the plain order below the lead;
 * the server SENDS its lead (GoalProgress.headlineLift) and iOS prefers it.
 *
 * Keep in lockstep with TrendsStrengthLogic.change(...) — parity tests pin
 * identical fixtures to identical numbers in both languages.
 */

/** Weeks (back from the anchor) searched for the end of the recent window. */
export const LIFT_END_LOOKBACK_DAYS = [0, 7, 14] as const;
export const LIFT_RECENT_OFFSETS_DAYS = [0, 7] as const;
export const LIFT_BASELINE_OFFSETS_DAYS = [28, 35] as const;
/** A change of at least this fraction of the baseline counts as progress. */
export const LIFT_PROGRESS_MIN_FRACTION = 0.01;
/** Recent weekly volume under this fraction of the 4-week average is a deload. */
export const DELOAD_VOLUME_FRACTION = 0.6;

export interface LiftWeekPoint {
  weekStart: string;
  bestEstimatedOneRepMaxKg: number | null;
  volumeKg?: number;
  totalSets?: number;
  /** Distinct local days that week with a working set of this lift (absent on older fixtures: 1 per trained week). */
  sessions?: number;
  /** Heaviest loaded working set that week, kg (absent / null: unknown). */
  topLoadKg?: number | null;
}

export interface LiftChange4w {
  baselineKg: number;
  recentKg: number;
  /** recent - baseline, rounded to 0.1 kg. */
  changeKg: number;
}

export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function bestIn(weeks: LiftWeekPoint[], endWeekStart: string, offsetsDays: readonly number[]): number | null {
  const keys = new Set(offsetsDays.map(o => shiftDay(endWeekStart, -o)));
  let best: number | null = null;
  for (const w of weeks) {
    if (!keys.has(w.weekStart) || w.bestEstimatedOneRepMaxKg == null) continue;
    if (best == null || w.bestEstimatedOneRepMaxKg > best) best = w.bestEstimatedOneRepMaxKg;
  }
  return best;
}

/** Monday ending the recent window: the newest week with an e1RM among the anchor and the 2 weeks before it. */
export function liftRecentEndWeek(weeks: LiftWeekPoint[], anchorWeekStart: string): string | null {
  for (const o of LIFT_END_LOOKBACK_DAYS) {
    const key = shiftDay(anchorWeekStart, -o);
    if (weeks.some(w => w.weekStart === key && w.bestEstimatedOneRepMaxKg != null)) return key;
  }
  return null;
}

export function liftChange4w(weeks: LiftWeekPoint[], anchorWeekStart: string): LiftChange4w | null {
  const end = liftRecentEndWeek(weeks, anchorWeekStart);
  if (end == null) return null;
  const recentKg = bestIn(weeks, end, LIFT_RECENT_OFFSETS_DAYS);
  const baselineKg = bestIn(weeks, end, LIFT_BASELINE_OFFSETS_DAYS);
  if (recentKg == null || baselineKg == null) return null;
  return { baselineKg, recentKg, changeKg: Math.round((recentKg - baselineKg) * 10) / 10 };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Apr 6" for the Monday `weekStart` ("wk of Apr 6"): the month and day, no year. */
export function formatLiftWeek(weekStart: string): string {
  return `${MONTH_ABBR[Number(weekStart.slice(5, 7)) - 1]} ${Number(weekStart.slice(8, 10))}`;
}

/**
 * The baseline week `liftChange4w` used, for its LABEL only (wave 24s; the maths above is untouched, iOS mirrors it): the better of the weeks `end - 28 d` and
 * `end - 35 d` (the newer on a tie), exactly as `liftChange4w` takes it. `fourWeeksAgo` is true only when the baseline NUMBER came from the week 4 weeks before
 * the end week; when it came from the week before that (an ill or missed week left the 4-weeks-ago week empty, or only a light volume day - round 7: bench "114 → 123
 * kg" read "vs 4 weeks ago" while the 114 was set five weeks back) the label names the week it came from. `weekStart` is the Monday of that week. Null when there is
 * no comparison.
 */
export function liftBaselineWeek(weeks: LiftWeekPoint[], anchorWeekStart: string): { weekStart: string; fourWeeksAgo: boolean } | null {
  const end = liftRecentEndWeek(weeks, anchorWeekStart);
  if (end == null || liftChange4w(weeks, anchorWeekStart) == null) return null;
  let best: { weekStart: string; kg: number } | null = null;
  for (const offset of LIFT_BASELINE_OFFSETS_DAYS) {
    const key = shiftDay(end, -offset);
    const kg = weeks.find(w => w.weekStart === key)?.bestEstimatedOneRepMaxKg;
    if (kg == null) continue;
    if (best == null || kg > best.kg || (kg === best.kg && key > best.weekStart)) best = { weekStart: key, kg };
  }
  return best ? { weekStart: best.weekStart, fourWeeksAgo: best.weekStart === shiftDay(end, -LIFT_BASELINE_OFFSETS_DAYS[0]) } : null;
}

/**
 * "vs 4 weeks ago", or "vs wk of Aug 31" when the baseline number came from the week before the 4-weeks-ago week (`liftBaselineWeek`). The weekly review passes
 * `'week'` (wave 25s): its window ends at the REVIEWED week, not today, so on a Monday its 4-week number differs from the card's (card "+9 kg vs 4 weeks ago", review
 * "+10 kg vs 4 weeks before": two near-identical labels over two numbers). It therefore NAMES its baseline week every time - "vs wk of Mar 16" - and falls back to
 * "vs 4 weeks before" only when there is no comparison to name.
 */
export function liftBaselineLabel(weeks: LiftWeekPoint[], anchorWeekStart: string, ref: 'ago' | 'week' = 'ago'): string {
  const b = liftBaselineWeek(weeks, anchorWeekStart);
  if (b == null) return ref === 'week' ? 'vs 4 weeks before' : 'vs 4 weeks ago';
  if (b.fourWeeksAgo && ref === 'ago') return 'vs 4 weeks ago';
  return `vs wk of ${formatLiftWeek(b.weekStart)}`;
}

/** kg -> lb, same factor as lib/goalProgress.ts (KG_TO_LB); duplicated to keep this file import-free. */
const LB_PER_KG = 2.20462;

/** Completed weeks the "most-trained lift" ranking looks back over. */
export const LIFT_RANK_WINDOW_WEEKS = 8;
/** Tie-break order for equally-trained lifts; any other lift follows, A-Z. */
export const MAIN_LIFT_ORDER = ['squat', 'bench press', 'deadlift', 'overhead press'] as const;

function normalizeLiftKey(key: string): string {
  return key.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mainLiftRank(key: string): number {
  const i = (MAIN_LIFT_ORDER as readonly string[]).indexOf(normalizeLiftKey(key));
  return i === -1 ? MAIN_LIFT_ORDER.length : i;
}

/** Sessions that week (days with a working set); weeks from older callers count 1 when anything was trained. */
function weekSessions(w: LiftWeekPoint): number {
  if (w.sessions != null) return w.sessions;
  return (w.totalSets ?? 0) > 0 || w.bestEstimatedOneRepMaxKg != null ? 1 : 0;
}

/**
 * Sessions containing this lift in the 8 COMPLETED weeks before the anchor week
 * (the anchor week itself is still being trained and would make the ranking
 * swing from day to day), or in the 8 weeks ending at it when
 * `includeAnchor`.
 */
export function liftSessionsLast8Weeks(weeks: LiftWeekPoint[], anchorWeekStart: string, includeAnchor = false): number {
  const newest = includeAnchor ? anchorWeekStart : shiftDay(anchorWeekStart, -7);
  const oldest = shiftDay(newest, -7 * (LIFT_RANK_WINDOW_WEEKS - 1));
  let n = 0;
  for (const w of weeks) if (w.weekStart >= oldest && w.weekStart <= newest) n += weekSessions(w);
  return n;
}

interface LiftScore { key: string; sessions: number }

/**
 * Lifts in rotation at `anchorWeekStart` (an e1RM in the last 8 weeks) with their
 * session counts, most-trained first: sessions containing the lift over the 8
 * COMPLETED weeks before the anchor week, ties by the fixed order (squat, bench
 * press, deadlift, overhead press, then A-Z). Before any week has completed (a
 * brand-new lifter) the anchor week counts (`anchorCounted`).
 */
function scoreLifts(progression: Record<string, LiftWeekPoint[]>, anchorWeekStart: string): { rows: LiftScore[]; anchorCounted: boolean } {
  const oldest = shiftDay(anchorWeekStart, -7 * (LIFT_RANK_WINDOW_WEEKS - 1));
  const inRotation = Object.entries(progression).filter(([, weeks]) =>
    weeks.some(w => w.bestEstimatedOneRepMaxKg != null && w.weekStart >= oldest && w.weekStart <= anchorWeekStart));
  const score = (includeAnchor: boolean) =>
    inRotation.map(([key, weeks]) => ({ key, sessions: liftSessionsLast8Weeks(weeks, anchorWeekStart, includeAnchor) }));
  let scored = score(false);
  let anchorCounted = false;
  if (scored.every(r => r.sessions === 0)) {
    scored = score(true);
    anchorCounted = true;
  }
  const rows = scored.sort((a, b) => b.sessions - a.sessions || mainLiftRank(a.key) - mainLiftRank(b.key) || a.key.localeCompare(b.key));
  return { rows, anchorCounted };
}

/** A lift takes the lead from the one before it in the fixed order only by out-training it by at least this many sessions (over the ranking's 8 weeks)... */
export const LIFT_HEADLINE_SWITCH_MARGIN = 2;
/** ... at this many weekly anchors in a row: the anchor week's count and the week before's (a one-week blip never moves the lead). */
export const LIFT_HEADLINE_SWITCH_WEEKS = 2;

/** Lifts within LIFT_HEADLINE_SWITCH_MARGIN - 1 sessions of the most-trained one: level with it, for the lead. */
function levelWithTop(rows: LiftScore[]): string[] {
  if (rows.length === 0) return [];
  const top = rows[0].sessions;
  return rows.filter(r => top - r.sessions < LIFT_HEADLINE_SWITCH_MARGIN).map(r => r.key);
}

/**
 * The lift that leads the ranking at `anchorWeekStart`, kept steady against a short
 * week. The plain rule (the most-trained lift) let one short week hand the lead to
 * another lift by a single session for the 8 weeks it stays in the window
 * (lifter_short_week: squat -> bench from day 49 to the end). So a lift only
 * out-trains the others when it is LIFT_HEADLINE_SWITCH_MARGIN+ sessions ahead:
 * the lifts within one session of the most-trained are level with it, and the
 * fixed order (squat, bench press, deadlift, overhead press, then A-Z) decides
 * among them. The margin has to hold at LIFT_HEADLINE_SWITCH_WEEKS anchors in a
 * row (this one and the week before): a lift level at either of them is still
 * level now, so the lead moves one Monday after a lift really falls behind, never
 * on a blip. A pure function of the weekly history (nothing is stored, and the
 * counts of both anchors lie inside the 84 days the loaders read). A brand-new
 * lifter (no completed week yet) ranks on the week so far, plainly. Null when no
 * lift is in rotation.
 */
export function headlineLeader(progression: Record<string, LiftWeekPoint[]>, anchorWeekStart: string): string | null {
  const now = scoreLifts(progression, anchorWeekStart);
  if (now.rows.length === 0) return null;
  if (now.anchorCounted) return now.rows[0].key;
  const level = new Set(levelWithTop(now.rows));
  const before = scoreLifts(progression, shiftDay(anchorWeekStart, -7));
  if (!before.anchorCounted) for (const key of levelWithTop(before.rows)) if (now.rows.some(r => r.key === key)) level.add(key);
  const eligible = now.rows.filter(r => level.has(r.key)).map(r => r.key);
  return eligible.sort((a, b) => mainLiftRank(a) - mainLiftRank(b) || a.localeCompare(b))[0];
}

/**
 * Lifts in rotation (an e1RM in the last 8 weeks), the headline lift first
 * (`headlineLeader`: the most-trained lift, kept in front through a short week),
 * then the rest most-trained first: sessions containing the lift over the 8
 * completed weeks before the anchor week, ties by the fixed order (squat, bench
 * press, deadlift, overhead press, then A-Z). Before any week has completed (a
 * brand-new lifter) the anchor week counts. Callers anchor on the Monday of the
 * week being described, so the card (this week) and the weekly review (the
 * Monday after the reviewed week) rank alike.
 */
export function rankLifts(progression: Record<string, LiftWeekPoint[]>, anchorWeekStart: string): string[] {
  const ranked = scoreLifts(progression, anchorWeekStart).rows.map(r => r.key);
  const leader = headlineLeader(progression, anchorWeekStart);
  return leader == null ? ranked : [leader, ...ranked.filter(key => key !== leader)];
}

export interface HeadlineLift {
  /** Canonical exercise key ("squat"). */
  exercise: string;
  change: LiftChange4w;
}

/**
 * THE headline-lift rule, shared by the Trends goal card / Today line, the
 * weekly review and the coach's lift lines: the most-trained lift (rankLifts)
 * that has a 4-week change (`liftChange4w`). Never the lift with the biggest
 * gain or drop, so the headline does not jump between lifts as numbers move.
 * Null when no lift has a comparable change.
 */
export function pickHeadlineLift(
  progression: Record<string, LiftWeekPoint[]>,
  anchorWeekStart: string,
): HeadlineLift | null {
  for (const exercise of rankLifts(progression, anchorWeekStart)) {
    const change = liftChange4w(progression[exercise], anchorWeekStart);
    if (change) return { exercise, change };
  }
  return null;
}

export interface LiftDisplayChange {
  /** Whole display units (kg, or lb for imperial). */
  baseline: number;
  recent: number;
  /** recent - baseline of the ROUNDED endpoints, so the shown numbers always add up. */
  change: number;
}

/**
 * User-facing e1RM numbers: whole kg (whole lb for imperial) — an estimated
 * 1RM to 0.1 kg is false precision. The change is computed from the rounded
 * endpoints ("99 → 108, +9"), never rounded separately.
 */
export function liftDisplayChange(c: LiftChange4w, imperial: boolean): LiftDisplayChange {
  const f = imperial ? LB_PER_KG : 1;
  const baseline = Math.round(c.baselineKg * f);
  const recent = Math.round(c.recentKg * f);
  return { baseline, recent, change: recent - baseline };
}

/** True when the change is a real gain: >= +1% of the baseline. */
export function isLiftProgressing(c: LiftChange4w): boolean {
  return c.changeKg >= c.baselineKg * LIFT_PROGRESS_MIN_FRACTION - 1e-9 && c.changeKg > 0;
}

/**
 * Deload check on a weekly volume series (weekStart -> volume): the mean of
 * the `recentWeeks` weeks ending at `endWeekStart` is under 60% of the mean of
 * the 4 weeks before them. Needs a positive 4-week average (else false).
 */
export function isDeload(volumeByWeek: Record<string, number>, endWeekStart: string, recentWeeks: number): boolean {
  let recent = 0;
  for (let i = 0; i < recentWeeks; i += 1) recent += volumeByWeek[shiftDay(endWeekStart, -7 * i)] ?? 0;
  recent /= recentWeeks;
  let prior = 0;
  for (let i = recentWeeks; i < recentWeeks + 4; i += 1) prior += volumeByWeek[shiftDay(endWeekStart, -7 * i)] ?? 0;
  prior /= 4;
  return prior > 0 && recent < prior * DELOAD_VOLUME_FRACTION;
}

/** Weekly volume series for one lift (volumeKg, or set count for bodyweight-only lifts). */
export function liftVolumeByWeek(weeks: LiftWeekPoint[]): Record<string, number> {
  const useKg = weeks.some(w => (w.volumeKg ?? 0) > 0);
  const out: Record<string, number> = {};
  for (const w of weeks) out[w.weekStart] = useKg ? (w.volumeKg ?? 0) : (w.totalSets ?? 0);
  return out;
}

/**
 * True when the lift was missing for two weeks in a row somewhere between the
 * baseline window and the recent one (end-35d .. end-7d): a break or a return
 * from one, not a plateau. Both the lift's own weeks and any gap count.
 */
function hadLiftBreak(weeks: LiftWeekPoint[], end: string): boolean {
  const had = (key: string): boolean => weeks.some(w => w.weekStart === key && ((w.totalSets ?? 0) > 0 || w.bestEstimatedOneRepMaxKg != null));
  for (let o = 7; o <= 28; o += 7) {
    if (!had(shiftDay(end, -o)) && !had(shiftDay(end, -(o + 7)))) return true;
  }
  return false;
}

/**
 * Stall = this lift's change vs 4 weeks ago is below +1% — the ONE stall
 * definition shared by the goal card, the weekly review and the stalled-lift
 * nudge. Not a stall when there is nothing to compare, when the lift was absent
 * for two weeks in a row before or inside the comparison (a break / return,
 * `hadLiftBreak`), or when the recent window is a deload.
 */
export function isLiftStalled(weeks: LiftWeekPoint[], anchorWeekStart: string): boolean {
  const c = liftChange4w(weeks, anchorWeekStart);
  const end = liftRecentEndWeek(weeks, anchorWeekStart);
  if (!c || end == null) return false;
  if (isLiftProgressing(c)) return false;
  if (hadLiftBreak(weeks, end)) return false;
  return !isDeload(liftVolumeByWeek(weeks), end, 2);
}

/** "bench press" -> "Bench Press"; prefers an explicit display name when known. */
export function liftDisplayName(key: string, display?: Record<string, string> | null): string {
  const given = display?.[key];
  if (given) return given;
  return key.replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── Returning from a break ──────────────────────────────────────────────────

/** Consecutive days without a strength session that count as a break (not just a rest week). */
export const LIFT_BREAK_MIN_DAYS = 10;
/** The "building back" state lasts until this many days after the break ended. */
export const LIFT_RETURN_WINDOW_DAYS = 35;
/** Weeks before the break whose best e1RM is "your pre-break best". */
export const LIFT_PRE_BREAK_WEEKS = 4;

function dayDiff(from: string, to: string): number {
  const f = (d: string): number => {
    const [y, m, dd] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, dd) / 86_400_000;
  };
  return Math.round(f(to) - f(from));
}

/** Monday (UTC calendar) of the week containing `day`. */
function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return shiftDay(day, -dow);
}

export interface LiftBreak {
  /** Days in a row without a strength session. */
  breakDays: number;
  /** Last day without a session. */
  breakEnd: string;
  /** First session back. */
  returnDay: string;
  /** Last session before the break. */
  lastBeforeDay: string;
}

/**
 * The most recent run of >= LIFT_BREAK_MIN_DAYS days without a strength session
 * that is OVER (a session followed it) and ended within the last
 * LIFT_RETURN_WINDOW_DAYS days of `todayKey`. Null otherwise — including while
 * the break is still going on.
 */
export function findRecentBreak(sessionDays: readonly string[], todayKey: string): LiftBreak | null {
  const days = [...new Set(sessionDays.filter(d => d <= todayKey))].sort();
  for (let i = days.length - 1; i >= 1; i -= 1) {
    const gap = dayDiff(days[i - 1], days[i]) - 1;
    if (gap < LIFT_BREAK_MIN_DAYS) continue;
    const breakEnd = shiftDay(days[i], -1);
    if (dayDiff(breakEnd, todayKey) > LIFT_RETURN_WINDOW_DAYS) return null;
    return { breakDays: gap, breakEnd, returnDay: days[i], lastBeforeDay: days[i - 1] };
  }
  return null;
}

export interface LiftReturnState {
  /** The lift the state is about (the most-trained lift that has a pre-break best and a session since). */
  exercise: string;
  breakDays: number;
  /** Last day of the break (YYYY-MM-DD). */
  breakEnd: string;
  returnDay: string;
  /** Best e1RM in the 4 weeks before the break (kg). */
  preBreakKg: number;
  /** Best e1RM since the return (kg). */
  recentKg: number;
  /** Whole percent of the pre-break best: rounded down (max 99) while rebuilding so "100%" never appears early. */
  pct: number;
  /** True once the lift's best e1RM since the break matches or beats the pre-break best. */
  regained: boolean;
}

/**
 * The return state of ONE lift after `brk`: its best e1RM in the 4 weeks before
 * the break against its best since the return. Null when the lift has no
 * pre-break best or no session since.
 */
function returnStateOf(
  exercise: string,
  weeks: LiftWeekPoint[],
  brk: LiftBreak,
  anchor: string,
): LiftReturnState | null {
  const lastWeek = mondayOf(brk.lastBeforeDay);
  const returnWeek = mondayOf(brk.returnDay);
  const preKeys = new Set(Array.from({ length: LIFT_PRE_BREAK_WEEKS }, (_, i) => shiftDay(lastWeek, -7 * i)));
  let pre: number | null = null;
  let since: number | null = null;
  for (const w of weeks) {
    const e = w.bestEstimatedOneRepMaxKg;
    if (e == null) continue;
    if (preKeys.has(w.weekStart) && (pre == null || e > pre)) pre = e;
    if (w.weekStart >= returnWeek && w.weekStart <= anchor && (since == null || e > since)) since = e;
  }
  if (pre == null || since == null) return null;
  const regained = since >= pre - 1e-9;
  const ratio = (since / pre) * 100;
  return {
    exercise,
    breakDays: brk.breakDays,
    breakEnd: brk.breakEnd,
    returnDay: brk.returnDay,
    preBreakKg: pre,
    recentKg: since,
    pct: regained ? Math.round(ratio) : Math.min(99, Math.floor(ratio)),
    regained,
  };
}

/**
 * "Building back", lift by lift: the user took a break (findRecentBreak) and
 * every lift that has both a pre-break best (the 4 weeks before the break) and
 * a session since the return gets a state, regained or not. The first entry is
 * the headline lift of the return (the most-trained such lift, the one the
 * single `liftReturnState` and the payload's `liftReturn` speak for); after it
 * come the other MAIN lifts (squat, bench press, deadlift, overhead press) in
 * the same most-trained order — so "back above your pre-break best" can be
 * claimed only when every one of them is. Accessories never hold the claim back.
 * Empty with no recent break, or no lift that has both numbers.
 */
export function liftReturnStates(
  progression: Record<string, LiftWeekPoint[]>,
  sessionDays: readonly string[],
  todayKey: string,
): LiftReturnState[] {
  const brk = findRecentBreak(sessionDays, todayKey);
  if (!brk) return [];
  const anchor = mondayOf(todayKey);
  const states: LiftReturnState[] = [];
  for (const exercise of rankLifts(progression, anchor)) {
    const state = returnStateOf(exercise, progression[exercise], brk, anchor);
    if (state && (states.length === 0 || isMainLift(exercise))) states.push(state);
  }
  return states;
}

/**
 * "Building back": the user took a break (findRecentBreak) and the headline
 * lift's best e1RM since the return is still under its pre-break best. When it
 * has been regained `regained` is true (the state ends; the card says so until
 * the window closes). Null with no recent break, or no lift that has both a
 * pre-break best and a session since. This is the headline lift only — see
 * `liftReturnStates` for every main lift.
 */
export function liftReturnState(
  progression: Record<string, LiftWeekPoint[]>,
  sessionDays: readonly string[],
  todayKey: string,
): LiftReturnState | null {
  return liftReturnStates(progression, sessionDays, todayKey)[0] ?? null;
}

/**
 * The lift furthest under its pre-break best (the lowest share of it) among the
 * ones not yet regained; ties keep the order given (the headline lift first).
 * Null when every lift is back.
 */
export function furthestBehindReturn<T extends { preBreakKg: number; recentKg: number; regained: boolean }>(returns: readonly T[]): T | null {
  let worst: T | null = null;
  for (const r of returns) {
    if (r.regained || r.preBreakKg <= 0) continue;
    if (worst == null || r.recentKg / r.preBreakKg < worst.recentKg / worst.preBreakKg - 1e-9) worst = r;
  }
  return worst;
}

// ── Deload ──────────────────────────────────────────────────────────────────

/** A week whose volume is under this fraction of the prior 3 weeks' average is a deload. */
export const DELOAD_WEEK_VOLUME_FRACTION = 0.75;
/** ... or whose top sets are all at or under this fraction of the lifts' 4-week best. */
export const DELOAD_WEEK_LOAD_FRACTION = 0.9;

/** weekStart -> total training volume across every lift (set count when nothing was loaded). */
export function totalLiftVolumeByWeek(progression: Record<string, LiftWeekPoint[]>): Record<string, number> {
  const kg: Record<string, number> = {};
  const sets: Record<string, number> = {};
  for (const weeks of Object.values(progression)) {
    for (const w of weeks) {
      kg[w.weekStart] = (kg[w.weekStart] ?? 0) + (w.volumeKg ?? 0);
      sets[w.weekStart] = (sets[w.weekStart] ?? 0) + (w.totalSets ?? 0);
    }
  }
  return Object.values(kg).some(v => v > 0) ? kg : sets;
}

/**
 * THE deload-week rule (the weekly review's "Deload week done"): the user
 * trained that week (at least one logged set) AND either
 *  - total volume is under 75% of the prior 3 weeks' average, or
 *  - every lift trained that week (with a 4-week history) peaked at or under
 *    90% of its best top-set load in the 4 weeks before.
 * Needs prior weeks to compare with; never true for a first week.
 */
export function isDeloadWeek(progression: Record<string, LiftWeekPoint[]>, weekStart: string): boolean {
  const trained = Object.values(progression).some(weeks => weeks.some(w => w.weekStart === weekStart && weekSessions(w) > 0));
  if (!trained) return false;

  const volume = totalLiftVolumeByWeek(progression);
  let prior = 0;
  for (let i = 1; i <= 3; i += 1) prior += volume[shiftDay(weekStart, -7 * i)] ?? 0;
  prior /= 3;
  if (prior > 0 && (volume[weekStart] ?? 0) < prior * DELOAD_WEEK_VOLUME_FRACTION) return true;

  let judged = 0;
  for (const weeks of Object.values(progression)) {
    const cur = weeks.find(w => w.weekStart === weekStart);
    if (!cur || weekSessions(cur) === 0) continue;
    // Top load when both sides have it, else the best e1RM (older payloads carry no top load).
    const earlier = weeks.filter(w => w.weekStart < weekStart && w.weekStart >= shiftDay(weekStart, -28));
    const byLoad = cur.topLoadKg != null && earlier.some(w => w.topLoadKg != null);
    const proxy = (w: LiftWeekPoint): number | null => (byLoad ? (w.topLoadKg ?? null) : w.bestEstimatedOneRepMaxKg);
    const now = proxy(cur);
    let best: number | null = null;
    for (const w of earlier) {
      const v = proxy(w);
      if (v != null && (best == null || v > best)) best = v;
    }
    if (now == null || best == null || best <= 0) continue;
    judged += 1;
    if (now > best * DELOAD_WEEK_LOAD_FRACTION + 1e-9) return false;
  }
  return judged > 0;
}

// ── Working loads and the next load ─────────────────────────────────────────

/** Best top-set load (kg) in the `weeks` weeks before `weekStart` (exclusive); null when none is known. */
export function priorTopLoadKg(weeksOfLift: LiftWeekPoint[], weekStart: string, weeks = 4): number | null {
  const oldest = shiftDay(weekStart, -7 * weeks);
  let best: number | null = null;
  for (const w of weeksOfLift) {
    if (w.weekStart >= weekStart || w.weekStart < oldest || w.topLoadKg == null) continue;
    if (best == null || w.topLoadKg > best) best = w.topLoadKg;
  }
  return best;
}

/** Top-set load (kg) of the newest week at or before `weekStart` that has one; null when none is known. */
export function latestTopLoadKg(weeksOfLift: LiftWeekPoint[], weekStart: string): number | null {
  let latest: LiftWeekPoint | null = null;
  for (const w of weeksOfLift) {
    if (w.weekStart > weekStart || w.topLoadKg == null || w.topLoadKg <= 0) continue;
    if (latest == null || w.weekStart > latest.weekStart) latest = w;
  }
  return latest?.topLoadKg ?? null;
}

const LOWER_BODY_COMPOUND_STEMS = ['squat', 'deadlift', 'leg press', 'hip thrust'];

/** Mirrors LiftLoggerLogic.isLowerBodyCompound (iOS): squat, deadlift, RDL, leg press, hip thrust and variants. */
export function isLowerBodyCompound(exerciseKey: string): boolean {
  const key = normalizeLiftKey(exerciseKey);
  if (!key) return false;
  if (key.split(' ').includes('rdl')) return true;
  return LOWER_BODY_COMPOUND_STEMS.some(stem => key.includes(stem));
}

export interface NextLoad {
  /** The working load as logged, in display units (rounded to 0.5 kg / 1 lb): what a "hold" keeps. */
  from: number;
  /** The load the step starts from: `from` snapped to the NEAREST 2.5 kg / 5 lb grid value, so the step is exactly one plate step and the real step from `from` is half to one-and-a-half grid steps (2.5-7.5 lb, 1.25-3.75 kg). */
  start: number;
  /** The load to try next: `start` plus one step, always on the grid (capped at the logger's maximum). */
  to: number;
  unit: 'kg' | 'lb';
  /** True whenever `start` is not the load as logged: shown with a "~" ("bench ~190 → 195 lb"). */
  approx: boolean;
}

const MAX_LOAD_KG = 1000;
const MAX_LOAD_LB = 2200;

/**
 * The next-weight rule behind the review's "Squat 110 → 112.5 kg" and the
 * "try …" hint after a clean session: top load + 2.5 kg / 5 lb for EVERY lift,
 * on the 2.5 kg / 5 lb grid, so every step is loadable with standard plates (a
 * 1.25 kg step is 0.625 kg a side — "bench 80 → 81.5 kg" needs 0.75 kg plates
 * nobody has). The load is first read as logged (`from`, to 0.5 kg / 1 lb), then
 * snapped to the NEAREST grid value (`start`, wave 24s) and stepped exactly once
 * (`to` = `start` + step): "bench ~195 → 200 lb" for a bench logged at 193 lb,
 * never "193 → 200" (a +7 that is no step) or "176 → 180" (a +4). Wave 23s
 * rounded DOWN, which printed "Squat ~255 → 260 lb" after a 259 lb set (+1) and
 * "bench ~190 → 195" after 193 (+2), steps that were no progression; the nearest
 * value makes the real step from the logged load 2.5-7.5 lb (1.25-3.75 kg).
 * `approx` marks EVERY start that moved from the logged load. `to` is capped at
 * the logger's maximum and never below `from`. `topLoadKg` is the lift's top
 * working set.
 * Mirrors LiftLoggerLogic.nextLoad (iOS), which returns `to`.
 */
export function nextWorkingLoad(topLoadKg: number, _exerciseKey: string, imperial: boolean): NextLoad {
  const unit = imperial ? 'lb' : 'kg';
  const step = imperial ? 5 : 2.5;
  const plate = imperial ? 1 : 0.5;
  const from = Math.round((imperial ? topLoadKg * LB_PER_KG : topLoadKg) / plate) * plate;
  const start = Math.round(from / step + 1e-9) * step;
  const to = Math.min(start + step, imperial ? MAX_LOAD_LB : MAX_LOAD_KG);
  return { from, start, to: Math.max(to, from), unit, approx: Math.abs(start - from) > 1e-9 };
}

/** A fraction of a working load (kg) in display units, rounded to 2.5 kg / 5 lb ("~105 kg"). */
export function easedLoad(topLoadKg: number, fraction: number, imperial: boolean): { value: number; unit: 'kg' | 'lb' } {
  const plate = imperial ? 5 : 2.5;
  const v = (imperial ? topLoadKg * LB_PER_KG : topLoadKg) * fraction;
  return { value: Math.round(v / plate) * plate, unit: imperial ? 'lb' : 'kg' };
}

// ── Week over week (before the first 4-week comparison) ─────────────────────

export interface LiftWeekChange {
  /** The newest week before `endWeekStart` with an e1RM ("last trained week"). */
  previousWeekStart: string;
  previousKg: number;
  currentKg: number;
  /** current - previous, rounded to 0.1 kg. */
  changeKg: number;
}

/**
 * The ONE week-over-week definition ("vs last trained week"), for the weeks
 * before a lift has a 4-week comparison: the best e1RM of `endWeekStart`
 * against the best e1RM of the newest earlier week that has one. The goal card
 * (end = the recent window's end week) and the weekly review (end = the
 * reviewed week) both read it, and show it through `liftDisplayChange` so the
 * same pair of weeks prints the same whole-kg number in both. Null when either
 * week has no e1RM.
 */
export function liftWeekOverWeek(weeks: LiftWeekPoint[], endWeekStart: string): LiftWeekChange | null {
  const cur = weeks.find(w => w.weekStart === endWeekStart);
  if (!cur || cur.bestEstimatedOneRepMaxKg == null) return null;
  let prev: LiftWeekPoint | null = null;
  for (const w of weeks) {
    if (w.weekStart >= endWeekStart || w.bestEstimatedOneRepMaxKg == null) continue;
    if (prev == null || w.weekStart > prev.weekStart) prev = w;
  }
  if (!prev) return null;
  const previousKg = prev.bestEstimatedOneRepMaxKg as number;
  return {
    previousWeekStart: prev.weekStart,
    previousKg,
    currentKg: cur.bestEstimatedOneRepMaxKg,
    changeKg: Math.round((cur.bestEstimatedOneRepMaxKg - previousKg) * 10) / 10,
  };
}

/**
 * The week-over-week change as printed: whole kg (lb), rounded from the change itself, not subtracted from two rounded endpoints. A
 * constant +2.5 kg step on the bar moves the e1RM by one amount, and rounding both ends first read it "+3", "+4", "+3" week to week. The
 * week-over-week text prints no endpoints ("Squat est. 1RM +3 kg vs the week before"), so nothing has to add up; the 4-week change, which
 * does print them ("126 → 136 kg"), keeps `liftDisplayChange`.
 */
export function liftWeekChangeDisplay(c: LiftWeekChange, imperial: boolean): number {
  return Math.round(c.changeKg * (imperial ? LB_PER_KG : 1)) || 0; // never -0
}

export interface PickedWeekChange {
  /** Canonical exercise key ("squat"). */
  exercise: string;
  /** The week the change ends on (Monday). */
  end: string;
  change: LiftWeekChange;
}

/**
 * Which lift speaks for the week-over-week line: the most-trained lift
 * (`rankLifts` on `anchorWeekStart`) that has a change ending on the first of
 * `ends` it can use. The weekly review passes just the reviewed week; the goal
 * card passes the last completed week first, then the week in progress, so the
 * card quotes the same pair of weeks the review does for the whole week after
 * it (a half-trained week never drives the number).
 */
export function pickWeekOverWeek(
  progression: Record<string, LiftWeekPoint[]>,
  anchorWeekStart: string,
  ends: readonly string[],
): PickedWeekChange | null {
  const ranked = rankLifts(progression, anchorWeekStart);
  for (const end of ends) {
    for (const exercise of ranked) {
      const change = liftWeekOverWeek(progression[exercise], end);
      if (change) return { exercise, end, change };
    }
  }
  return null;
}

export interface WeekOverWeekWording {
  /** The week the change is about, against the anchor Monday: "Last week" (the week before it), "This week" (the week in progress); null for any other. */
  window: 'Last week' | 'This week' | null;
  /** What it is measured against: "vs the week before", "vs last week" (this week's), or "vs last trained week" when training skipped a week. */
  vs: string;
}

/**
 * The ONE wording of a week-over-week change, so the goal card and the weekly
 * review label the same pair of weeks the same way. A bare "vs last trained
 * week" read as the week just trained: on the Sunday the card quoted the week
 * BEFORE the current one (+4 kg), and Monday's review of the week just finished
 * said +3 kg. Now the card says "Last week: Squat est. 1RM +4 kg vs the week
 * before" and the review, which reads the same pair on that Monday, "vs the week
 * before" too. `anchorWeekStart` is the Monday the card / review is anchored on.
 */
export function weekOverWeekWording(change: LiftWeekChange, endWeekStart: string, anchorWeekStart: string): WeekOverWeekWording {
  const window = endWeekStart === shiftDay(anchorWeekStart, -7) ? 'Last week' : endWeekStart === anchorWeekStart ? 'This week' : null;
  const adjacent = change.previousWeekStart === shiftDay(endWeekStart, -7);
  return { window, vs: !adjacent ? 'vs last trained week' : window === 'This week' ? 'vs last week' : 'vs the week before' };
}

// ── A lapse (no session for a week or more) ─────────────────────────────────

/**
 * The longest a lapse threshold gets: with no weekly target (or a 1-2 a week
 * one) a week without a strength session is where the goal card stops praising
 * the lifts ("No sessions for 8 days — Squat was est. 1RM 142 kg") and the
 * coach is told not to. The 4-week lift change looks back two weeks (above), so
 * without a lapse a lifter who missed a whole week still read "Progressing".
 */
export const LIFT_LAPSE_MIN_DAYS = 7;
/** The shortest a lapse threshold gets: a 4+ a week lifter is lapsing after 4 days off. */
export const LIFT_LAPSE_FLOOR_DAYS = 4;
/** A lapse is this many days' worth of the weekly plan missed: two weeks of sessions spread over the target. */
const LIFT_LAPSE_PLAN_DAYS = 14;

/**
 * Days without a strength session from which the card calls a lapse, scaled to
 * the weekly target: clamp(ceil(14 / target), 4, 7) — 4 days for 4 a week, 5 for
 * 3, 7 for 2 or fewer or with no target. A fixed week let a 4 a week lifter miss
 * four sessions in a row and still read "Progressing".
 */
export function liftLapseMinDays(weeklyTarget: number | null | undefined): number {
  if (weeklyTarget == null || !Number.isFinite(weeklyTarget) || weeklyTarget < 1) return LIFT_LAPSE_MIN_DAYS;
  return Math.min(LIFT_LAPSE_MIN_DAYS, Math.max(LIFT_LAPSE_FLOOR_DAYS, Math.ceil(LIFT_LAPSE_PLAN_DAYS / weeklyTarget)));
}

/**
 * The lift's recent best e1RM and the Monday of the week it was set — what the
 * card said before the lapse (the same `recent` window as liftChange4w: the end
 * week and the week before it; the newest week with an e1RM when the lift has
 * been out of the 3-week look-back). Ties go to the newer week. Null when the
 * lift has no e1RM at all.
 */
export function liftLastBest(weeks: LiftWeekPoint[], anchorWeekStart: string): { kg: number; weekStart: string } | null {
  let end = liftRecentEndWeek(weeks, anchorWeekStart);
  if (end == null) {
    for (const w of weeks) if (w.bestEstimatedOneRepMaxKg != null && (end == null || w.weekStart > end)) end = w.weekStart;
  }
  if (end == null) return null;
  let best: { kg: number; weekStart: string } | null = null;
  for (const offset of LIFT_RECENT_OFFSETS_DAYS) {
    const key = shiftDay(end, -offset);
    const w = weeks.find(x => x.weekStart === key && x.bestEstimatedOneRepMaxKg != null);
    const kg = w?.bestEstimatedOneRepMaxKg;
    if (kg != null && (best == null || kg > best.kg + 1e-9)) best = { kg, weekStart: key };
  }
  return best;
}

// ── Return numbers as shown ─────────────────────────────────────────────────

export interface LiftReturnDisplay {
  /** Whole kg / lb, the numbers the copy prints. */
  pre: number;
  recent: number;
  /** Whole percent of the SHOWN pre-break number, rounded normally; at most 99 while rebuilding. */
  pct: number;
  unit: 'kg' | 'lb';
}

/**
 * The return numbers exactly as printed — whole kg (lb), with the percentage
 * computed from those shown numbers, never from the unrounded e1RMs behind them
 * ("136 of 142 kg" is 96%, whatever 136.4 / 142.2 would say), and rounded the
 * normal way ("139 of 142 kg" is 98%, not the 97% a floor gives). While still
 * rebuilding, a recent number that rounds up to the pre-break one is shown one
 * unit under it and the percentage is capped at 99, so the copy never claims
 * "142 of 142" or "100%" before it is regained.
 */
export function liftReturnDisplay(
  r: { preBreakKg: number; recentKg: number; regained: boolean },
  imperial: boolean,
): LiftReturnDisplay {
  const f = imperial ? LB_PER_KG : 1;
  const pre = Math.round(r.preBreakKg * f);
  let recent = Math.round(r.recentKg * f);
  if (!r.regained && recent >= pre) recent = pre - 1;
  const ratio = pre > 0 ? (recent / pre) * 100 : 0;
  return { pre, recent, pct: r.regained ? Math.round(ratio) : Math.min(99, Math.round(ratio)), unit: imperial ? 'lb' : 'kg' };
}

// ── Next session's loads, every main lift ───────────────────────────────────

/** Lifts a "next session" cue names at most. */
export const MAX_CUED_LIFTS = 3;

export function isMainLift(key: string): boolean {
  return (MAIN_LIFT_ORDER as readonly string[]).includes(normalizeLiftKey(key));
}

/** Short spoken name for a cue after the first lift ("bench press" -> "bench", "Overhead Press" -> "overhead press"). */
export function liftShortName(key: string, display?: Record<string, string> | null): string {
  const k = normalizeLiftKey(key);
  if (k === 'bench press') return 'bench';
  return liftDisplayName(key, display).toLowerCase();
}

/**
 * The lifts a "next session" cue talks about: the lead lift (the headline lift,
 * when it was trained in the reviewed week), then the other main lifts (squat,
 * bench press, deadlift, overhead press) trained that week, most-trained first,
 * at most MAX_CUED_LIFTS. A lift not trained in the reviewed week has no
 * current load to cue; accessories are left out.
 */
export function cuedLifts(progression: Record<string, LiftWeekPoint[]>, weekStart: string, leadKey: string | null): string[] {
  const trained = (key: string): boolean =>
    (progression[key] ?? []).some(w => w.weekStart === weekStart && weekSessions(w) > 0 && w.topLoadKg != null && w.topLoadKg > 0);
  const out: string[] = [];
  if (leadKey != null && trained(leadKey)) out.push(leadKey);
  for (const key of rankLifts(progression, shiftDay(weekStart, 7))) {
    if (out.length >= MAX_CUED_LIFTS) break;
    if (out.includes(key) || !isMainLift(key) || !trained(key)) continue;
    out.push(key);
  }
  return out;
}

/**
 * The reviewed week's best e1RM fell more than 1% under the lift's previous
 * trained week: the top sets did not land as they did before, so the load is
 * held rather than raised. (The review has no per-set reps, only the weekly
 * best, so this is its read of "did not hit its reps".) False with nothing to
 * compare.
 */
export function liftRegressed(weeks: LiftWeekPoint[], weekStart: string): boolean {
  const cur = weeks.find(w => w.weekStart === weekStart)?.bestEstimatedOneRepMaxKg;
  if (cur == null) return false;
  let prev: LiftWeekPoint | null = null;
  for (const w of weeks) {
    if (w.weekStart >= weekStart || w.bestEstimatedOneRepMaxKg == null) continue;
    if (prev == null || w.weekStart > prev.weekStart) prev = w;
  }
  const prevKg = prev?.bestEstimatedOneRepMaxKg;
  return prevKg != null && cur < prevKg * (1 - LIFT_PROGRESS_MIN_FRACTION) - 1e-9;
}

/**
 * True when the lift was trained at working weight in the week starting `weekStart`: a loaded working set whose top load is at least
 * DELOAD_WEEK_LOAD_FRACTION (90%) of its best top load in the 4 weeks before (or nothing before to compare with). A light volume day,
 * or no session of the lift at all, is not — a gain "over 4 weeks" is then not something that week produced.
 */
export function liftTrainedAtWorkingWeight(weeks: LiftWeekPoint[], weekStart: string): boolean {
  const current = weeks.find(w => w.weekStart === weekStart && weekSessions(w) > 0 && w.topLoadKg != null && w.topLoadKg > 0);
  if (current == null) return false;
  const best = priorTopLoadKg(weeks, weekStart, 4);
  return best == null || (current.topLoadKg as number) >= best * DELOAD_WEEK_LOAD_FRACTION - 1e-9;
}

export interface LiftLoadCue {
  key: string;
  /** Today's working load and the next one by the lift logger's rule (`nextWorkingLoad`); `from` is the load to hold. */
  load: NextLoad;
  /** True when the load stays (the lift's e1RM fell last week). */
  hold: boolean;
}

/**
 * Next-session load for every cued lift (`cuedLifts`): the same next-load rule
 * for each — top load + the lift logger's step — or a hold when that lift went
 * backwards last week. `rebuilding` (returning from a break) never holds: last
 * week's lower number is the rebuild, not a miss.
 */
export function nextLoadCues(
  progression: Record<string, LiftWeekPoint[]>,
  weekStart: string,
  opts: { imperial: boolean; leadKey: string | null; rebuilding: boolean },
): LiftLoadCue[] {
  return cuedLifts(progression, weekStart, opts.leadKey).map(key => {
    const weeks = progression[key];
    const top = latestTopLoadKg(weeks, weekStart) as number;
    return { key, load: nextWorkingLoad(top, key, opts.imperial), hold: !opts.rebuilding && liftRegressed(weeks, weekStart) };
  });
}

// ── A proactive deload (wave 24s) ───────────────────────────────────────────

/** Straight weeks of heavier loads after which the next-week cue is a deload week. */
export const DELOAD_CUE_STREAK_WEEKS = 5;
/** The middle of the "~85-90%" the cue names: what a lifter who follows it lifts (rounded to the 2.5 kg / 5 lb grid). */
export const DELOAD_CUE_LOAD_FRACTION = 0.875;
/**
 * The one-time explainer for the term the lifter meets first (wave 23s in the review, wave 24s on the goal card: the card shows "est. 1RM" a week before the
 * first review does, so the card carries it, once, in the goal's first lift-comparison week - lib/goalProgress.ts).
 */
export const EST_1RM_EXPLAINER = 'Est. 1RM = the most you could lift once, estimated from your sets and how hard they felt.';

/**
 * The deload cue's lead-in: the review's "Next week" opens with it ("Deload week: ~85–90% of last week's loads, 2 working sets — then back to
 * Squat 112.5 kg, …"), the goal card carries exactly this line on every day of the cue's week, and so do the coach lines (they print the card).
 */
export const DELOAD_CUE_HEAD = "Deload week: ~85–90% of last week's loads, 2 working sets";
/** Weeks back the streak is counted over: more than enough for the cue (5) and for the "good timing after N straight weeks" note. */
const HEAVIER_STREAK_MAX_WEEKS = 10;

/**
 * True when the week starting `weekStart` stepped up: some main lift's top load is above its load the week before, no lift went backwards
 * (`liftRegressed`: that lift's cue is a hold, not a step) and neither week is a lighter one (`isDeloadWeek`: a deload, an ill / short week
 * and the first week back from one all fail it, so a week that only looks heavy against a light one never counts).
 */
function steppedUpWeek(progression: Record<string, LiftWeekPoint[]>, weekStart: string): boolean {
  const before = shiftDay(weekStart, -7);
  if (isDeloadWeek(progression, weekStart) || isDeloadWeek(progression, before)) return false;
  let up = false;
  for (const [key, weeks] of Object.entries(progression)) {
    if (!isMainLift(key)) continue;
    const now = weeks.find(w => w.weekStart === weekStart)?.topLoadKg ?? null;
    const was = weeks.find(w => w.weekStart === before)?.topLoadKg ?? null;
    if (now != null && liftRegressed(weeks, weekStart)) return false;
    if (now != null && was != null && now > was + 1e-9) up = true;
  }
  return up;
}

/**
 * Straight weeks of heavier loads ending at `endWeekStart` (inclusive): each week stepped up on the one before (`steppedUpWeek`). A lighter
 * week, a short or ill week, a week without the lifts or a comeback ends the count, so the next-week cue steps up at most
 * DELOAD_CUE_STREAK_WEEKS - 1 times in a row before it asks for a deload. 0 when `endWeekStart` itself did not step up.
 */
export function heavierLoadStreak(progression: Record<string, LiftWeekPoint[]>, endWeekStart: string): number {
  let n = 0;
  while (n < HEAVIER_STREAK_MAX_WEEKS && steppedUpWeek(progression, shiftDay(endWeekStart, -7 * n))) n += 1;
  return n;
}

export interface DeloadCue {
  /** Straight weeks of heavier loads behind the cue (at least DELOAD_CUE_STREAK_WEEKS). */
  weeks: number;
  /** The loads she goes back to after the deload week: her pre-deload top load of every cued lift (`load.from`, as logged), the lead lift first. */
  resume: Array<{ key: string; load: NextLoad }>;
  /** The deload week's own loads (wave 25s): DELOAD_CUE_LOAD_FRACTION (87.5%) of each `resume` lift's pre-deload top load on the 2.5 kg / 5 lb plate grid (`easedLoad`), same lifts, same order. */
  loads: Array<{ key: string; value: number; unit: 'kg' | 'lb' }>;
}

/**
 * The deload cue's lead-in WITH its loads (wave 25s; it used to name only a percentage, "~85–90% of last week's loads"): "Deload week: squat ~97.5 kg, bench ~80 kg,
 * deadlift ~115 kg, 2 working sets". One function for the review's "Next week" and the goal card (and so the coach lines), so they cannot drift apart. `fmt` joins a value
 * and its unit (the callers' non-breaking `withUnit`); without a known load the lead-in is the old generic `DELOAD_CUE_HEAD`.
 */
export function deloadCueHead(cue: DeloadCue, fmt: (value: number, unit: string) => string, display?: Record<string, string> | null): string {
  if (cue.loads.length === 0) return DELOAD_CUE_HEAD;
  return `Deload week: ${cue.loads.map(l => `${liftShortName(l.key, display)} ~${fmt(l.value, l.unit)}`).join(', ')}, 2 working sets`;
}

/**
 * The proactive deload: after DELOAD_CUE_STREAK_WEEKS straight weeks of heavier loads ending at the reviewed week the next-week cue is
 * "Deload week: ~85-90% of last week's loads, 2 working sets - then back to squat 112.5 kg, ..." (a lifter who adds 2.5 kg to every lift every
 * week for 14 weeks was only ever praised for a deload, never sent to one). Never while rebuilding after a break. The resume loads are the
 * pre-deload top loads of the lifts trained that week (`cuedLifts`); the week after the deload goes back to exactly these.
 */
export function proactiveDeload(
  progression: Record<string, LiftWeekPoint[]>,
  reviewedWeekStart: string,
  opts: { imperial: boolean; leadKey: string | null; rebuilding: boolean },
): DeloadCue | null {
  if (opts.rebuilding) return null;
  const weeks = heavierLoadStreak(progression, reviewedWeekStart);
  if (weeks < DELOAD_CUE_STREAK_WEEKS) return null;
  const tops = cuedLifts(progression, reviewedWeekStart, opts.leadKey).map(key => ({ key, top: latestTopLoadKg(progression[key], reviewedWeekStart) as number }));
  const resume = tops.map(({ key, top }) => ({ key, load: nextWorkingLoad(top, key, opts.imperial) }));
  const loads = tops.map(({ key, top }) => ({ key, ...easedLoad(top, DELOAD_CUE_LOAD_FRACTION, opts.imperial) }));
  return { weeks, resume, loads };
}

/**
 * The loads to go back to after ANY deload week (wave 25s: ONE rule for a deload the app prescribed and one she chose herself): the pre-deload top load of every cued
 * lift, as logged (`load.from`) - no step, the +2.5 kg follows the week after, from a load she has lifted again ("Back to full loads: Squat 107.5 kg, bench 85 kg").
 * The conservative standard; it used to add the step for her own deload ("Squat 107.5 -> 110 kg") and stop at the loads for a prescribed one. Null when `deloadWeekStart`
 * was not a deload week, or no pre-deload load is known.
 */
export function preDeloadLoads(
  progression: Record<string, LiftWeekPoint[]>,
  deloadWeekStart: string,
  opts: { imperial: boolean; leadKey: string | null },
): Array<{ key: string; load: NextLoad }> | null {
  if (!isDeloadWeek(progression, deloadWeekStart)) return null;
  const out = cuedLifts(progression, deloadWeekStart, opts.leadKey).flatMap(key => {
    const pre = priorTopLoadKg(progression[key], deloadWeekStart, 4);
    return pre == null ? [] : [{ key, load: nextWorkingLoad(pre, key, opts.imperial) }];
  });
  return out.length > 0 ? out : null;
}

/**
 * The review of the deload week itself: when the week before it was a proactive-deload cue (`proactiveDeload`) and `deloadWeekStart` was a lighter
 * week, the loads to go back to as the cue promised (`preDeloadLoads`). Null when the deload was not asked for or nothing is known.
 */
export function afterProactiveDeload(
  progression: Record<string, LiftWeekPoint[]>,
  deloadWeekStart: string,
  opts: { imperial: boolean; leadKey: string | null },
): Array<{ key: string; load: NextLoad }> | null {
  if (proactiveDeload(progression, shiftDay(deloadWeekStart, -7), { ...opts, rebuilding: false }) == null) return null;
  return preDeloadLoads(progression, deloadWeekStart, opts);
}

// ── Next week's loads after a short week ────────────────────────────────────

export interface ShortWeekLoadCue {
  key: string;
  /**
   * 'skipped': not trained that week, so its LAST load repeats ("Squat 112.5 kg (your last load)"; wave 24s: the planned step it never lifted is not prescribed
   *   after a fortnight without a heavy set).
   * 'light': trained, but only as a light / volume day (top set under 90% of its 4-week best): its last load repeats too.
   * 'trained': trained at its working load, so the normal next-load rule applies.
   * 'hold': trained, but its e1RM fell last week: the load stays.
   */
  kind: 'skipped' | 'light' | 'trained' | 'hold';
  /** `from` is the lift's last working load (what a repeat or a hold keeps), `to` the step above it (what only a 'trained' lift is cued). */
  load: NextLoad;
}

/** The load (display units) a short-week cue puts on the bar: the step for a 'trained' lift, the last working load for a repeat ('skipped', 'light') or a hold. */
export function shortWeekLoadToLift(cue: ShortWeekLoadCue): number {
  return cue.kind === 'trained' ? cue.load.to : cue.load.from;
}

/**
 * Loads for the coming week after a week that fell short of its session target
 * (the review's "Back to 4 this week — don't make up the missed ones. Squat
 * 112.5 kg …"): every main lift in rotation, the lead lift first, at most
 * MAX_CUED_LIFTS. A lift that was not trained that week (or only as a light
 * volume day, under 90% of its 4-week best top set) repeats its LAST working
 * load (wave 24s): the missed session is not made up, and a step is not
 * prescribed after a fortnight without a heavy set — the +2.5 kg follows the
 * week after, from a load she has lifted again. A lift trained at its working
 * load follows the normal rule (`nextWorkingLoad`, or a hold when its e1RM
 * fell). A lift with no known load in the last 4 weeks has no load to repeat
 * and is left out. `shortWeekLoadToLift` is the load each cue puts on the bar.
 */
export function shortWeekLoadCues(
  progression: Record<string, LiftWeekPoint[]>,
  weekStart: string,
  opts: { imperial: boolean; leadKey: string | null; rebuilding: boolean },
): ShortWeekLoadCue[] {
  const ranked = rankLifts(progression, shiftDay(weekStart, 7)).filter(isMainLift);
  const lead = opts.leadKey != null && ranked.includes(opts.leadKey) ? [opts.leadKey] : [];
  const keys = [...lead, ...ranked.filter(key => !lead.includes(key))];
  const out: ShortWeekLoadCue[] = [];
  for (const key of keys) {
    if (out.length >= MAX_CUED_LIFTS) break;
    const weeks = progression[key] ?? [];
    const current = weeks.find(w => w.weekStart === weekStart && weekSessions(w) > 0 && w.topLoadKg != null && w.topLoadKg > 0);
    const best = priorTopLoadKg(weeks, weekStart, 4);
    const top = current?.topLoadKg ?? null;
    if (top != null && (best == null || top >= best * DELOAD_WEEK_LOAD_FRACTION - 1e-9)) {
      const hold = !opts.rebuilding && liftRegressed(weeks, weekStart);
      out.push({ key, kind: hold ? 'hold' : 'trained', load: nextWorkingLoad(top, key, opts.imperial) });
    } else if (best != null && best > 0) {
      out.push({ key, kind: current ? 'light' : 'skipped', load: nextWorkingLoad(best, key, opts.imperial) });
    }
  }
  return out;
}
