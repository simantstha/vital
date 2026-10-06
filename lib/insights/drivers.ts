/**
 * "What moves your HRV" — a read-only view over the proactive insight
 * engine's own certified findings.
 *
 * This module does NOT run any correlation or significance test of its own.
 * It only reads `cross_lag` findings that already survived the engine's
 * FDR-corrected hypothesis family (lib/insights/evidence.ts) and were
 * confirmed across two consecutive daily runs (lib/insights/confirmation.ts,
 * lib/insights/nudgeWorker.ts's `runInsightPass`). Re-testing here, even
 * informally, would bypass that correction — every row this module returns
 * is one the engine already stood behind.
 *
 * It then adds a *descriptive* magnitude (tercile means) so the client can
 * say something concrete about a certified association, without implying a
 * new statistical claim.
 */

import { previousDayKey } from '@/lib/localDay';
import { confirmAgainstPreviousRun } from './confirmation';
import { OUTCOME_METRICS } from './detectors';
import { mean } from './stats';
import type { Finding, MetricSeries } from './types';

/** A day's finding as it is stored in `insight_findings` (or a fake of one). */
export interface StoredFinding {
  signature: string;
  kind: string;
  computed_for: string;
  payload: {
    effect: number;
    effectLabel: string;
    n: number;
    pValue: number | null;
    metrics: string[];
    detail: Record<string, string | number>;
  };
}

export interface DriverBucket { mean: number; n: number }

/**
 * 'association' is a plain "X tends to go with Y" row. 'adaptation' marks an
 * activity driver whose outcome gets slightly worse on big-activity days
 * (e.g. steps -> lower HRV next day) for a user whose goal is NOT performance
 * training: the client must frame it as normal adaptation ("keep moving"),
 * never as advice to do less.
 */
export type DriverFraming = 'association' | 'adaptation';

export interface Driver {
  framing: DriverFraming;
  input: string;
  lag: 0 | 1;
  direction: 'up' | 'down';
  rho: number;
  pairs: number;
  high: DriverBucket | null;
  low: DriverBucket | null;
  highInputMean: number | null;
  lowInputMean: number | null;
}

export interface DriversResult {
  metric: string;
  computedFor: string | null;
  drivers: Driver[];
}

/** Findings older than this, relative to the user's local today, are stale. */
export const STALENESS_DAYS = 7;

const MIN_TERCILE_PAIRS = 5;

/**
 * Display gates, applied on top of the engine's own certification (its
 * MIN_PAIRS of 30, MIN_ABS_RHO of 0.35, FDR and two-run confirmation). They
 * are deliberately independent so a future loosening of the engine can't
 * silently flood the headline section with weak correlations.
 */
export const MIN_DRIVER_PAIRS = 28;
export const MIN_DRIVER_ABS_RHO = 0.3;
export const MAX_DRIVERS = 3;
/** Fewer consecutive-day pairs than this and "typical noise" is a guess. */
const MIN_NOISE_DIFFS = 5;

/** Inputs that mean "the user moved more / trained harder". */
export const ACTIVITY_INPUTS: ReadonlySet<string> = new Set([
  'steps', 'exercise_min', 'distance_m', 'active_energy_kcal', 'whoop_day_strain',
]);
/** Outcomes where a LOWER value is the healthy direction. */
const LOWER_IS_BETTER_OUTCOMES: ReadonlySet<string> = new Set(['resting_hr', 'whoop_resting_hr']);
/** Goals (users.goal ids; unknown/null count as general) whose users are training for performance, so activity load is the point. */
const PERFORMANCE_GOALS: ReadonlySet<string> = new Set(['muscle', 'endurance']);

function toEpochDays(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** True when `computedFor` is more than STALENESS_DAYS days before `localToday`. */
export function isStale(computedFor: string, localToday: string): boolean {
  return toEpochDays(localToday) - toEpochDays(computedFor) > STALENESS_DAYS;
}

function toFinding(row: StoredFinding): Finding {
  return {
    kind: row.kind as Finding['kind'],
    signature: row.signature,
    metrics: row.payload.metrics,
    effect: row.payload.effect,
    effectLabel: row.payload.effectLabel,
    n: row.payload.n,
    pValue: row.payload.pValue,
    detail: row.payload.detail,
  };
}

export interface PickedDriver {
  input: string;
  lag: 0 | 1;
  direction: 'up' | 'down';
  rho: number;
  pairs: number;
}

/**
 * Confirms `currentDayRows` against `previousDaySignatures` (mirroring
 * `confirmAgainstPreviousRun`), keeps `cross_lag` findings whose outcome is
 * `metric`, collapses lag 0 vs lag 1 per input to whichever has the larger
 * |rho|, sorts by |rho| descending, and caps at 3. Pure — no I/O.
 */
export function selectDrivers(
  currentDayRows: StoredFinding[],
  previousDaySignatures: Set<string>,
  metric: string,
  limit: number = MAX_DRIVERS,
): PickedDriver[] {
  const findings = currentDayRows.map(toFinding);
  const confirmed = confirmAgainstPreviousRun(findings, previousDaySignatures);

  const crossLag = confirmed.filter(
    (f) => f.kind === 'cross_lag' && f.detail.outcome === metric,
  );

  const byInput = new Map<string, Finding>();
  for (const finding of crossLag) {
    const input = String(finding.detail.input);
    const existing = byInput.get(input);
    if (!existing || Math.abs(finding.effect) > Math.abs(existing.effect)) {
      byInput.set(input, finding);
    }
  }

  return [...byInput.values()]
    // Display gates: enough paired days and a big-enough correlation.
    .filter((f) => Number(f.detail.pairs) >= MIN_DRIVER_PAIRS && Math.abs(f.effect) >= MIN_DRIVER_ABS_RHO)
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
    .slice(0, limit)
    .map((finding) => ({
      input: String(finding.detail.input),
      lag: (Number(finding.detail.lag) === 1 ? 1 : 0) as 0 | 1,
      direction: finding.effect < 0 ? 'down' : 'up',
      rho: Number(finding.detail.rho),
      pairs: Number(finding.detail.pairs),
    }));
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export interface Pair { input: number; outcome: number }

/**
 * Pairs `input[d]` with `outcome[d + lag]`, joined BY DATE — never by array
 * index, exactly like `detectCrossLag` — so a gap in either series can't
 * silently shift the alignment.
 */
export function pairByDateLag(input: MetricSeries, outcome: MetricSeries, lag: number): Pair[] {
  const outcomeByDate = new Map<string, number>();
  for (const point of outcome.points) if (point.value !== null) outcomeByDate.set(point.date, point.value);

  const pairs: Pair[] = [];
  for (const point of input.points) {
    if (point.value === null) continue;
    const outcomeValue = outcomeByDate.get(shiftDate(point.date, lag));
    if (outcomeValue === undefined) continue;
    pairs.push({ input: point.value, outcome: outcomeValue });
  }
  return pairs;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface TercileMagnitude {
  high: DriverBucket | null;
  low: DriverBucket | null;
  highInputMean: number | null;
  lowInputMean: number | null;
}

/**
 * Splits paired input values into terciles (by input value) and reports the
 * outcome mean in the top tercile vs the bottom tercile, with counts. Both
 * sides are null when either tercile has fewer than MIN_TERCILE_PAIRS pairs
 * — too few to describe honestly.
 */
export function terciles(pairs: Pair[]): TercileMagnitude {
  const none: TercileMagnitude = { high: null, low: null, highInputMean: null, lowInputMean: null };
  if (pairs.length === 0) return none;

  const sorted = [...pairs].sort((a, b) => a.input - b.input);
  const bucketSize = Math.floor(sorted.length / 3);
  if (bucketSize === 0) return none;

  const low = sorted.slice(0, bucketSize);
  const high = sorted.slice(sorted.length - bucketSize);
  if (low.length < MIN_TERCILE_PAIRS || high.length < MIN_TERCILE_PAIRS) return none;

  return {
    low: { mean: round1(mean(low.map((p) => p.outcome))), n: low.length },
    high: { mean: round1(mean(high.map((p) => p.outcome))), n: high.length },
    lowInputMean: round1(mean(low.map((p) => p.input))),
    highInputMean: round1(mean(high.map((p) => p.input))),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Typical day-to-day noise of a series: the median absolute change between
 * consecutive calendar days. A driver whose high-vs-low tercile gap is smaller
 * than this is indistinguishable from an ordinary day's wobble. Null when
 * there are too few consecutive-day pairs to say.
 */
export function typicalDailyNoise(outcome: MetricSeries): number | null {
  const byDate = new Map<string, number>();
  for (const point of outcome.points) if (point.value !== null) byDate.set(point.date, point.value);
  const diffs: number[] = [];
  for (const [date, value] of byDate) {
    const next = byDate.get(shiftDate(date, 1));
    if (next !== undefined) diffs.push(Math.abs(next - value));
  }
  if (diffs.length < MIN_NOISE_DIFFS) return null;
  return median(diffs);
}

/** True when the tercile gap is at least the outcome's typical daily noise. */
export function hasPracticalEffect(magnitude: TercileMagnitude, noise: number | null): boolean {
  if (!magnitude.high || !magnitude.low || noise === null) return false;
  return Math.abs(magnitude.high.mean - magnitude.low.mean) >= noise;
}

/**
 * True when this driver says "more activity -> a worse outcome" (e.g. more
 * steps -> lower HRV, or higher resting HR). That is a normal training
 * response, and as a headline it reads like "move less".
 */
export function isActivityWorsensOutcome(input: string, direction: 'up' | 'down', outcome: string): boolean {
  if (!ACTIVITY_INPUTS.has(input)) return false;
  return LOWER_IS_BETTER_OUTCOMES.has(outcome) ? direction === 'up' : direction === 'down';
}

/** DB-backed dependencies `computeDrivers` needs — real wiring lives below. */
export interface DriversRepository {
  latestComputedFor(userId: string): Promise<string | null>;
  findingsForDay(userId: string, day: string): Promise<StoredFinding[]>;
  loadSeries(userId: string, metrics: string[], endDay: string): Promise<MetricSeries[]>;
}

/**
 * Orchestrates the full read: staleness gate, confirmation + selection, then
 * the descriptive tercile magnitude per selected driver. Pure given its
 * `repository` — see drivers.test.ts for the DB-free unit tests, and the
 * `route.ts` sibling for the thin HTTP wrapper wiring the real repository.
 */
export async function computeDrivers(
  repository: DriversRepository,
  userId: string,
  metric: string,
  localToday: string,
  goal?: string | null,
): Promise<DriversResult> {
  if (!OUTCOME_METRICS.includes(metric)) {
    return { metric, computedFor: null, drivers: [] };
  }

  const computedFor = await repository.latestComputedFor(userId);
  if (!computedFor || isStale(computedFor, localToday)) {
    return { metric, computedFor: null, drivers: [] };
  }

  const previousDay = previousDayKey(computedFor);
  const [currentRows, previousRows] = await Promise.all([
    repository.findingsForDay(userId, computedFor),
    repository.findingsForDay(userId, previousDay),
  ]);
  const previousSignatures = new Set(previousRows.map((row) => row.signature));

  // Uncapped here: the practical-effect gate below can drop rows, and the cap
  // of 3 must apply to what survives, not to what was merely strongest.
  const picked = selectDrivers(currentRows, previousSignatures, metric, Infinity);
  if (picked.length === 0) return { metric, computedFor, drivers: [] };

  const inputMetrics = [...new Set(picked.map((p) => p.input))];
  const series = await repository.loadSeries(userId, [...inputMetrics, metric], localToday);
  const seriesByMetric = new Map(series.map((s) => [s.metric, s] as const));
  const outcomeSeries = seriesByMetric.get(metric) ?? { metric, points: [] };

  const noise = typicalDailyNoise(outcomeSeries);
  const performanceUser = PERFORMANCE_GOALS.has(goal ?? '');

  const candidates: Driver[] = [];
  for (const p of picked) {
    const inputSeries = seriesByMetric.get(p.input) ?? { metric: p.input, points: [] };
    const magnitude = terciles(pairByDateLag(inputSeries, outcomeSeries, p.lag));
    if (!hasPracticalEffect(magnitude, noise)) continue;
    const framing: DriverFraming =
      !performanceUser && isActivityWorsensOutcome(p.input, p.direction, metric) ? 'adaptation' : 'association';
    candidates.push({ ...p, framing, ...magnitude });
  }

  // Plain associations lead (already |rho|-sorted). An 'adaptation' row is
  // never a headline: it goes last and at most one is kept.
  const associations = candidates.filter((d) => d.framing === 'association');
  const adaptation = candidates.find((d) => d.framing === 'adaptation');
  const drivers = [...associations, ...(adaptation ? [adaptation] : [])].slice(0, MAX_DRIVERS);

  return { metric, computedFor, drivers };
}

// ─── Real repository (DB-backed) ───────────────────────────────────────────
// Dynamic imports of @/db, mirroring lib/insights/series.ts and
// lib/insights/confirmation.ts, so this module stays importable (and its
// pure functions above testable) without a database connection.

export async function latestComputedFor(userId: string): Promise<string | null> {
  const { db, schema } = await import('@/db');
  const { eq, desc } = await import('drizzle-orm');

  const [row] = await db
    .select({ computed_for: schema.insight_findings.computed_for })
    .from(schema.insight_findings)
    .where(eq(schema.insight_findings.user_id, userId))
    .orderBy(desc(schema.insight_findings.computed_for))
    .limit(1);
  return row?.computed_for ?? null;
}

export async function findingsForDay(userId: string, day: string): Promise<StoredFinding[]> {
  const { db, schema } = await import('@/db');
  const { and, eq } = await import('drizzle-orm');

  const rows = await db
    .select({
      signature: schema.insight_findings.signature,
      kind: schema.insight_findings.kind,
      computed_for: schema.insight_findings.computed_for,
      payload: schema.insight_findings.payload,
    })
    .from(schema.insight_findings)
    .where(and(
      eq(schema.insight_findings.user_id, userId),
      eq(schema.insight_findings.computed_for, day),
    ));
  return rows as StoredFinding[];
}
