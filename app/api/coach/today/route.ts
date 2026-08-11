import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';
import { createOrLoadDailyRecommendation, hydrateCoachWorkspaceState } from '@/lib/coachWorkspaceRepository';
import {
  COACH_WORKSPACE_DISABLED_RESPONSE,
  COACH_WORKSPACE_DISABLED_STATUS,
  isCoachWorkspaceEnabled,
} from '@/lib/coachWorkspaceFeature';
import { localDayKey, pickTimeZone } from '@/lib/localDay';

export const dynamic = 'force-dynamic';

function serialize(row: typeof schema.daily_coach_recommendations.$inferSelect) {
  return {
    id: row.id,
    localDay: row.local_day,
    category: row.category,
    action: row.action,
    evidence: row.evidence,
    materialSignature: row.material_signature,
  };
}

/** Authenticated deterministic daily Coach Workspace recommendation. */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isCoachWorkspaceEnabled()) {
    return NextResponse.json(COACH_WORKSPACE_DISABLED_RESPONSE, { status: COACH_WORKSPACE_DISABLED_STATUS });
  }

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  try {
    const [user] = await db.select({ timezone: schema.users.timezone })
      .from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const requestedTz = new URL(request.url).searchParams.get('tz');
    const dayKey = localDayKey(new Date(), pickTimeZone(requestedTz, user?.timezone));
    const recommendation = await createOrLoadDailyRecommendation(userId, dayKey, new Date());
    const state = await hydrateCoachWorkspaceState(userId, recommendation);
    return NextResponse.json({ recommendation: serialize(recommendation), state });
  } catch (err) {
    return NextResponse.json({ error: `Coach Workspace read error: ${String(err)}` }, { status: 500 });
  }
}
