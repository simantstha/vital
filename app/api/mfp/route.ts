import { NextResponse } from 'next/server';
import { getDiaryMacros } from '@/lib/mfp';

export async function GET() {
  if (!process.env.MFP_USERNAME || !process.env.MFP_PASSWORD) {
    return NextResponse.json({ error: 'MFP credentials not configured' }, { status: 503 });
  }

  try {
    const date = new Date().toISOString().split('T')[0];
    const macros = await getDiaryMacros(date);
    return NextResponse.json(macros);
  } catch (err) {
    console.error('[MFP]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
