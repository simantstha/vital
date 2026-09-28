/**
 * Drizzle-backed DevicesRepository (lib/devicesHttp.ts) for GET/PATCH
 * /api/devices (phase 2 "both devices" contract, PR A). Thin by design — all
 * the actual device-resolution logic lives in lib/devicesContext.ts.
 */

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import type { DevicesRepository, DevicesState } from './devicesHttp';
import type { DevicePreference, DevicePreferences } from './devicesContext';

const APPLE_CONNECTED_WINDOW_DAYS = 14;

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function asDevicePreference(value: unknown): DevicePreference {
  return value === 'apple' || value === 'whoop' ? value : null;
}

export const devicesRepository: DevicesRepository = {
  async getDevicesState(userId: string): Promise<DevicesState> {
    const [userRows, appleRows, whoopRows, mergedRows] = await Promise.all([
      db.select({
        workouts: schema.users.primary_workout_device,
        sleep: schema.users.primary_sleep_device,
        recovery: schema.users.primary_recovery_device,
      }).from(schema.users).where(eq(schema.users.id, userId)).limit(1),
      // "apple connected" = HealthKit data was ingested in the last 14 days.
      // Also doubles as the most recent ingest timestamp for `lastSyncAt`.
      db.select({ date: schema.daily_metrics.date, updatedAt: schema.daily_metrics.updated_at })
        .from(schema.daily_metrics)
        .where(and(
          eq(schema.daily_metrics.user_id, userId),
          eq(schema.daily_metrics.source, 'healthkit'),
          gte(schema.daily_metrics.date, isoDateDaysAgo(APPLE_CONNECTED_WINDOW_DAYS)),
        ))
        .orderBy(desc(schema.daily_metrics.updated_at))
        .limit(1),
      db.select({
        status: schema.whoop_connections.status,
        lastSyncedAt: schema.whoop_connections.last_synced_at,
      }).from(schema.whoop_connections).where(eq(schema.whoop_connections.user_id, userId)).limit(1),
      // Same-session workouts suppressed (merged) this calendar month (UTC).
      db.select({ count: sql<number>`count(*)` })
        .from(schema.workout_analyses)
        .where(and(
          eq(schema.workout_analyses.user_id, userId),
          isNotNull(schema.workout_analyses.merged_into_id),
          gte(schema.workout_analyses.deleted_at, sql`date_trunc('month', now())`),
        )),
    ]);

    const explicit: DevicePreferences = {
      workouts: asDevicePreference(userRows[0]?.workouts),
      sleep: asDevicePreference(userRows[0]?.sleep),
      recovery: asDevicePreference(userRows[0]?.recovery),
    };

    return {
      apple: { connected: appleRows.length > 0, lastSyncAt: appleRows[0]?.updatedAt ?? null },
      whoop: { connected: whoopRows[0]?.status === 'active', lastSyncAt: whoopRows[0]?.lastSyncedAt ?? null },
      explicit,
      mergedThisMonth: Number(mergedRows[0]?.count ?? 0),
    };
  },

  async updateDevicePreferences(userId: string, update: Partial<DevicePreferences>): Promise<DevicePreferences> {
    const set: Record<string, DevicePreference> = {};
    if ('workouts' in update) set.primary_workout_device = update.workouts ?? null;
    if ('sleep' in update) set.primary_sleep_device = update.sleep ?? null;
    if ('recovery' in update) set.primary_recovery_device = update.recovery ?? null;

    const [row] = await db.update(schema.users).set(set).where(eq(schema.users.id, userId)).returning({
      workouts: schema.users.primary_workout_device,
      sleep: schema.users.primary_sleep_device,
      recovery: schema.users.primary_recovery_device,
    });

    return {
      workouts: asDevicePreference(row?.workouts),
      sleep: asDevicePreference(row?.sleep),
      recovery: asDevicePreference(row?.recovery),
    };
  },
};
