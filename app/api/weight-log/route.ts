import { NextResponse } from 'next/server';
import { logWeight } from '@/lib/weightLog';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { weight, unit, date } = await req.json() as { weight: number; unit: 'lbs' | 'kg'; date: string };

  if (!weight || !date) {
    return NextResponse.json({ error: 'weight and date required' }, { status: 400 });
  }

  logWeight(date, weight, unit ?? 'lbs');
  return NextResponse.json({ ok: true });
}
