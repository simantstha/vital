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
