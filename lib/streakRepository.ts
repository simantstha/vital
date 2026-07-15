import { sql, type SQL } from 'drizzle-orm';

import * as schema from '@/db/schema';

export function buildQualifyingStreakDaysQuery(userId: string, timeZone: string): SQL<{ day: string }> {
  const mealEvent = 'meal_logged';
  const workoutEvent = 'workout_completed';
  const workoutMetric = 'workouts';
  const userRole = 'user';
  const doneStatus = 'done';
  return sql<{ day: string }>`select distinct day from (
    select to_char(${schema.events.timestamp} at time zone ${timeZone}, 'YYYY-MM-DD') as day
    from ${schema.events}
    where ${schema.events.user_id} = ${userId}
      and ${schema.events.type} in (${mealEvent}, ${workoutEvent})

    union

    select ${schema.daily_metrics.date}::text as day
    from ${schema.daily_metrics}
    where ${schema.daily_metrics.user_id} = ${userId}
      and ${schema.daily_metrics.metric} = ${workoutMetric}
      and ${schema.daily_metrics.value} > 0

    union

    select to_char(${schema.messages.timestamp} at time zone ${timeZone}, 'YYYY-MM-DD') as day
    from ${schema.messages}
    where ${schema.messages.user_id} = ${userId}
      and ${schema.messages.role} = ${userRole}

    union

    select ${schema.plan_items.local_day} as day
    from ${schema.plan_items}
    where ${schema.plan_items.user_id} = ${userId}
      and ${schema.plan_items.status} = ${doneStatus}
  ) qualifying_days`;
}

type StreakQueryExecutor = {
  execute: (query: SQL<{ day: string }>) => Promise<Iterable<{ day: string }>>;
};

export async function fetchQualifyingStreakDays(
  executor: StreakQueryExecutor,
  userId: string,
  timeZone: string,
): Promise<Set<string>> {
  const rows = await executor.execute(buildQualifyingStreakDaysQuery(userId, timeZone));
  return new Set(Array.from(rows, row => row.day));
}
