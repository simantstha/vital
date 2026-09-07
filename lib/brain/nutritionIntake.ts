/**
 * Vital Brain — daily intake resolver
 *
 * Vital has two disjoint sources for "what did the user eat today": the
 * `meal_logged` events the coach/food-log UI writes, and the four
 * `dietary_*` HealthKit metrics ingested by app/api/ingest/daily/route.ts
 * (populated when a user logs food in a third-party app like MyFitnessPal
 * that writes back to Apple Health). Every consumer of "consumed calories"
 * (`/api/today`'s dietBudget, the coach prompt, the daily brief) used to read
 * only the first source, so a HealthKit-only user's consumedKcal was
 * permanently 0. This module is the single place that decides which source
 * wins for a given local day, so all three surfaces agree.
 *
 * Precedence (checked in order):
 *  1. `logged`   — one or more `meal_logged` events exist for that local day.
 *                  Presence of a log is the signal, not its sum: a user who
 *                  logs a 0-kcal placeholder meal is still "logged", not
 *                  "no data".
 *  2. `healthkit` — no meal_logged events, but `dietary_energy_kcal > 0` for
 *                  that day in daily_metrics.
 *  3. `none`      — neither.
 *
 * CRITICAL — the `> 0` guard on `dietary_energy_kcal`: a user who denies
 * Vital's HealthKit nutrition read produces the exact same absence of a
 * `dietary_energy_kcal` row as a user who simply hasn't logged food in any
 * app. HealthKit gives no signal to distinguish "denied" from "no data" —
 * there is no separate permission-state field to read. If we promoted a
 * present-but-zero row to `healthkit`, a denied user could be told they ate a
 * measured 0 kcal today, which is worse than saying nothing. Requiring
 * `dietary_energy_kcal > 0` means the only way to reach `source: 'healthkit'`
 * is a real, non-zero reading — denied and absent both safely fall through
 * to `none`.
 */

import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { db, schema } from '@/db';
import { localDayKey } from '../localDay';

export type IntakeSource = 'logged' | 'healthkit' | 'none';

export interface DailyIntake {
  date: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  source: IntakeSource;
  sourceName: string | null;
}

const DIETARY_METRICS = [
  'dietary_energy_kcal',
  'dietary_protein_g',
  'dietary_carbs_g',
  'dietary_fat_g',
] as const;

function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function emptyIntake(date: string): DailyIntake {
  return { date, kcal: 0, protein: 0, carbs: 0, fat: 0, source: 'none', sourceName: null };
}

/**
 * Resolves the effective daily intake (kcal + macros + which source won) for
 * each of `dayKeys` — a set of the user's *local* 'YYYY-MM-DD' day keys (see
 * lib/localDay.ts). Always returns one entry per requested key, even when
 * there's no data at all (`source: 'none'`, all-zero), so callers never have
 * to special-case a missing map entry.
 */
export async function resolveDailyIntake(
  userId: string,
  dayKeys: string[],
  tz: string,
): Promise<Map<string, DailyIntake>> {
  const result = new Map<string, DailyIntake>();
  if (dayKeys.length === 0) return result;

  const keySet = new Set(dayKeys);
  const sortedKeys = [...dayKeys].sort();
  const minKey = sortedKeys[0];
  const maxKey = sortedKeys[sortedKeys.length - 1];

  // Widen to a UTC superset covering every requested local day (a local day
  // starts at most ~14h from UTC midnight either direction — same pattern as
  // app/api/today/route.ts and assembleContext), then refine to the exact
  // local day below via localDayKey. Never do timezone offset arithmetic.
  const rangeStart = new Date(new Date(`${minKey}T00:00:00Z`).getTime() - 24 * 3_600_000);
  const rangeEnd = new Date(new Date(`${maxKey}T00:00:00Z`).getTime() + 48 * 3_600_000);

  const [mealEvents, dietaryRows] = await Promise.all([
    db
      .select({ timestamp: schema.events.timestamp, payload: schema.events.payload })
      .from(schema.events)
      .where(and(
        eq(schema.events.user_id, userId),
        eq(schema.events.type, 'meal_logged'),
        gte(schema.events.timestamp, rangeStart),
        lte(schema.events.timestamp, rangeEnd),
      ))
      .orderBy(desc(schema.events.timestamp)),
    db
      .select({
        date:    schema.daily_metrics.date,
        metric:  schema.daily_metrics.metric,
        value:   schema.daily_metrics.value,
        payload: schema.daily_metrics.payload,
      })
      .from(schema.daily_metrics)
      .where(and(
        eq(schema.daily_metrics.user_id, userId),
        inArray(schema.daily_metrics.metric, DIETARY_METRICS),
        inArray(schema.daily_metrics.date, dayKeys),
      )),
  ]);

  // ── 1. Sum meal_logged events per local day; track presence separately
  //       from the sum so a real 0-kcal log still counts as "logged".
  const loggedByDay = new Map<string, { kcal: number; protein: number; carbs: number; fat: number }>();
  for (const e of mealEvents) {
    const key = localDayKey(e.timestamp, tz);
    if (!keySet.has(key)) continue;
    const p = pl(e.payload);
    const bucket = loggedByDay.get(key) ?? { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    bucket.kcal    += Math.round(num(p.kcal) ?? num(p.calories) ?? 0);
    bucket.protein += Math.round(num(p.p)    ?? num(p.protein)  ?? 0);
    bucket.carbs   += Math.round(num(p.c)    ?? num(p.carbs)    ?? 0);
    bucket.fat     += Math.round(num(p.f)    ?? num(p.fat)      ?? 0);
    loggedByDay.set(key, bucket);
  }

  // ── 2. HealthKit dietary_* rows per day, macros independently nullable —
  //       an absent metric row defaults to 0 (e.g. MyFitnessPal syncs energy
  //       but not macros to Apple Health for some users).
  const healthkitByDay = new Map<string, { kcal: number; protein: number; carbs: number; fat: number; sourceName: string | null }>();
  for (const row of dietaryRows) {
    const bucket = healthkitByDay.get(row.date) ?? { kcal: 0, protein: 0, carbs: 0, fat: 0, sourceName: null };
    if (row.metric === 'dietary_energy_kcal') {
      bucket.kcal = row.value;
      const sources = pl(row.payload).sources;
      bucket.sourceName = Array.isArray(sources) && typeof sources[0] === 'string' ? sources[0] : null;
    } else if (row.metric === 'dietary_protein_g') {
      bucket.protein = row.value;
    } else if (row.metric === 'dietary_carbs_g') {
      bucket.carbs = row.value;
    } else if (row.metric === 'dietary_fat_g') {
      bucket.fat = row.value;
    }
    healthkitByDay.set(row.date, bucket);
  }

  // ── 3. Apply precedence per requested day ──────────────────────────────
  for (const date of dayKeys) {
    const logged = loggedByDay.get(date);
    if (logged) {
      result.set(date, { date, ...logged, source: 'logged', sourceName: null });
      continue;
    }

    const hk = healthkitByDay.get(date);
    // See module doc: the >0 guard is load-bearing, not a rounding nicety —
    // it's what stops a denied HealthKit read from being reported as a
    // measured zero.
    if (hk && hk.kcal > 0) {
      result.set(date, {
        date,
        kcal:    Math.round(hk.kcal),
        protein: Math.round(hk.protein),
        carbs:   Math.round(hk.carbs),
        fat:     Math.round(hk.fat),
        source:  'healthkit',
        sourceName: hk.sourceName,
      });
      continue;
    }

    result.set(date, emptyIntake(date));
  }

  return result;
}
