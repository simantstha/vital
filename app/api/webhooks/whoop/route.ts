import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { bustCache } from '@/lib/briefCache';
import { loadChatId, sendMessage } from '@/lib/telegram';
import { getCachedBrief } from '@/lib/briefCache';

export const dynamic = 'force-dynamic';

function verifySignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  // Whoop sends HMAC-SHA256 hex digest in X-WHOOP-Signature
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return signature === expected;
}

function formatBrief(): string {
  const brief = getCachedBrief();
  if (!brief) return '';

  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  // Extract first 2 sentences from brief body (strip markdown bold/italic)
  const bodyClean = brief.body.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  const sentences = bodyClean.split(/(?<=[.!?])\s+/);
  const summary = sentences.slice(0, 2).join(' ');

  // Recovery chip
  const recoveryChip = brief.chips.find(c => c.k.toLowerCase().includes('recovery') || c.k.toLowerCase().includes('workout'));
  const breakfast = brief.meals.find(m => m.k.toLowerCase() === 'breakfast');

  let text = `📊 *Morning Brief — ${date}*\n\n`;
  text += `${summary}\n\n`;
  if (recoveryChip) text += `🏃 ${recoveryChip.k}: ${recoveryChip.v}\n`;
  if (breakfast) text += `🍽 Breakfast: ${breakfast.items} — ${breakfast.kcal} kcal\n`;
  text += `\n_Reply to ask your coach anything_`;

  return text;
}

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get('x-whoop-signature');
  const secret = process.env.WHOOP_WEBHOOK_SECRET;

  if (secret && !verifySignature(body, signature, secret)) {
    return new Response('Forbidden', { status: 403 });
  }

  let payload: { type?: string };
  try { payload = JSON.parse(body) as { type?: string }; }
  catch { return NextResponse.json({ ok: true }); }

  // Only act on recovery.scored — acknowledge other events immediately
  if (payload.type !== 'recovery.scored') {
    return NextResponse.json({ ok: true });
  }

  // Bust cache and regenerate brief
  bustCache();

  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  try {
    const res = await fetch(`${origin}/api/brief`, { method: 'POST' });
    if (!res.ok) throw new Error(`Brief generation failed: ${res.status}`);

    // Send Telegram summary
    const chatId = loadChatId();
    if (chatId) {
      const text = formatBrief();
      if (text) await sendMessage(chatId, text);
    }
  } catch (err) {
    console.error('Whoop webhook handler error:', err);
  }

  return NextResponse.json({ ok: true });
}
