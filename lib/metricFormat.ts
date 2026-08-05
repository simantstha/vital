/**
 * Vital — metric formatting primitives (pure, no runtime imports).
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
 *
 * Unit-aware primitives (formatDistance/formatPace/formatWeight/formatHeight)
 * take a `UnitSystem` and convert for display only — every value stored
 * anywhere in the schema stays canonically metric (see lib/units.ts). The
 * `UnitSystem` import below is type-only, so it erases at compile time and
 * this file still carries no runtime dependency.
 */

import type { UnitSystem } from './units';

/** Kilometres per mile, pounds per kilogram, centimetres per inch — display-only conversion factors. */
export const KM_PER_MILE = 1.609344;
export const LB_PER_KG = 2.2046226218;
export const CM_PER_INCH = 2.54;

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

/** `"8.4 km"` (metric) or `"5.2 mi"` (imperial) from a metre distance. `null` on non-finite input. */
export function formatDistance(distanceM: unknown, units: UnitSystem = 'metric'): string | null {
  if (!isFiniteNumber(distanceM)) return null;
  if (units === 'imperial') return `${(distanceM / 1000 / KM_PER_MILE).toFixed(1)} mi`;
  return `${(distanceM / 1000).toFixed(1)} km`;
}

/** `"/km"` or `"/mi"` — the pace unit suffix for the given system. */
export function paceSuffix(units: UnitSystem = 'metric'): string {
  return units === 'imperial' ? '/mi' : '/km';
}

/**
 * `"5′23″"` from minutes-per-km — converted to minutes-per-mile first when
 * `units` is imperial (does NOT append a unit suffix; pair with `paceSuffix`).
 * `null` on non-finite or negative input.
 */
export function formatPace(paceMinPerKm: unknown, units: UnitSystem = 'metric'): string | null {
  if (!isFiniteNumber(paceMinPerKm) || paceMinPerKm < 0) return null;
  const paceMin = units === 'imperial' ? paceMinPerKm * KM_PER_MILE : paceMinPerKm;
  const totalSeconds = Math.round(paceMin * 60);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}′${seconds < 10 ? '0' : ''}${seconds}″`;
}

/** `"72.8 kg"` (metric) or `"160 lb"` (imperial) from a kilogram weight. `null` on non-finite input. */
export function formatWeight(kg: unknown, units: UnitSystem = 'metric'): string | null {
  if (!isFiniteNumber(kg)) return null;
  if (units === 'imperial') return `${Math.round(kg * LB_PER_KG)} lb`;
  return `${kg.toFixed(1)} kg`;
}

/** `"179 cm"` (metric) or `` `5'11"` `` (imperial) from a centimetre height. `null` on non-finite input. */
export function formatHeight(cm: unknown, units: UnitSystem = 'metric'): string | null {
  if (!isFiniteNumber(cm)) return null;
  if (units === 'imperial') {
    const totalInches = Math.round(cm / CM_PER_INCH);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    return `${feet}'${inches}"`;
  }
  return `${Math.round(cm)} cm`;
}

/** @deprecated use `formatDistance(distanceM, units)` — kept as a metric-only alias for existing callers/tests. */
export function formatKilometres(distanceM: unknown): string | null {
  return formatDistance(distanceM, 'metric');
}

/** @deprecated use `formatPace(paceMinPerKm, units)` — kept as a metric-only alias for existing callers/tests. */
export function formatPaceMinPerKm(paceMinPerKm: unknown): string | null {
  return formatPace(paceMinPerKm, 'metric');
}
