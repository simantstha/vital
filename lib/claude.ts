import Anthropic from '@anthropic-ai/sdk';
import type { DailyBrief } from './types';
import { readMemoryFile, writeMemoryFile } from '@/lib/memory';
import { writeHrvBaselineToProfile } from '@/lib/brain/baselines';

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

export function readUserProfile(userId: string): string {
  const existing = readMemoryFile(userId, 'user-profile.md');
  if (existing) return existing;
  writeMemoryFile(userId, 'user-profile.md', SEED_PROFILE);
  return SEED_PROFILE;
}

function appendCoachNote(userId: string, note: string) {
  const content = readMemoryFile(userId, 'user-profile.md') ?? SEED_PROFILE;
  const marker = '## Coach Notes';
  const idx = content.indexOf(marker);
  const date = new Date().toISOString().split('T')[0];
  const entry = `\n- [${date}] ${note}`;
  let updated: string;
  if (idx === -1) {
    updated = content + `\n${marker}${entry}\n`;
  } else {
    // Append before next section or end of file
    const nextSection = content.indexOf('\n## ', idx + marker.length);
    const insertAt = nextSection === -1 ? content.length : nextSection;
    updated = content.slice(0, insertAt) + entry + content.slice(insertAt);
  }
  writeMemoryFile(userId, 'user-profile.md', updated);
}

interface BriefContext {
  /** null when there isn't enough biometric data to compute a recovery score yet. */
  recovery: number | null;
  /** null when no HRV has synced yet — never substitute a placeholder number. */
  hrv: number | null;
  /** null when no resting-HR reading has synced yet. */
  rhr: number | null;
  /** Sleep efficiency %; null when stage data is unavailable. */
  sleepPerf: number | null;
  /** Formatted sleep duration (e.g. "7h 12m"); null when no sleep has synced. */
  sleepDuration: string | null;
  strain: number | string;
  weeklyMi: number;
  lastRun: { distanceMi: string; pace: string; dayTime: string; name: string } | null;
  history?: BriefHistory | null;
  recentActivities?: ActivityRecord[];
  weeklyMileage?: WeeklyLoadRecord[];
  recentNutrition?: Array<{ date: string; calories: number; carbs: number; protein: number; fat: number }>;
  weightKg?: number;
  foodProfile?: { restrictions: Array<{ type: string; label: string }>; preferences: Array<{ type: string; label: string }> };
  /** True while baselines are still calibrating (< 14 days of history) — recovery score is provisional. */
  calibrating?: boolean;
}

export async function generateDailyBrief(userId: string, ctx: BriefContext): Promise<DailyBrief> {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const userProfile = readMemoryFile(userId, 'core-profile.md') ?? readUserProfile(userId);

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

  const foodSection = ctx.foodProfile && (ctx.foodProfile.restrictions.length || ctx.foodProfile.preferences.length)
    ? `\n## Food Preferences & Restrictions\n` +
      (ctx.foodProfile.restrictions.length
        ? `RESTRICTIONS — never include these foods in ANY meal:\n${
            ctx.foodProfile.restrictions.map(r => `- ${r.type}: ${r.label}`).join('\n')
          }` +
          (ctx.foodProfile.preferences.length ? '\n\n' : '')
        : '') +
      (ctx.foodProfile.preferences.length
        ? `PREFERENCES — favor liked foods/cuisines, avoid disliked ones:\n${
            ctx.foodProfile.preferences.map(p => `- ${p.type}: ${p.label}`).join('\n')
          }`
        : '')
    : '';

  // ── Absence-aware biometric lines ──────────────────────────────────────────
  // These values come straight from the same daily_metrics store the Today
  // metric cards read. When a metric hasn't synced yet we say so explicitly —
  // never substitute a placeholder number the user can't reconcile with the app.
  const recoveryLine = ctx.recovery != null
    ? `- Recovery Score: ${ctx.recovery}% (${ctx.recovery >= 67 ? 'Green' : ctx.recovery >= 34 ? 'Amber' : 'Red'})${ctx.calibrating ? ' — provisional' : ''}`
    : `- Recovery Score: not enough data yet (no HRV synced)`;
  const hrvLine   = ctx.hrv != null ? `- HRV: ${ctx.hrv}ms` : `- HRV: no reading synced yet today`;
  const rhrLine   = ctx.rhr != null ? `- Resting HR: ${ctx.rhr}bpm` : `- Resting HR: no reading synced yet today`;
  const sleepLine = ctx.sleepDuration != null
    ? `- Sleep: ${ctx.sleepDuration}${ctx.sleepPerf != null ? ` · ${ctx.sleepPerf}% efficiency` : ''}`
    : `- Sleep: no sleep data synced yet today`;
  const sleepChip = ctx.sleepDuration != null
    ? `${ctx.sleepDuration}${ctx.sleepPerf != null ? ` · ${ctx.sleepPerf}%` : ''}`
    : 'No data yet';

  const prompt = `You are a personal fitness and nutrition coach. Use the user's core profile (goals, activities, baselines) along with their training history and recovery trends to:
1. Prescribe today's workout intensity based on recovery + recent training load
2. Prescribe today's nutrition for recovery (post-workout if applicable) AND tomorrow's performance (carb-load if tomorrow looks like a hard day based on their pattern)
3. Spot patterns worth calling out (e.g. "your HRV drops when sleep is under 7h")
4. Keep meals specific and tied to actual training data — not generic advice
5. Meals MUST NOT contain any food listed under RESTRICTIONS (allergies/intolerances/conditions) — this is a hard rule. Favor PREFERENCES: liked foods and cuisines in, disliked foods out.

## Long-term User Profile
${userProfile}

## Today's Snapshot
- Date: ${today}
${ctx.calibrating ? '- NOTE: Baselines are still calibrating (fewer than 14 days of history) — treat the recovery score below as PROVISIONAL. Do not give a firm recovery/training-intensity prescription; say the numbers are still settling in and default to moderate, conservative guidance.\n' : ''}- IMPORTANT: Only reference the biometrics listed below. If a metric says "no reading synced yet", acknowledge it's missing — do NOT invent a value.
${recoveryLine}
${hrvLine}
${rhrLine}
${sleepLine}
- Today's Strain so far: ${ctx.strain}
- Weekly Miles: ${ctx.weeklyMi.toFixed(1)}mi this week
${ctx.lastRun ? `- Last Run: ${ctx.lastRun.distanceMi}mi at ${ctx.lastRun.pace}/mi (${ctx.lastRun.dayTime}) — "${ctx.lastRun.name}"` : '- No recent runs logged'}
${historySection}${activitiesSection}${weeklyLoadSection}${nutritionSection}${foodSection}

Respond ONLY with valid JSON, no markdown, no explanation:

{
  "body": "2-3 sentences. Personal, specific to their numbers. Use **text** for bold emphasis and *text* for accent highlights.",
  "chips": [
    {"k": "Workout", "v": "specific recommendation based on recovery + load"},
    {"k": "Sleep", "v": "${sleepChip}"},
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

  if (parsed.profileUpdate) appendCoachNote(userId, parsed.profileUpdate);

  if (ctx.history?.avgHrv7d) {
    writeHrvBaselineToProfile(userId, ctx.history.avgHrv7d);
  }

  return {
    date: new Date().toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    body: parsed.body,
    chips: parsed.chips,
    meals: parsed.meals,
  };
}
