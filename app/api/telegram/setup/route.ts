import { NextResponse } from 'next/server';
import { registerWebhook } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 });
  if (!secret) return NextResponse.json({ error: 'TELEGRAM_WEBHOOK_SECRET not set' }, { status: 500 });

  // Derive base URL from request
  const { origin } = new URL(req.url);
  const webhookUrl = `${origin}/api/telegram/webhook`;

  const result = await registerWebhook(webhookUrl, secret);
  return NextResponse.json({ webhookUrl, telegram: result });
}
