/**
 * Vital — local-day helpers
 *
 * Buckets absolute instants (UTC-stored timestamps) into the *user's local
 * calendar day*. Comparing local day keys is DST-proof and needs no offset
 * arithmetic — it just asks "did this happen on the same local day as now?".
 *
 * Falls back to UTC whenever the timezone is missing or invalid, so behavior is
 * unchanged for users without a known timezone (no regression).
 */

/** True if `tz` is a valid IANA timezone identifier (e.g. "America/Chicago"). */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * YYYY-MM-DD for the local calendar day that contains `date` in `tz`.
 * DST-proof (delegates to Intl). UTC fallback when tz is invalid/missing.
 */
export function localDayKey(date: Date, tz: string | null | undefined): string {
  if (!isValidTimeZone(tz)) return date.toISOString().slice(0, 10); // UTC fallback
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Prefer a valid request-supplied tz (freshest — tracks travel), else the
 * stored one, else undefined (→ UTC fallback inside localDayKey).
 */
export function pickTimeZone(
  paramTz: string | null | undefined,
  storedTz: string | null | undefined,
): string | undefined {
  if (isValidTimeZone(paramTz)) return paramTz;
  if (isValidTimeZone(storedTz)) return storedTz;
  return undefined;
}

/**
 * The previous calendar day's YYYY-MM-DD key for an already-local `dayKey`.
 * Pure calendar arithmetic — never subtract 24h from a Date, that skips a
 * day across a spring-forward transition.
 */
export function previousDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * The hour (0-23) of `date` in `tz`. UTC fallback when tz is invalid/missing.
 */
export function localHour(date: Date, tz: string | null | undefined): number {
  if (!isValidTimeZone(tz)) return date.getUTCHours();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    // hourCycle: 'h23' (not hour12: false) — some ICU builds render midnight
    // as "24" under hour12: false, which would silently break callers.
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parts.find(part => part.type === 'hour')?.value;
  return Number(hour);
}
