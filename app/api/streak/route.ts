import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db, schema } from '@/db';
import { getUserIdFromRequest } from '@/lib/auth';
import { pickTimeZone } from '@/lib/localDay';
import { calculateStreakDays } from '@/lib/streak';
import { fetchQualifyingStreakDays } from '@/lib/streakRepository';

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
    const timeZone = pickTimeZone(requestTimeZone, user?.timezone) ?? 'UTC';
    const qualifyingDays = await fetchQualifyingStreakDays(db, userId, timeZone);

    return NextResponse.json({
      streakDays: calculateStreakDays(qualifyingDays, new Date(), timeZone),
    });
  } catch (error) {
    console.error('[/api/streak] failed:', error);
    return NextResponse.json({ error: 'Failed to calculate streak' }, { status: 500 });
  }
}
