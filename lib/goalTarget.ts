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

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Target weight in kg: finite number within 30–300, rounded to 0.1 kg. */
export function parseTargetWeightKg(v: unknown): ParseResult<number> {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < TARGET_WEIGHT_MIN_KG || v > TARGET_WEIGHT_MAX_KG) {
    return { ok: false, error: `targetWeightKg must be a number between ${TARGET_WEIGHT_MIN_KG} and ${TARGET_WEIGHT_MAX_KG}.` };
  }
  return { ok: true, value: Math.round(v * 10) / 10 };
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
