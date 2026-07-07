import { NextResponse } from 'next/server';
import { logWeight } from '@/lib/weightLog';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = getUserIdFromRequest(req);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const { weight, unit, date } = await req.json() as { weight: number; unit: 'lbs' | 'kg'; date: string };

  if (!weight || !date) {
    return NextResponse.json({ error: 'weight and date required' }, { status: 400 });
  }

  logWeight(userId, date, weight, unit ?? 'lbs');
  return NextResponse.json({ ok: true });
}
