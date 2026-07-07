import { NextResponse } from 'next/server';
import { readCoachState } from '@/lib/coachState';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }
  return NextResponse.json(readCoachState(userId));
}
