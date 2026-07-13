import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import type {
  AnalysisKind,
  AnalysisRecord,
  NotificationPreferences,
  ProactiveHealthRepository,
  PushDeviceRegistration,
} from './proactiveHealthHttp';
import {
  registerPushDevice,
  type PushDeviceRow,
} from './pushDeviceReconciliation';
import { shouldPersistDefaultPreferences } from './proactiveHealthTransitions';

function preferencesDto(row: typeof schema.notification_preferences.$inferSelect): NotificationPreferences {
  return {
    morningBriefEnabled: row.morning_brief_enabled,
    morningBriefTimeMinutes: row.morning_brief_time_minutes,
    workoutNotificationsEnabled: row.workout_notifications_enabled,
    sleepNotificationsEnabled: row.sleep_notifications_enabled,
    timezone: row.timezone,
  };
}

export const proactiveHealthRepository: ProactiveHealthRepository = {
  async registerPushDevice(userId: string, device: PushDeviceRegistration) {
    return registerPushDevice({
      withRegistrationTransaction(operation) {
        return db.transaction(async (tx) => {
          // A single transaction-level lock provides one ordering for every
          // installation/token move, including opposing A/X <-> B/Y swaps.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('push-device-registration', 0))`);
          const selectRow = {
            id: schema.push_devices.id,
            userId: schema.push_devices.user_id,
            installationId: schema.push_devices.installation_id,
            token: schema.push_devices.device_token,
            environment: schema.push_devices.environment,
            invalidatedAt: schema.push_devices.invalidated_at,
            updatedAt: schema.push_devices.updated_at,
          };
          const result = await operation({
            async findByInstallationId(installationId) {
              const [row] = await tx.select(selectRow).from(schema.push_devices)
                .where(eq(schema.push_devices.installation_id, installationId)).limit(1).for('update');
              return row ?? null;
            },
            async findByToken(token, environment) {
              const [row] = await tx.select(selectRow).from(schema.push_devices).where(and(
                eq(schema.push_devices.device_token, token),
                eq(schema.push_devices.environment, environment),
              )).limit(1).for('update');
              return row ?? null;
            },
            async retire(row: PushDeviceRow, retiredToken, now) {
              await tx.update(schema.push_devices).set({
                device_token: retiredToken, invalidated_at: now, updated_at: now,
              }).where(eq(schema.push_devices.id, row.id));
            },
            async update(row: PushDeviceRow, token, environment, now) {
              await tx.update(schema.push_devices).set({
                device_token: token, environment, invalidated_at: null, updated_at: now,
              }).where(and(
                eq(schema.push_devices.id, row.id),
                eq(schema.push_devices.user_id, userId),
              ));
            },
            async insert(ownerId, installationId, token, environment) {
              await tx.insert(schema.push_devices).values({
                user_id: ownerId, installation_id: installationId,
                device_token: token, environment,
              });
            },
          });
          if (shouldPersistDefaultPreferences(String(result))) await tx.insert(schema.notification_preferences).values({ user_id: userId }).onConflictDoNothing();
          return result;
        });
      },
    }, userId, device, new Date());
  },

  async invalidatePushDevice(userId: string, installationId: string): Promise<boolean> {
    const rows = await db.update(schema.push_devices)
      .set({ invalidated_at: new Date(), updated_at: new Date() })
      .where(and(
        eq(schema.push_devices.user_id, userId),
        eq(schema.push_devices.installation_id, installationId),
        isNull(schema.push_devices.invalidated_at),
      ))
      .returning({ id: schema.push_devices.id });
    return rows.length > 0;
  },

  async getNotificationPreferences(userId: string): Promise<NotificationPreferences | null> {
    const [row] = await db.insert(schema.notification_preferences).values({ user_id: userId }).onConflictDoUpdate({ target: schema.notification_preferences.user_id, set: { user_id: userId } }).returning();
    return preferencesDto(row);
  },

  async putNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const values = {
      user_id: userId,
      morning_brief_enabled: preferences.morningBriefEnabled,
      morning_brief_time_minutes: preferences.morningBriefTimeMinutes,
      workout_notifications_enabled: preferences.workoutNotificationsEnabled,
      sleep_notifications_enabled: preferences.sleepNotificationsEnabled,
      timezone: preferences.timezone,
      updated_at: new Date(),
    };
    const [row] = await db.insert(schema.notification_preferences).values(values).onConflictDoUpdate({
      target: schema.notification_preferences.user_id,
      set: values,
    }).returning();
    return preferencesDto(row);
  },

  async getAnalysis(kind: AnalysisKind, userId: string, id: string): Promise<AnalysisRecord | null> {
    if (kind === 'workout') {
      const [row] = await db.select({
        id: schema.workout_analyses.id,
        userId: schema.workout_analyses.user_id,
        status: schema.workout_analyses.status,
        deletedAt: schema.workout_analyses.deleted_at,
        date: schema.workout_analyses.workout_date,
        result: schema.workout_analyses.result,
        createdAt: schema.workout_analyses.created_at,
      }).from(schema.workout_analyses).where(and(
        eq(schema.workout_analyses.id, id),
        eq(schema.workout_analyses.user_id, userId),
        eq(schema.workout_analyses.status, 'ready'),
        isNull(schema.workout_analyses.deleted_at),
      )).limit(1);
      return row ?? null;
    }
    const [row] = await db.select({
      id: schema.sleep_analyses.id,
      userId: schema.sleep_analyses.user_id,
      status: schema.sleep_analyses.status,
      date: schema.sleep_analyses.wake_date,
      result: schema.sleep_analyses.result,
      createdAt: schema.sleep_analyses.created_at,
    }).from(schema.sleep_analyses).where(and(
      eq(schema.sleep_analyses.id, id),
      eq(schema.sleep_analyses.user_id, userId),
      eq(schema.sleep_analyses.status, 'ready'),
    )).limit(1);
    return row ? { ...row, deletedAt: null } : null;
  },
};
