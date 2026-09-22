/**
 * Vital — weight trend (pure, no DB or Next.js imports)
 *
 * Smooths raw weigh-ins into an exponentially-weighted moving average, the
 * MacroFactor / Happy Scale style ("your true trend, not today's water
 * weight" — see docs/ux-spec-v4.md §5.3 and the MacroFactor weight-trend
 * article linked from the roadmap). Pure function so it's cheap to unit test
 * exhaustively (gaps, single point, unsorted input, duplicate days,
 * cross-source collisions) with no DATABASE_URL.
 *
 * Algorithm:
 *  1. One reading per calendar day. When more than one reading lands on the
 *     same `localDay` (manual + HealthKit both fired, or two manual entries
 *     e.g. a coach correction), a manual/coach reading always wins over a
 *     HealthKit one — HealthKit's `daily_metrics.body_mass_kg` is already
 *     collapsed to a single day-level value with no time-of-day at ingest
 *     (see app/api/ingest/daily/route.ts), so it carries no real morning/
 *     evening signal to prefer; an explicit user action does. When the
 *     collision is same-source (two manual logs on one day), the earliest
 *     `measuredAt` wins — the "log your weight first thing" rule this
 *     mirrors (MacroFactor/Happy Scale: the first reading of the day is the
 *     most consistent one, before food/water/activity move the scale).
 *  2. EWMA over the deduped daily series: `trend[i] = trend[i-1] + α · (raw[i]
 *     - trend[i-1])`, α ≈ 0.1/day by default. A gap of `g` missing calendar
 *     days between two consecutive readings compounds α across the gap
 *     (`1 - (1-α)^g`) rather than treating the gap as zero days — otherwise
 *     a reading after a 2-week gap would swing the trend as hard as one
 *     after a single day, which is wrong: the trend should have long since
 *     forgotten the stale weeks-old anchor.
 *  3. 7-day / 30-day rate of change: (latest trend − trend at the closest
 *     available day ≥ that many days back) / elapsed days × 7, so it always
 *     reads as kg/week even when the lookback window is partially filled by
 *     sparse data. Requires at least 2 distinct days of data; otherwise null
 *     (nothing to compute a rate from).
 */

export type WeightSource = 'manual' | 'healthkit' | 'coach';

export interface WeightReading {
  /** ISO 8601 instant the reading was taken (or a synthetic anchor for day-only sources). */
  measuredAt: string;
  /** Always kg — callers convert lb→kg before calling in (unit-agnostic here). */
  valueKg: number;
  source: WeightSource;
  /** YYYY-MM-DD local calendar day this reading belongs to. */
  localDay: string;
}

export interface WeightTrendDay {
  day: string;
  rawKg: number;
  trendKg: number;
}

export interface WeightTrendResult {
  days: WeightTrendDay[];
  /** kg/week over the trailing 7 days of trend, or null with < 2 days of data. */
  delta7dKgPerWeek: number | null;
  /** kg/week over the trailing 30 days of trend, or null with < 2 days of data. */
  delta30dKgPerWeek: number | null;
  /** True once there are >= 3 distinct weigh-in days spanning >= 5 calendar days — the
   *  UI gate documented in docs/ux-spec-v4.md §4 ("Trend appears after 3 weigh-ins · 1 of 3"). */
  established: boolean;
}

const DEFAULT_ALPHA = 0.1;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Epoch day number for a YYYY-MM-DD string — pure calendar arithmetic, no timezone. */
function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Picks the one reading that represents `day`, per the collision rule in the file header. */
function pickDailyReading(existing: WeightReading, candidate: WeightReading): WeightReading {
  const existingManual = existing.source !== 'healthkit';
  const candidateManual = candidate.source !== 'healthkit';
  if (candidateManual && !existingManual) return candidate;
  if (existingManual && !candidateManual) return existing;
  // Same "manual-ness" — earliest measuredAt wins.
  return candidate.measuredAt < existing.measuredAt ? candidate : existing;
}

/** Rate of change in kg/week from the closest trend point >= `windowDays` back, or null. */
function weeklyDelta(days: WeightTrendDay[], dayNumbers: number[], windowDays: number): number | null {
  if (days.length < 2) return null;
  const lastIdx = days.length - 1;
  const targetDayNumber = dayNumbers[lastIdx] - windowDays;

  // Latest index (before the last) whose day is <= target (closest from
  // below); falls back to the earliest available point when the whole
  // history is shorter than the window (partial-window rate, still
  // meaningful).
  let baselineIdx = 0;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (dayNumbers[i] <= targetDayNumber) { baselineIdx = i; break; }
  }

  const elapsedDays = dayNumbers[lastIdx] - dayNumbers[baselineIdx];
  if (elapsedDays <= 0) return null;

  const delta = days[lastIdx].trendKg - days[baselineIdx].trendKg;
  return round2((delta / elapsedDays) * 7);
}

/**
 * Computes the smoothed weight trend from a set of raw readings. Unsorted
 * input is fine — readings are sorted internally by localDay.
 */
export function computeWeightTrend(
  readings: WeightReading[],
  opts: { alpha?: number } = {},
): WeightTrendResult {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;

  // 1. Collapse to one reading per local day.
  const byDay = new Map<string, WeightReading>();
  for (const r of readings) {
    const existing = byDay.get(r.localDay);
    byDay.set(r.localDay, existing ? pickDailyReading(existing, r) : r);
  }

  const sortedDays = [...byDay.keys()].sort();
  if (sortedDays.length === 0) {
    return { days: [], delta7dKgPerWeek: null, delta30dKgPerWeek: null, established: false };
  }

  // 2. EWMA across calendar days, compounding alpha over gaps.
  const days: WeightTrendDay[] = [];
  const dayNumbers: number[] = [];
  let trend: number | null = null;
  let prevDayNumber: number | null = null;

  for (const day of sortedDays) {
    const raw = byDay.get(day)!.valueKg;
    const dn = dayNumber(day);

    if (trend == null) {
      trend = raw;
    } else {
      const gapDays = Math.max(1, dn - (prevDayNumber ?? dn));
      const effectiveAlpha = 1 - Math.pow(1 - alpha, gapDays);
      trend = trend + effectiveAlpha * (raw - trend);
    }

    prevDayNumber = dn;
    dayNumbers.push(dn);
    days.push({ day, rawKg: round2(raw), trendKg: round2(trend) });
  }

  const firstDayNumber = dayNumbers[0];
  const lastDayNumber = dayNumbers[dayNumbers.length - 1];
  const established = sortedDays.length >= 3 && (lastDayNumber - firstDayNumber) >= 5;

  return {
    days,
    delta7dKgPerWeek: weeklyDelta(days, dayNumbers, 7),
    delta30dKgPerWeek: weeklyDelta(days, dayNumbers, 30),
    established,
  };
}
