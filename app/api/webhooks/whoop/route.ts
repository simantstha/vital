import { NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import { bustCache } from '@/lib/briefCache';
import { loadChatId, sendMessage } from '@/lib/telegram';
import { getCachedBrief } from '@/lib/briefCache';
import { readHrvBaseline } from '@/lib/memory';

const MEMORY_DIR = path.resolve(process.cwd(), '.vital-memory');
const GREEN_STREAK_FILE = path.join(MEMORY_DIR, 'green-streak.json');

interface GreenStreak {
  dates: string[];
}

function readGreenStreak(): GreenStreak {
  try {
    return JSON.parse(fs.readFileSync(GREEN_STREAK_FILE, 'utf-8')) as GreenStreak;
  } catch {
    return { dates: [] };
  }
}

function writeGreenStreak(streak: GreenStreak): void {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(GREEN_STREAK_FILE, JSON.stringify(streak), 'utf-8');
  } catch { /* read-only fs on Vercel */ }
}

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

  interface WhoopPayload {
    type?: string;
    data?: {
      recovery_score?: number;
      hrv_rmssd_milli?: number;
    };
  }

  let payload: WhoopPayload;
  try { payload = JSON.parse(body) as WhoopPayload; }
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

    // --- Proactive alerts ---
    const whoopData = payload.data;
    const recoveryScore = whoopData?.recovery_score;
    const currentHrv = whoopData?.hrv_rmssd_milli;
    const today = new Date().toISOString().split('T')[0];

    if (!chatId) {
      console.warn('Whoop alerts: no Telegram chatId configured, skipping alerts');
    } else {
      // 1. Red day alert
      if (typeof recoveryScore === 'number' && recoveryScore < 33) {
        await sendMessage(chatId, '🔴 Recovery is in the red today — your body is asking for rest. Easy day recommended.');
      }

      // 2. HRV crash alert
      if (typeof currentHrv === 'number') {
        const baseline = readHrvBaseline();
        if (baseline !== null && currentHrv < baseline * 0.85) {
          await sendMessage(chatId, '⚠️ HRV dropped significantly below your baseline — watch your load today.');
        }
      }

      // 3. Green streak tracking + alert (fires only when streak first reaches 3)
      const streak = readGreenStreak();
      const wasStreaking = streak.dates.length >= 3;
      if (typeof recoveryScore === 'number' && recoveryScore >= 67) {
        if (!streak.dates.includes(today)) streak.dates.push(today);
        if (streak.dates.length > 7) streak.dates = streak.dates.slice(-7);
      } else {
        streak.dates = [];
      }
      writeGreenStreak(streak);

      if (!wasStreaking && streak.dates.length >= 3) {
        await sendMessage(chatId, '🟢 3 green days in a row — you\'re in a peak window. Good day for a hard effort if planned.');
      }
    }
  } catch (err) {
    console.error('Whoop webhook handler error:', err);
  }

  return NextResponse.json({ ok: true });
}
