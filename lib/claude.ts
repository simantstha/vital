import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import type { DailyBrief } from './types';
import { readMemoryFile, writeMemoryFile } from '@/lib/memory';
import { DATA_DIR } from './dataDir';

// ── Inline types (formerly imported from lib/whoop + lib/strava) ──────────────

interface BriefHistoryDay {
  date: string;
  recovery: number;
  hrv: number;
  rhr: number;
  sleepPerf: number;
  sleepDuration: string;
}

interface BriefHistory {
  days: BriefHistoryDay[];
  avgRecovery7d: number;
  avgHrv7d: number;
  trend: 'improving' | 'declining' | 'stable';
}

interface ActivityRecord {
  type: 'run' | 'gym' | 'walk';
  date: string;
  distanceMi?: string;
  pace?: string;
  hr?: number;
  zone?: string;
  name: string;
  durationMin?: number;
}

interface WeeklyLoadRecord {
  weekStart: string;
  runMi: number;
  walkMi: number;
  gymMin: number;
  gymSessions: number;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROFILE_PATH = path.join(DATA_DIR, '.vital-memory', 'user-profile.md');

const SEED_PROFILE = `# Vital — User Profile

## Goals
- Primary: [to be filled]
- Body composition: [performance / weight-loss / muscle-gain — update this]
- Weekly training target: [to be filled]

## Baselines (update as patterns emerge)
- HRV baseline: [to be filled]
- Resting HR: [to be filled]
- Recovery baseline: [to be filled]
- Typical hard days: [to be filled]
- Typical gym days: [to be filled]

## Dietary Preferences / Constraints
- (Claude fills this in over time)

## Coach Notes
(Claude appends one-sentence insights here after each brief)
`;

export function readUserProfile(): string {
  try {
    return fs.readFileSync(PROFILE_PATH, 'utf8');
  } catch {
    try {
      fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
      fs.writeFileSync(PROFILE_PATH, SEED_PROFILE, 'utf8');
    } catch { /* read-only fs on Vercel */ }
    return SEED_PROFILE;
  }
}

function appendCoachNote(note: string) {
  try {
    let content = fs.readFileSync(PROFILE_PATH, 'utf8');
    const marker = '## Coach Notes';
    const idx = content.indexOf(marker);
    const date = new Date().toISOString().split('T')[0];
    const entry = `\n- [${date}] ${note}`;
    if (idx === -1) {
      content += `\n${marker}${entry}\n`;
    } else {
      // Append before next section or end of file
      const nextSection = content.indexOf('\n## ', idx + marker.length);
      const insertAt = nextSection === -1 ? content.length : nextSection;
      content = content.slice(0, insertAt) + entry + content.slice(insertAt);
    }
    fs.writeFileSync(PROFILE_PATH, content, 'utf8');
  } catch { /* read-only fs */ }
}

interface BriefContext {
  recovery: number;
  hrv: number;
  rhr: number;
  sleepPerf: number;
  sleepDuration: string;
  strain: number | string;
  weeklyMi: number;
  lastRun: { distanceMi: string; pace: string; dayTime: string; name: string } | null;
  history?: BriefHistory | null;
  recentActivities?: ActivityRecord[];
  weeklyMileage?: WeeklyLoadRecord[];
  recentNutrition?: Array<{ date: string; calories: number; carbs: number; protein: number; fat: number }>;
  weightKg?: number;
}

function updateHrvBaseline(currentAvg: number): void {
  const profile = readMemoryFile('core-profile.md');
  if (!profile) return;

  const match = /hrv baseline:\s*(\d+)\s*ms/i.exec(profile);
  if (!match) return;

  const stored = parseInt(match[1], 10);
  if (Math.abs(currentAvg - stored) <= 3) return;

  const date = new Date().toISOString().split('T')[0];
  const updated = profile.replace(
    /hrv baseline:\s*\d+\s*ms \(updated [^)]+\)/i,
    `HRV baseline: ${currentAvg}ms (updated ${date})`
  );
  writeMemoryFile('core-profile.md', updated);
}

export async function generateDailyBrief(ctx: BriefContext): Promise<DailyBrief> {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const userProfile = readMemoryFile('core-profile.md') ?? readUserProfile();

  const historySection = ctx.history?.days.length
    ? `\n## 7-Day Recovery Trend (newest first)\n` +
      ctx.history.days.map(d =>
        `${d.date}: recovery ${d.recovery}%, HRV ${d.hrv}ms, sleep ${d.sleepPerf}% (${d.sleepDuration})`
      ).join('\n') +
      `\n7-day avg: recovery ${ctx.history.avgRecovery7d}%, HRV ${ctx.history.avgHrv7d}ms — trend: ${ctx.history.trend}`
    : '';

  const activitiesSection = ctx.recentActivities?.length
    ? `\n## Last 7 Days Activities\n` +
      ctx.recentActivities.map(a => {
        if (a.type === 'run') return `${a.date}: Run ${a.distanceMi}mi @ ${a.pace}/mi, HR ${a.hr}bpm (${a.zone}), "${a.name}"`;
        if (a.type === 'gym') return `${a.date}: Gym ${a.durationMin}min, "${a.name}"`;
        return `${a.date}: Walk ${a.distanceMi ?? 0}mi, ${a.durationMin}min`;
      }).join('\n')
    : '';

  const weeklyLoadSection = ctx.weeklyMileage?.length
    ? `\n## Weekly Training Load (last 8 weeks, newest first)\n` +
      ctx.weeklyMileage.map(w =>
        `${w.weekStart}: ${w.runMi}mi run · ${w.walkMi}mi walk · ${w.gymMin}min gym (${w.gymSessions} sessions)`
      ).join('\n')
    : '';

  const nutritionSection = ctx.recentNutrition?.length
    ? `\n## Recent Nutrition (last 3 days)\n` +
      ctx.recentNutrition.map(n =>
        `${n.date}: ${n.calories}kcal · ${n.carbs}g carbs · ${n.protein}g protein · ${n.fat}g fat`
      ).join('\n')
    : '';

  const prompt = `You are a personal fitness and nutrition coach. Use the user's core profile (goals, activities, baselines) along with their training history and recovery trends to:
1. Prescribe today's workout intensity based on recovery + recent training load
2. Prescribe today's nutrition for recovery (post-workout if applicable) AND tomorrow's performance (carb-load if tomorrow looks like a hard day based on their pattern)
3. Spot patterns worth calling out (e.g. "your HRV drops when sleep is under 7h")
4. Keep meals specific and tied to actual training data — not generic advice

## Long-term User Profile
${userProfile}

## Today's Snapshot
- Date: ${today}
- Recovery Score: ${ctx.recovery}% (${ctx.recovery >= 67 ? 'Green' : ctx.recovery >= 34 ? 'Amber' : 'Red'})
- HRV: ${ctx.hrv}ms
- Resting HR: ${ctx.rhr}bpm
- Sleep Performance: ${ctx.sleepPerf}% · ${ctx.sleepDuration}
- Today's Strain so far: ${ctx.strain}
- Weekly Miles: ${ctx.weeklyMi.toFixed(1)}mi this week
${ctx.lastRun ? `- Last Run: ${ctx.lastRun.distanceMi}mi at ${ctx.lastRun.pace}/mi (${ctx.lastRun.dayTime}) — "${ctx.lastRun.name}"` : '- No recent runs logged'}
${historySection}${activitiesSection}${weeklyLoadSection}${nutritionSection}

Respond ONLY with valid JSON, no markdown, no explanation:

{
  "body": "2-3 sentences. Personal, specific to their numbers. Use **text** for bold emphasis and *text* for accent highlights.",
  "chips": [
    {"k": "Workout", "v": "specific recommendation based on recovery + load"},
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
  ],
  "profileUpdate": "one sentence insight worth remembering about this user's patterns, or null"
}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = JSON.parse(text);

  if (parsed.profileUpdate) appendCoachNote(parsed.profileUpdate);

  if (ctx.history?.avgHrv7d) {
    updateHrvBaseline(ctx.history.avgHrv7d);
  }

  return {
    date: new Date().toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    body: parsed.body,
    chips: parsed.chips,
    meals: parsed.meals,
  };
}
