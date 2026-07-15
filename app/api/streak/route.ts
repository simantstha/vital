import { NextResponse } from 'next/server';
import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { pickTimeZone } from '@/lib/localDay';
import { calculateStreakDays, collectQualifyingDays } from '@/lib/streak';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 401 });
  }

  try {
    const [user] = await db
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const requestTimeZone = new URL(request.url).searchParams.get('tz');
    const timeZone = pickTimeZone(requestTimeZone, user?.timezone);

    const [events, dailyMetrics, messages, planItems] = await Promise.all([
      db
        .select({ type: schema.events.type, timestamp: schema.events.timestamp })
        .from(schema.events)
        .where(and(
          eq(schema.events.user_id, userId),
          inArray(schema.events.type, ['meal_logged', 'workout_completed']),
        )),
      db
        .select({ date: schema.daily_metrics.date, metric: schema.daily_metrics.metric, value: schema.daily_metrics.value })
        .from(schema.daily_metrics)
        .where(and(
          eq(schema.daily_metrics.user_id, userId),
          eq(schema.daily_metrics.metric, 'workouts'),
          gt(schema.daily_metrics.value, 0),
        )),
      db
        .select({ role: schema.messages.role, timestamp: schema.messages.timestamp })
        .from(schema.messages)
        .where(and(eq(schema.messages.user_id, userId), eq(schema.messages.role, 'user'))),
      db
        .select({ localDay: schema.plan_items.local_day, status: schema.plan_items.status })
        .from(schema.plan_items)
        .where(and(eq(schema.plan_items.user_id, userId), eq(schema.plan_items.status, 'done'))),
    ]);

    const qualifyingDays = collectQualifyingDays({
      timeZone,
      events,
      dailyMetrics,
      messages,
      planItems,
    });

    return NextResponse.json({
      streakDays: calculateStreakDays(qualifyingDays, new Date(), timeZone),
    });
  } catch (error) {
    console.error('[/api/streak] failed:', error);
    return NextResponse.json({ error: 'Failed to calculate streak' }, { status: 500 });
  }
}
