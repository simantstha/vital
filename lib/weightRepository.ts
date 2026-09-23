/**
 * Vital — weight-log repository (Postgres-backed)
 *
 * Storage decision: weigh-ins reuse the existing `events` ledger with the
 * `weight_logged` type that db/schema.ts's events comment already documents
 * (`// meal_logged, weight_logged, lab_result, ...`) — no schema change, no
 * migration. `events.source` carries which of manual / healthkit / coach the
 * reading came from; `events.payload` carries `{ value: <kg>, unit: 'kg',
 * localDay: 'YYYY-MM-DD' }`. This mirrors log_meal's write path exactly
 * (lib/brain/tools.ts) and means /api/logs, lib/brain/context.ts, and
 * lib/brain/brief.ts — which already read `weight_logged` events — pick up
 * real weigh-ins with zero changes.
 *
 * HealthKit body-mass readings do NOT go through this module. They already
 * land in `daily_metrics.body_mass_kg` via the existing ingest path
 * (app/api/ingest/daily/route.ts), one upserted row per (user, date) — see
 * that route and db/schema.ts's daily_metrics comment. getWeightReadings()
 * below merges both stores into one reading list for callers that need a
 * unified view (the weigh-in route's GET, the coach's get_weight_trend
 * tool).
 *
 * Dedup rule: a (user, source, exact measuredAt) match is treated as a
 * retry of the same reading and is skipped rather than duplicated —
 * `events` is an append-only ledger ("Nothing is ever updated or deleted
 * here", db/schema.ts) so dedup happens at insert time via an existence
 * check, never an UPDATE/DELETE. Two DIFFERENT sources (or two genuinely
 * distinct manual entries) logging on the same calendar day are NOT deduped
 * against each other at write time — both raw points are kept; read-time
 * merging (lib/weightTrend.ts) decides which one represents that day.
 *
 * One-time legacy import: importLegacyWeightLogIfPresent() reads the old
 * per-user weight-log.json (lib/weightLog.ts — disk-only, only ever present
 * on the app machine's volume, never the worker's) and idempotently inserts
 * its entries as `manual` events, reusing the same dedup rule above so
 * repeated calls are safe. It's called lazily from the weigh-in route on
 * every GET/POST (cheap: readWeightLog() is a single local fs read, a no-op
 * when the file doesn't exist) rather than from a SQL migration, which
 * cannot read a file that only exists on one machine's disk. The file
 * itself is left in place, per the L2 task's instruction — nothing deletes
 * it, so it stays a harmless read-only artifact.
 */

import { db, schema } from '@/db';
import { and, eq, gte } from 'drizzle-orm';
import { readWeightLog } from './weightLog';
import { localDayKey } from './localDay';
import { LB_PER_KG } from './metricFormat';
import type { WeightReading, WeightSource } from './weightTrend';

export type { WeightSource } from './weightTrend';

export interface LogWeightEntryInput {
  valueKg: number;
  measuredAt: Date;
  source: WeightSource;
  timezone?: string | null;
}

export interface LogWeightEntryResult {
  id: string;
  localDay: string;
  /** True when an identical (source, measuredAt) event already existed and this call was a no-op. */
  deduped: boolean;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Writes one weigh-in as a `weight_logged` event. Idempotent: retrying with
 * the same (userId, source, measuredAt) returns the existing row instead of
 * inserting a duplicate.
 */
export async function logWeightEntry(userId: string, input: LogWeightEntryInput): Promise<LogWeightEntryResult> {
  const { valueKg, measuredAt, source, timezone } = input;
  const localDay = localDayKey(measuredAt, timezone);

  const existing = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(and(
      eq(schema.events.user_id, userId),
      eq(schema.events.type, 'weight_logged'),
      eq(schema.events.source, source),
      eq(schema.events.timestamp, measuredAt),
    ))
    .limit(1);

  if (existing.length > 0) {
    return { id: existing[0].id, localDay, deduped: true };
  }

  const [inserted] = await db
    .insert(schema.events)
    .values({
      user_id: userId,
      timestamp: measuredAt,
      type: 'weight_logged',
      payload: { value: round1(valueKg), unit: 'kg', localDay },
      source,
    })
    .returning({ id: schema.events.id });

  return { id: inserted.id, localDay, deduped: false };
}

interface WeightLoggedEventRow {
  id: string;
  measuredAt: Date;
  valueKg: number;
  source: WeightSource;
  localDay: string;
}

/** Raw manual/coach `weight_logged` events over the trailing window, newest concerns handled by the caller. */
export async function queryManualWeightEvents(userId: string, days: number): Promise<WeightLoggedEventRow[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  const rows = await db
    .select({
      id:        schema.events.id,
      timestamp: schema.events.timestamp,
      payload:   schema.events.payload,
      source:    schema.events.source,
    })
    .from(schema.events)
    .where(and(
      eq(schema.events.user_id, userId),
      eq(schema.events.type, 'weight_logged'),
      gte(schema.events.timestamp, since),
    ));

  return rows.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    let valueKg = typeof p.value === 'number' ? p.value : (typeof p.weight === 'number' ? p.weight : 0);
    const unit = typeof p.unit === 'string' ? p.unit : 'kg';
    if (unit === 'lbs' || unit === 'lb') valueKg = valueKg / LB_PER_KG;
    const localDay = typeof p.localDay === 'string' ? p.localDay : r.timestamp.toISOString().slice(0, 10);
    const source: WeightSource = r.source === 'healthkit' || r.source === 'coach' ? r.source : 'manual';
    return { id: r.id, measuredAt: r.timestamp, valueKg, source, localDay };
  });
}

/**
 * Manual-weight overlay for /api/trends: date (YYYY-MM-DD) → kg, the latest
 * manual/coach entry per day winning when there's more than one — same
 * "manual wins" semantics the old readWeightLog()-backed overlay had.
 */
export async function queryManualWeightOverlay(userId: string, days: number): Promise<Map<string, number>> {
  const events = await queryManualWeightEvents(userId, days);
  events.sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  const overlay = new Map<string, number>();
  for (const e of events) overlay.set(e.localDay, e.valueKg); // later entry overwrites earlier for the same day
  return overlay;
}

/** Minimal local body_mass_kg query (date, value) — inlined rather than importing lib/brain/tools.ts's queryMetricPoints to avoid a circular import (tools.ts imports this module for log_weight/get_weight_trend). */
async function queryHealthKitBodyMass(userId: string, days: number): Promise<Array<{ date: string; value: number }>> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  const rows = await db
    .select({ date: schema.daily_metrics.date, value: schema.daily_metrics.value })
    .from(schema.daily_metrics)
    .where(and(
      eq(schema.daily_metrics.user_id, userId),
      eq(schema.daily_metrics.metric, 'body_mass_kg'),
      gte(schema.daily_metrics.date, sinceStr),
    ));

  return rows;
}

/**
 * Unified reading list for the trailing `days` window: manual/coach
 * `weight_logged` events plus HealthKit `daily_metrics.body_mass_kg` rows,
 * ready to hand to lib/weightTrend.ts's computeWeightTrend(). HealthKit rows
 * carry no time-of-day (daily_metrics is day-granular), so they're anchored
 * to local noon on their day — a neutral placeholder; see weightTrend.ts's
 * header for how same-day collisions between sources are actually resolved
 * (manual always wins over HealthKit, not by this synthetic time).
 */
export async function getWeightReadings(
  userId: string,
  days: number,
  timezone: string | null | undefined,
): Promise<WeightReading[]> {
  const [manual, healthkit] = await Promise.all([
    queryManualWeightEvents(userId, days),
    queryHealthKitBodyMass(userId, days),
  ]);

  const readings: WeightReading[] = manual.map((m) => ({
    measuredAt: m.measuredAt.toISOString(),
    valueKg:    m.valueKg,
    source:     m.source,
    localDay:   m.localDay,
  }));

  for (const h of healthkit) {
    readings.push({
      measuredAt: `${h.date}T12:00:00.000Z`,
      valueKg:    h.value,
      source:     'healthkit',
      localDay:   h.date,
    });
  }

  void timezone; // healthkit rows are already day-keyed by ingest; manual rows carry their own localDay from write time.
  return readings;
}

/**
 * Same merged reading list as getWeightReadings(), but only runs the
 * one-time legacy-import side effect when Postgres has NO readings yet.
 * importLegacyWeightLogIfPresent() awaits a serial logWeightEntry() call per
 * legacy entry with no "already imported" short-circuit, so calling it
 * unconditionally on every read (as GET /api/weight-log intentionally still
 * does — low-traffic, user-initiated) is fine there but was a latency
 * regression when lib/brain/context.ts and lib/brain/brief.ts started
 * calling the same unconditional pattern on every coach turn / brief
 * generation: a user with a large legacy log paid that serial-write cost
 * before every reply. Once Postgres has ANY reading (including a prior
 * import's result), this never touches the legacy file again.
 */
export async function getWeightReadingsWithLazyImport(
  userId: string,
  days: number,
  timezone: string | null | undefined,
): Promise<WeightReading[]> {
  const readings = await getWeightReadings(userId, days, timezone);
  if (readings.length > 0) return readings;

  await importLegacyWeightLogIfPresent(userId, timezone);
  return getWeightReadings(userId, days, timezone);
}

/**
 * One-time lazy import of the legacy per-user weight-log.json (if present)
 * into Postgres as `manual` events. Idempotent via logWeightEntry()'s dedup
 * rule — safe to call on every request. No-op when the file doesn't exist
 * (readWeightLog() returns []).
 */
export async function importLegacyWeightLogIfPresent(
  userId: string,
  timezone: string | null | undefined,
): Promise<void> {
  const entries = readWeightLog(userId);
  for (const e of entries) {
    const valueKg = e.unit === 'lbs' ? e.weight / LB_PER_KG : e.weight;
    // The legacy file only stored a date, not a time-of-day — anchor to
    // local noon so it lands on the right calendar day for any timezone.
    const measuredAt = new Date(`${e.date}T12:00:00.000Z`);
    await logWeightEntry(userId, { valueKg, measuredAt, source: 'manual', timezone });
  }
}
