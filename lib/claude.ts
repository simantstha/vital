import Anthropic from '@anthropic-ai/sdk';
import type { DailyBrief } from './types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface BriefContext {
  recovery: number;
  hrv: number;
  rhr: number;
  sleepPerf: number;
  sleepDuration: string;
  strain: number | string;
  weeklyMi: number;
  lastRun: { distanceMi: string; pace: string; dayTime: string; name: string } | null;
}

const CHIP_WORKOUT_BY_RECOVERY = (score: number) =>
  score >= 67 ? 'Quality intervals or tempo run' :
  score >= 34 ? 'Zone 2 aerobic · 60min easy' :
  'Walk 20min · mobility only';

export async function generateDailyBrief(ctx: BriefContext): Promise<DailyBrief> {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const prompt = `You are a personal health AI for a marathon runner training for the Loch Ness Marathon on October 4, 2026.

Today's data:
- Date: ${today}
- Recovery Score: ${ctx.recovery}% (${ctx.recovery >= 67 ? 'Green' : ctx.recovery >= 34 ? 'Amber' : 'Red'})
- HRV: ${ctx.hrv}ms
- Resting HR: ${ctx.rhr}bpm
- Sleep Performance: ${ctx.sleepPerf}% · ${ctx.sleepDuration}
- Today's Strain so far: ${ctx.strain}
- Weekly Miles: ${ctx.weeklyMi.toFixed(1)}mi this week
${ctx.lastRun ? `- Last Run: ${ctx.lastRun.distanceMi}mi at ${ctx.lastRun.pace}/mi (${ctx.lastRun.dayTime}) — "${ctx.lastRun.name}"` : '- No recent runs logged'}

Generate a morning brief and meal plan. Respond ONLY with valid JSON, no markdown, no explanation:

{
  "body": "2-3 sentences. Personal, specific to their numbers. Use **text** for bold emphasis and *text* for accent highlights.",
  "chips": [
    {"k": "Workout", "v": "specific recommendation based on recovery"},
    {"k": "Sleep", "v": "${ctx.sleepPerf}% · ${ctx.sleepDuration}"},
    {"k": "Strain", "v": "cap based on recovery"}
  ],
  "meals": [
    {
      "k": "Breakfast", "t": "7:30 AM", "h": 7.5,
      "kcal": 0, "c": 0, "p": 0, "f": 0,
      "items": "specific foods",
      "why": "1-2 sentences tying food to their recovery and workout. Use **bold** and *accent* sparingly."
    },
    {"k": "Lunch", "t": "12:45 PM", "h": 12.75, "kcal": 0, "c": 0, "p": 0, "f": 0, "items": "...", "why": "..."},
    {"k": "Snack", "t": "3:30 PM", "h": 15.5, "kcal": 0, "c": 0, "p": 0, "f": 0, "items": "...", "why": "..."},
    {"k": "Dinner", "t": "7:30 PM", "h": 19.5, "kcal": 0, "c": 0, "p": 0, "f": 0, "items": "...", "why": "..."}
  ]
}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = JSON.parse(text);

  return {
    date: new Date().toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    body: parsed.body,
    chips: parsed.chips,
    meals: parsed.meals,
  };
}
