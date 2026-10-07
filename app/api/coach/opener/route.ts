/**
 * GET /api/coach/opener
 *
 * Returns a short, fresh, data-aware conversation opener for the Coach tab.
 * Response: { text: string }
 *
 * Unlike /api/coach, this is a plain (non-streaming) request generated on every
 * open. It is intentionally EPHEMERAL — the opener is never written to the
 * `messages` table, so it can't pollute conversation context or history. The
 * real conversation still begins when the user sends their first message.
 *
 * 1. Resolves the authenticated user (getUserIdFromRequest).
 * 2. Assembles today's context via lib/brain/context.assembleContext.
 * 3. Makes ONE claude-haiku-4-5 call for a short, first-person opener that
 *    leads with the user's goal status (lib/brain/openerText.ts).
 *
 * Any failure (auth aside) returns a safe static fallback with status 200 so
 * the chat always opens cleanly.
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getUserIdFromRequest } from '@/lib/auth';
import { assembleContext } from '@/lib/brain/context';
import { CLAUDE_HAIKU_MODEL } from '@/lib/aiModels';
import { goalFallbackOpener, requiredOpenerLine } from '@/lib/brain/openerText';

export const dynamic = 'force-dynamic';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FALLBACK =
  "Hey! I'm your Vital coach. Ask me anything about your health trends, sleep, or how to optimize your day.";

export async function GET(request: Request): Promise<NextResponse> {
  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  let required: string | null = null;
  let fallback = FALLBACK;
  try {
    const ctx = await assembleContext(userId);

    // The goal status line is composed deterministically (lib/brain/openerText.ts,
    // same verdict as the goal cards) and is the REQUIRED first sentence.
    const goal = ctx.goalProgress?.goal ?? ctx.dietBudget?.goal;
    required = requiredOpenerLine(ctx.goalProgress, goal, ctx.unitSystem);
    fallback = goalFallbackOpener(ctx.goalProgress, goal, ctx.unitSystem) ?? FALLBACK;
    const goalRule = required
      ? `\nBegin with EXACTLY this goal-status text, verbatim, as your opening: "${required}"\nThen add at most ONE short sentence (an invitation to dig in, or one data observation). Do not restate or reword the goal status.`
      : '';

    const msg = await client.messages.create({
      model:      CLAUDE_HAIKU_MODEL,
      max_tokens: 160,
      system: `You are Vital Coach — a calm, data-aware personal health companion opening a new chat.
Greet the user and surface ONE specific, interesting observation drawn from their data below
(e.g. an HRV trend, a sleep streak, a resting-HR shift), then invite them to dig in.
Speak in first-person observation voice ("Your HRV is up…", "You've strung together…").
Never prescribe or advise. 1–3 short sentences only. No emojis. No markdown.
If the data is sparse or empty, give a warm, generic welcome instead of inventing numbers.${goalRule}`,
      messages: [{
        role: 'user',
        content:
          `${ctx.promptText}\n\n---\n\n` +
          `Write the opening line for the coach chat now.`,
      }],
    });

    const first = msg.content[0];
    let text =
      first && first.type === 'text' ? first.text.trim() : '';
    // Guard: the model must not drop or reword the deterministic goal line.
    if (text && required && !text.startsWith(required)) text = `${required} ${text}`;

    return NextResponse.json({ text: text || fallback });
  } catch (err) {
    console.error('[/api/coach/opener] generation failed (non-fatal):', err);
    return NextResponse.json({ text: fallback });
  }
}
