import Anthropic from '@anthropic-ai/sdk';
import type { DailyBrief } from './types';
import { readMemoryFile, writeMemoryFile } from '@/lib/memory';
import { writeHrvBaselineToProfile } from '@/lib/brain/baselines';
import { parseProfileDetails, formatIdentityForPrompt } from '@/lib/profileDetails';
import type { UnitSystem } from '@/lib/units';
import type { RecoveryConfidence, RecoveryGap, RecoveryHistoryDay } from '@/lib/brain/recovery';

// ── Inline types (formerly imported from lib/whoop + lib/strava) ──────────────

interface BriefHistory {
  days: RecoveryHistoryDay[];
  avgRecovery7d: number | null;
  avgHrv7d: number | null;
  trend: 'improving' | 'declining' | 'stable' | 'unknown';
}

interface ActivityRecord {
  type: 'run' | 'gym' | 'walk';
  date: string;
  distance?: string;
  pace?: string;
  hr?: number;
  zone?: string;
  name: string;
  durationMin?: number;
}

interface WeeklyLoadRecord {
  weekStart: string;
  runDistance: number;
  walkDistance: number;
  gymMin: number;
  gymSessions: number;
}

/** Minutes → "Xh YYm", for rendering RecoveryHistoryDay.sleepMinutes in the prompt. */
function minutesToHm(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m < 10 ? '0' : ''}${m}m`;
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
  /** Confidence behind `recovery` — 'high' only when HRV + both sleep components are present and the baseline is established; 'insufficient' when `recovery` is null. */
  recoveryConfidence?: RecoveryConfidence;
  /** Which HRV source `recovery` was computed from (e.g. "WHOOP HRV (RMSSD)", "HealthKit HRV (SDNN)"); null when there's no source. */
  recoverySourceLabel?: string | null;
  /** Why `recovery` is provisional or absent — drives the PROVISIONAL phrase list in the prompt. */
  recoveryGaps?: RecoveryGap[];
  /** WHOOP's own recovery score, reference only — never the score quoted as "Recovery Score" above. Null when WHOOP isn't the source or hasn't reported today. */
  whoopRecovery?: number | null;
  /** null when no HRV has synced yet — never substitute a placeholder number. */
  hrv: number | null;
  /** null when no resting-HR reading has synced yet. */
  rhr: number | null;
  /** Sleep efficiency %; null when stage data is unavailable. */
  sleepPerf: number | null;
  /** Formatted sleep duration (e.g. "7h 12m"); null when no sleep has synced. */
  sleepDuration: string | null;
  strain: number | string;
  weeklyDistance: number;
  /** Unit label the distance fields above (weeklyDistance, lastRun.distance, weeklyMileage.run/walkDistance) are expressed in — "km" or "mi". */
  distanceUnit: string;
  /** Display-unit preference (default 'metric' when omitted) — only steers prompt-assembly formatting (distanceUnit above, identity height/weight); storage stays metric. */
  unitSystem?: UnitSystem;
  lastRun: { distance: string; pace: string; dayTime: string; name: string } | null;
  history?: BriefHistory | null;
  recentActivities?: ActivityRecord[];
  weeklyMileage?: WeeklyLoadRecord[];
  recentNutrition?: Array<{ date: string; calories: number; carbs: number; protein: number; fat: number }>;
  weightKg?: number;
  foodProfile?: { restrictions: Array<{ type: string; label: string }>; preferences: Array<{ type: string; label: string }> };
  /** True while baselines are still calibrating (< 14 days of history) — recovery score is provisional. */
  calibrating?: boolean;
}

/**
 * Replaces the `## Identity` section's lines in a raw core-profile.md/
 * user-profile.md markdown blob with `formatIdentityForPrompt`'s
 * unit-converted rendering — prompt-assembly only, the stored file is never
 * touched. A no-op when there's no `## Identity` heading (e.g. the seeded
 * user-profile.md fallback) or when `units` is 'metric' (the stored text is
 * already metric, so rewriting it would only drop the weight's "last
 * updated" provenance for no benefit).
 */
function applyIdentityUnits(markdown: string, units: UnitSystem): string {
  if (units !== 'imperial' || !markdown.includes('## Identity')) return markdown;
  const formatted = formatIdentityForPrompt(parseProfileDetails(markdown), units);
  if (!formatted) return markdown;

  const result: string[] = [];
  let inIdentity = false;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inIdentity = heading[1] === 'Identity';
      result.push(line);
      if (inIdentity) result.push(formatted);
      continue;
    }
    if (inIdentity) continue; // original Identity lines dropped in favor of `formatted` above
    result.push(line);
  }
  return result.join('\n');
}

export async function generateDailyBrief(userId: string, ctx: BriefContext): Promise<DailyBrief> {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const userProfile = applyIdentityUnits(
    readMemoryFile(userId, 'core-profile.md') ?? readUserProfile(userId),
    ctx.unitSystem ?? 'metric',
  );

  // History days come from lib/brain/recovery.ts's buildRecoveryHistory, which
  // OMITS any day with no HRV reading rather than fabricating one — so every
  // day here has a real `recovery`/`hrv`, but sleep fields can still be null
  // (no stage/duration data that night). Never print a bare "null%".
  const historySection = ctx.history?.days.length
    ? `\n## 7-Day Recovery Trend (newest first)\n` +
      ctx.history.days.map(d => {
        const sleepPart = d.sleepMinutes != null
          ? `, sleep ${minutesToHm(d.sleepMinutes)}${d.sleepEfficiencyPct != null ? ` (${d.sleepEfficiencyPct}% efficiency)` : ''}`
          : '';
        return `${d.date}: recovery ${d.recovery}%, HRV ${d.hrv}ms${sleepPart}`;
      }).join('\n') +
      (ctx.history.avgRecovery7d != null
        ? `\n7-day avg: recovery ${ctx.history.avgRecovery7d}%${ctx.history.avgHrv7d != null ? `, HRV ${ctx.history.avgHrv7d}ms` : ''}`
        : '') +
      `\nBased on ${ctx.history.days.length} of the last 7 days — trend: ${ctx.history.trend}`
    : '';

  const distanceUnit = ctx.distanceUnit;

  const activitiesSection = ctx.recentActivities?.length
    ? `\n## Last 7 Days Activities\n` +
      ctx.recentActivities.map(a => {
        if (a.type === 'run') return `${a.date}: Run ${a.distance}${distanceUnit} @ ${a.pace}/${distanceUnit}, HR ${a.hr}bpm (${a.zone}), "${a.name}"`;
        if (a.type === 'gym') return `${a.date}: Gym ${a.durationMin}min, "${a.name}"`;
        return `${a.date}: Walk ${a.distance ?? 0}${distanceUnit}, ${a.durationMin}min`;
      }).join('\n')
    : '';

  const weeklyLoadSection = ctx.weeklyMileage?.length
    ? `\n## Weekly Training Load (last 8 weeks, newest first)\n` +
      ctx.weeklyMileage.map(w =>
        `${w.weekStart}: ${w.runDistance}${distanceUnit} run · ${w.walkDistance}${distanceUnit} walk · ${w.gymMin}min gym (${w.gymSessions} sessions)`
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

  // Plain-English reasons for a PROVISIONAL recovery score, keyed off the
  // RecoveryGap enum in lib/brain/recovery.ts. no_hrv is excluded here — it
  // maps to the 'insufficient' branch below, never to a provisional line.
  const RECOVERY_GAP_PHRASES: Partial<Record<RecoveryGap, string>> = {
    no_sleep_duration: 'no sleep data synced last night',
    no_sleep_efficiency: 'sleep stages not recorded',
    baseline_calibrating: 'baseline still calibrating',
    baseline_from_short_window: 'baseline from a short history',
  };

  let recoveryLine: string;
  if (ctx.recovery != null && ctx.recoveryConfidence !== 'insufficient') {
    const band = ctx.recovery >= 67 ? 'Green' : ctx.recovery >= 34 ? 'Amber' : 'Red';
    const base = `- Recovery Score: ${ctx.recovery}% (${band}) — Vital's own score, from ${ctx.recoverySourceLabel} vs. your 30-day baseline, blended with sleep duration and efficiency`;
    if (ctx.recoveryConfidence === 'provisional') {
      const reasons = (ctx.recoveryGaps ?? [])
        .map(g => RECOVERY_GAP_PHRASES[g])
        .filter((s): s is string => !!s);
      recoveryLine = reasons.length ? `${base} — PROVISIONAL: ${reasons.join(', ')}` : `${base} — PROVISIONAL`;
    } else {
      recoveryLine = base;
    }
  } else {
    recoveryLine = `- Recovery Score: not enough data yet (no HRV reading synced)`;
  }
  const whoopRecoveryLine = ctx.whoopRecovery != null
    ? `\n- WHOOP Recovery (WHOOP's own score, reference only — NOT the score above): ${ctx.whoopRecovery}%`
    : '';
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
- The Recovery Score is Vital's own blend of HRV-vs-baseline and sleep — it is not any device's score. Never describe it as perfect or ideal while the sleep line shows a short night; if the score and the sleep line seem to disagree, lead with the sleep line. If the score is PROVISIONAL or absent, do not give a firm readiness verdict. Quote Vital's score, not WHOOP's — mention WHOOP's only if the user asks or the two differ by more than 20 points.
${recoveryLine}${whoopRecoveryLine}
${hrvLine}
${rhrLine}
${sleepLine}
- Today's Strain so far: ${ctx.strain}
- Weekly Distance: ${ctx.weeklyDistance.toFixed(1)}${distanceUnit} this week
${ctx.lastRun ? `- Last Run: ${ctx.lastRun.distance}${distanceUnit} at ${ctx.lastRun.pace}/${distanceUnit} (${ctx.lastRun.dayTime}) — "${ctx.lastRun.name}"` : '- No recent runs logged'}
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
