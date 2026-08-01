/**
 * Vital — metric formatting primitives (pure, no imports).
 *
 * Rounds/unit-labels raw numeric values before they reach a prompt or a UI
 * label. Every primitive returns `null` on non-finite input — callers drop
 * the field rather than emitting a JSON `null` (see lib/proactiveAnalysisFormatting.ts).
 *
 * Conventions follow lib/logItems.ts (`"Xh 0Ym"`, space before the unit) and
 * lib/brain/context.ts. Deliberately NOT shared with the three existing
 * private duration formatters in lib/brain/ and lib/logItems.ts — they are
 * not actually identical (lib/brain/whoopContext.ts's `minutesToHm` emits
 * `"6h50m"` with no space; lib/logItems.ts's `formatHoursMinutes` emits
 * `"6h 50m"`), and converging them would re-cut coach-prompt and timeline
 * test baselines inside a notification-critical fix. See that divergence
 * noted as a follow-up, not fixed here.
 */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Rounds to the nearest integer; `null` on non-finite input. */
export function roundInteger(value: unknown): number | null {
  return isFiniteNumber(value) ? Math.round(value) : null;
}

/** Rounds to `decimals` places; `null` on non-finite input. */
export function roundTo(value: unknown, decimals: number): number | null {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `"48 min"` under an hour, else `"6h 50m"`. `null` on non-finite input. */
export function formatMinutes(value: unknown): string | null {
  if (!isFiniteNumber(value)) return null;
  const totalMinutes = Math.round(value);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes < 10 ? '0' : ''}${minutes}m`;
}

/** `"8.4 km"` from a metre distance. `null` on non-finite input. */
export function formatKilometres(distanceM: unknown): string | null {
  if (!isFiniteNumber(distanceM)) return null;
  return `${(distanceM / 1000).toFixed(1)} km`;
}

/** `"5′23″"` from minutes-per-km. `null` on non-finite or negative input. */
export function formatPaceMinPerKm(paceMinPerKm: unknown): string | null {
  if (!isFiniteNumber(paceMinPerKm) || paceMinPerKm < 0) return null;
  const totalSeconds = Math.round(paceMinPerKm * 60);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}′${seconds < 10 ? '0' : ''}${seconds}″`;
}
