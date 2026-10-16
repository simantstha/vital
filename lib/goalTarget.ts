/**
 * Vital — goal-target validation (pure, no DB or Next.js imports)
 *
 * Shared by POST /api/onboarding and PATCH /api/profile so both enforce the
 * same ranges for users.target_weight_kg / target_date / weekly_sessions_target
 * (roadmap v5 — goal progress).
 */

export const TARGET_WEIGHT_MIN_KG = 30;
export const TARGET_WEIGHT_MAX_KG = 300;
export const TARGET_DATE_MAX_YEARS = 3;
export const WEEKLY_SESSIONS_MIN = 1;
export const WEEKLY_SESSIONS_MAX = 14;
export const WEEKLY_DISTANCE_MIN_KM = 1;
export const WEEKLY_DISTANCE_MAX_KM = 300;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Target weight in kg: finite number within 30–300, rounded to 0.1 kg. */
export function parseTargetWeightKg(v: unknown): ParseResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < TARGET_WEIGHT_MIN_KG || v > TARGET_WEIGHT_MAX_KG) {
    return { ok: false, error: `targetWeightKg must be a number between ${TARGET_WEIGHT_MIN_KG} and ${TARGET_WEIGHT_MAX_KG}.` };
  }
  return { ok: true, value: Math.round(v * 10) / 10 };
}

/** Specific 400 message for a NEW target date that is today or earlier (PATCH /api/profile). */
export const TARGET_DATE_NOT_FUTURE_ERROR = 'Target date must be in the future';

/**
 * True when `v` is a real 'YYYY-MM-DD' calendar day that is `todayKey` or
 * earlier. Malformed / impossible dates are NOT "past" (parseTargetDate
 * rejects those with its generic message). Lets PATCH /api/profile give a
 * specific message for a new past date without changing parseTargetDate's
 * wording, which the coach tool (set_goal_target) also surfaces.
 */
export function isTargetDateNotInFuture(v: unknown, todayKey: string): boolean {
  if (typeof v !== 'string') return false;
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false;
  return v <= todayKey;
}

/**
 * Target date: a real 'YYYY-MM-DD' calendar day strictly after `todayKey`
 * (the user's local today) and at most TARGET_DATE_MAX_YEARS years out.
 */
export function parseTargetDate(v: unknown, todayKey: string): ParseResult<string> {
  const bad = (): ParseResult<string> => ({
    ok: false,
    error: `targetDate must be a YYYY-MM-DD date in the future, at most ${TARGET_DATE_MAX_YEARS} years out.`,
  });
  if (typeof v !== 'string') return bad();
  const m = DAY_RE.exec(v);
  if (!m) return bad();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return bad();
  if (v <= todayKey) return bad();

  const t = DAY_RE.exec(todayKey);
  if (!t) return bad();
  const limit = new Date(Date.UTC(Number(t[1]) + TARGET_DATE_MAX_YEARS, Number(t[2]) - 1, Number(t[3])))
    .toISOString().slice(0, 10);
  if (v > limit) return bad();
  return { ok: true, value: v };
}

/** Weekly training-session target: integer 1–14. */
export function parseWeeklySessionsTarget(v: unknown): ParseResult<number> {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < WEEKLY_SESSIONS_MIN || v > WEEKLY_SESSIONS_MAX) {
    return { ok: false, error: `weeklySessionsTarget must be an integer between ${WEEKLY_SESSIONS_MIN} and ${WEEKLY_SESSIONS_MAX}.` };
  }
  return { ok: true, value: v };
}

export const RACE_DATE_MAX_YEARS = 2;
export const RACE_DISTANCE_MIN_KM = 1;
export const RACE_DISTANCE_MAX_KM = 250;

/**
 * Race date (endurance goal): a real 'YYYY-MM-DD' day from `todayKey`
 * (inclusive — race day itself is valid) to RACE_DATE_MAX_YEARS years out.
 */
export function parseRaceDate(v: unknown, todayKey: string): ParseResult<string> {
  const bad = (): ParseResult<string> => ({
    ok: false,
    error: `raceDate must be a YYYY-MM-DD date from today to ${RACE_DATE_MAX_YEARS} years out.`,
  });
  if (typeof v !== 'string') return bad();
  const m = DAY_RE.exec(v);
  if (!m) return bad();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return bad();
  if (v < todayKey) return bad();

  const t = DAY_RE.exec(todayKey);
  if (!t) return bad();
  const limit = new Date(Date.UTC(Number(t[1]) + RACE_DATE_MAX_YEARS, Number(t[2]) - 1, Number(t[3])))
    .toISOString().slice(0, 10);
  if (v > limit) return bad();
  return { ok: true, value: v };
}

/** Race distance in km: finite number within 1–250 (covers the 5 / 10 / 21.1 / 42.2 presets), rounded to 0.1 km. */
export function parseRaceDistanceKm(v: unknown): ParseResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < RACE_DISTANCE_MIN_KM || v > RACE_DISTANCE_MAX_KM) {
    return { ok: false, error: `raceDistanceKm must be a number between ${RACE_DISTANCE_MIN_KM} and ${RACE_DISTANCE_MAX_KM}.` };
  }
  return { ok: true, value: Math.round(v * 10) / 10 };
}

/** Weekly endurance distance target in km: finite number within 1–300, rounded to 0.1 km. */
export function parseWeeklyDistanceKmTarget(v: unknown): ParseResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < WEEKLY_DISTANCE_MIN_KM || v > WEEKLY_DISTANCE_MAX_KM) {
    return { ok: false, error: `weeklyDistanceKmTarget must be a number between ${WEEKLY_DISTANCE_MIN_KM} and ${WEEKLY_DISTANCE_MAX_KM}.` };
  }
  return { ok: true, value: Math.round(v * 10) / 10 };
}
