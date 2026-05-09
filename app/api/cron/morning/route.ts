import { NextResponse } from 'next/server';
import { bustCache } from '@/lib/briefCache';

export const dynamic = 'force-dynamic';

export async function POST() {
  // Bust today's cache so the next GET to /api/brief regenerates fresh
  bustCache();

  // Trigger generation by calling the brief route internally
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3002';

  const res = await fetch(`${origin}/api/brief`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: 502 });
  }

  return NextResponse.json({ ok: true, generated: new Date().toISOString() });
}
