/**
 * Time-in-zones for a workout, from either device (phase 2 "both devices"
 * contract, PR A, "Zones"). Pure, DB-free.
 *
 * WHOOP reports its own zone durations directly (lib/whoop/analysisPayloads.ts
 * maps them into `zonesSec`/`zoneBasis: 'maxHr'`). The Apple Watch instead
 * sends a raw heart-rate series (`hrSeries`, from the iOS ingest PR), and
 * zones are computed here at request time from heart-rate RESERVE (Karvonen):
 * %HRR = (hr - restingHr) / (maxHr - restingHr), bucketed into 5 bands —
 * <60%, 60–70%, 70–80%, 80–90%, >=90% — `zoneBasis: 'reserve'`.
 */

export const ZONE_COUNT = 5;

/** Upper bound (exclusive, except the last) of each of the 5 %HRR bands, as a fraction. */
const ZONE_UPPER_BOUNDS = [0.60, 0.70, 0.80, 0.90] as const;

function bucketForReserve(reservePct: number): number {
  for (let i = 0; i < ZONE_UPPER_BOUNDS.length; i++) {
    if (reservePct < ZONE_UPPER_BOUNDS[i]) return i;
  }
  return ZONE_UPPER_BOUNDS.length; // >= 90%
}

/**
 * Buckets an evenly-spaced heart-rate series into 5 zones of seconds by
 * heart-rate reserve. `series` is assumed to span `durationSec` evenly (the
 * iOS-side resampling contract — at most 120 points). Returns `undefined`
 * when there's nothing to compute from: an empty series, a non-positive
 * duration, or `maxHr <= restingHr` (same "needs effort" guard as
 * lib/analysisContext.ts's computeEffort — with no effort, there are no
 * zones).
 */
export function zonesFromHrSeries(
  series: number[],
  durationSec: number,
  restingHr: number,
  maxHr: number,
): number[] | undefined {
  if (series.length === 0 || !(durationSec > 0) || !(maxHr > restingHr)) return undefined;

  const secondsPerSample = durationSec / series.length;
  const buckets = new Array(ZONE_COUNT).fill(0);

  for (const hr of series) {
    if (typeof hr !== 'number' || !Number.isFinite(hr)) continue;
    const reservePct = Math.min(1, Math.max(0, (hr - restingHr) / (maxHr - restingHr)));
    buckets[bucketForReserve(reservePct)] += secondsPerSample;
  }

  return buckets.map((seconds) => Math.round(seconds));
}
