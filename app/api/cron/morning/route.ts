import { NextResponse } from 'next/server';
import { bustCache, getCachedBrief } from '@/lib/briefCache';
import { loadChatId, sendMessage } from '@/lib/telegram';

export const dynamic = 'force-dynamic';

export async function POST() {
  bustCache();

  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const res = await fetch(`${origin}/api/brief`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: 502 });
  }

  // Fallback Telegram delivery (primary path is the Whoop recovery.scored webhook)
  try {
    const chatId = loadChatId();
    if (chatId) {
      const brief = getCachedBrief();
      if (brief) {
        const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        const bodyClean = brief.body.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
        const sentences = bodyClean.split(/(?<=[.!?])\s+/);
        const summary = sentences.slice(0, 2).join(' ');
        const breakfast = brief.meals.find(m => m.k.toLowerCase() === 'breakfast');
        const workoutChip = brief.chips.find(c => c.k.toLowerCase().includes('workout') || c.k.toLowerCase().includes('recovery'));

        let text = `📊 *Morning Brief — ${date}*\n\n${summary}\n\n`;
        if (workoutChip) text += `🏃 ${workoutChip.k}: ${workoutChip.v}\n`;
        if (breakfast) text += `🍽 Breakfast: ${breakfast.items} — ${breakfast.kcal} kcal\n`;
        text += `\n_Reply to ask your coach anything_`;

        await sendMessage(chatId, text);
      }
    }
  } catch { /* Telegram send is best-effort */ }

  return NextResponse.json({ ok: true, generated: new Date().toISOString() });
}
