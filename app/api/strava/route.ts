import { NextResponse } from 'next/server';
import { fetchStravaData } from '@/lib/strava';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await fetchStravaData();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
