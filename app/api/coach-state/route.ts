import { NextResponse } from 'next/server';
import { readCoachState } from '@/lib/coachState';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(readCoachState());
}
