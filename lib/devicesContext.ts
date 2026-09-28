/**
 * Vital — pure logic for the Devices settings screen (phase 2 "both devices"
 * contract, PR A, "Preferences API"). No `@/db` import — the thin
 * repository/HTTP glue lives in lib/devicesRepository.ts / lib/devicesHttp.ts.
 */

export type DeviceValue = 'apple' | 'whoop';
export type DevicePreference = DeviceValue | null;

export interface DevicePreferences {
  workouts: DevicePreference;
  sleep: DevicePreference;
  recovery: DevicePreference;
}

export interface ResolvedPrimaryDevices {
  workouts: DeviceValue;
  sleep: DeviceValue;
  recovery: DeviceValue;
}

/**
 * The effective ("resolved") primary device per metric family, given the
 * user's explicit overrides and whether WHOOP is currently connected.
 *  - workouts: null means "current order" (lib/analysisSession.ts's
 *    priorityRank), which favors Apple Health absent a WHOOP preference.
 *  - sleep: null means "WHOOP owns the night when connected"
 *    (lib/sleepOwnership.ts) — falls back to Apple when WHOOP isn't
 *    connected, since there's no WHOOP data to own anything with.
 *  - recovery: null means the default lib/brain/recovery.ts selectHrvSource
 *    order — WHOOP wins when connected, otherwise Apple.
 * An explicit 'apple'/'whoop' override always wins outright, connected or not
 * — this mirrors how the underlying pure functions treat the preference (a
 * disconnected device with no data simply won't have anything to select, but
 * the *resolved* label the settings screen shows reflects the user's choice).
 */
export function resolvePrimaryDevices(
  explicit: DevicePreferences,
  whoopConnected: boolean,
): ResolvedPrimaryDevices {
  const fallback: DeviceValue = whoopConnected ? 'whoop' : 'apple';
  return {
    workouts: explicit.workouts ?? 'apple',
    sleep: explicit.sleep ?? fallback,
    recovery: explicit.recovery ?? fallback,
  };
}

const DEVICE_PREFERENCE_KEYS = ['workouts', 'sleep', 'recovery'] as const;
type DevicePreferenceKey = typeof DEVICE_PREFERENCE_KEYS[number];

function isValidDeviceValue(value: unknown): value is DevicePreference {
  return value === 'apple' || value === 'whoop' || value === null;
}

/**
 * Parses `PATCH /api/devices`'s body: `{ primary: { workouts?, sleep?,
 * recovery? } }`, each value `'apple'`, `'whoop'` or `null` (resets to
 * auto). Returns only the keys that were present (a partial update — an
 * absent key leaves that preference unchanged), or `null` when the body is
 * malformed or sets no valid key at all ("validate strictly").
 */
export function parseDevicePatch(body: unknown): Partial<Record<DevicePreferenceKey, DevicePreference>> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const primary = (body as Record<string, unknown>).primary;
  if (!primary || typeof primary !== 'object' || Array.isArray(primary)) return null;
  const p = primary as Record<string, unknown>;

  const result: Partial<Record<DevicePreferenceKey, DevicePreference>> = {};
  for (const key of DEVICE_PREFERENCE_KEYS) {
    if (!(key in p)) continue;
    const value = p[key];
    if (!isValidDeviceValue(value)) return null;
    result[key] = value;
  }
  if (Object.keys(result).length === 0) return null;
  return result;
}
