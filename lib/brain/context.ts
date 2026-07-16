/**
 * Vital Brain — context assembler
 *
 * assembleContext(userId) deterministically pulls structured data from Postgres
 * and returns a CoachContext with both a structured object and a compact text
 * block ready for Claude prompt injection.
 *
 * Design principle: numbers come from SQL, never from LLM inference.
 *
 * Phase 3 (tool-first data access): the prompt carries only small durable
 * facts — profile/ontology, a baselines snapshot, calibration status, and
 * today's numbers. Multi-day time-series (trends, sleep history, workout
 * lists, period comparisons) is deliberately NOT pre-computed here anymore —
 * the coach reads that on demand via the get_metric_trend / get_sleep_summary /
 * get_workouts / get_baseline / compare_periods tools in lib/brain/tools.ts.
 */

import { db, schema } from '@/db';
import { eq, and, gte, desc } from 'drizzle-orm';
import type { OntologyNode } from '@/db/schema';
import { getCalibration, type Calibration } from './baselines';
import {
  queryAllBaselines, metricLabel, type BaselineSnapshot,
  queryScheduleWindow, formatScheduleLine, type ScheduleBlock,
} from './tools';
import { resolveDietBudget, type DietBudget } from './dietBudget';
import { getCachedBrief, briefCacheKey, type CachedBrief } from './briefCache';
import { getConversationStart } from './conversationWindow';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkoutSummary {
  type: string;
  durationS?: number;
  distanceM?: number;
  calories?: number;
  avgHr?: number;
}

export interface MealSummary {
  kcal: number;
  c: number;   // carbs g
  p: number;   // protein g
  f: number;   // fat g
  description?: string;
}

export interface DaySnapshot {
  date: string;              // YYYY-MM-DD (UTC)
  hrv?: number;              // ms
  sleepDurationMs?: number;
  sleepEfficiency?: number;  // 0–100
  rhr?: number;              // bpm
  steps?: number;
  workouts: WorkoutSummary[];
  meals: MealSummary[];
  weight?: number;           // kg
}

export interface CoachContext {
  userId: string;
  today: DaySnapshot;
  localNow: string;                 // human-readable current date/time in the user's timezone, e.g. "Wednesday, July 15, 2026, 6:33 PM CDT"
  timezone: string;                 // IANA id backing localNow + schedule rendering; 'UTC' when unset/invalid
  schedule: ScheduleBlock[];        // calendar_blocks in the next 48h, if the user has synced
  recentMessages: Array<{ role: string; content: string; timestamp: Date }>;
  hardConstraints: OntologyNode[];  // Allergy, Condition, Medication, Injury
  softFacts: OntologyNode[];        // Goal, Habit, FoodPreference, etc.
  baselines: BaselineSnapshot[];    // one row per metric with a baselines row
  calibration: Calibration;         // gates recovery/training prescriptions
  dietBudget?: DietBudget;          // effective calorie/macro targets (auto or pinned)
  cachedBrief?: CachedBrief;        // today's app-generated insight + meal plan, if warm
  promptText: string;               // compact text block ready for Claude
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HARD_CONSTRAINT_TYPES = new Set(['Allergy', 'Condition', 'Medication', 'Injury']);

// ── Payload helpers ───────────────────────────────────────────────────────────

/** Safe JSONB → object cast. */
function pl(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function msToHm(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m < 10 ? '0' : ''}${m}m`;
}

// ── Day snapshot builder ──────────────────────────────────────────────────────

/** Build a DaySnapshot from a set of events (expected ordered desc by timestamp). */
function buildDaySnapshot(
  dateStr: string,
  events: Array<typeof schema.events.$inferSelect>,
): DaySnapshot {
  const snap: DaySnapshot = { date: dateStr, workouts: [], meals: [] };

  for (const e of events) {
    const p = pl(e.payload);

    if (e.type === 'hrv_reading' && snap.hrv == null) {
      const v = num(p.value) ?? num(p.hrv);
      if (v != null) snap.hrv = Math.round(v);
    }

    if (e.type === 'sleep_session' && snap.sleepDurationMs == null) {
      const dur =
        num(p.duration_ms) ??
        (num(p.duration_s) != null ? num(p.duration_s)! * 1_000 : undefined);
      if (dur != null) snap.sleepDurationMs = dur;

      const eff = num(p.efficiency) ?? num(p.sleep_efficiency);
      if (eff != null) snap.sleepEfficiency = Math.round(eff);

      const rhr = num(p.rhr) ?? num(p.resting_heart_rate);
      if (rhr != null) snap.rhr = Math.round(rhr);
    }

    if (e.type === 'steps_recorded') {
      // Take the largest value seen — HealthKit may send cumulative deltas
      const c = num(p.count) ?? num(p.steps);
      if (c != null && (snap.steps == null || c > snap.steps)) snap.steps = Math.round(c);
    }

    if (e.type === 'workout_completed') {
      snap.workouts.push({
        type:      str(p.type) ?? str(p.workout_type) ?? 'workout',
        durationS: num(p.duration_s),
        distanceM: num(p.distance_m),
        calories:  num(p.calories) ?? num(p.active_calories),
        avgHr:     num(p.avg_hr) ?? num(p.average_heart_rate),
      });
    }

    if (e.type === 'meal_logged') {
      snap.meals.push({
        kcal:        Math.round(num(p.kcal) ?? num(p.calories) ?? 0),
        c:           Math.round(num(p.c) ?? num(p.carbs) ?? 0),
        p:           Math.round(num(p.p) ?? num(p.protein) ?? 0),
        f:           Math.round(num(p.f) ?? num(p.fat) ?? 0),
        description: str(p.description) ?? str(p.items),
      });
    }

    if (e.type === 'weight_logged' && snap.weight == null) {
      let wkg = num(p.value) ?? num(p.weight);
      if (wkg != null) {
        const unit = str(p.unit);
        if (unit === 'lbs' || unit === 'lb') wkg *= 0.453592;
        snap.weight = Math.round(wkg * 10) / 10;
      }
    }
  }

  return snap;
}

// ── Compact text builder ──────────────────────────────────────────────────────

function buildPromptText(
  ctx: Omit<CoachContext, 'promptText'>,
): string {
  const lines: string[] = ['## Vital Context'];

  // ── Today ──────────────────────────────────────────────────────────────────
  lines.push(`\n### Today — ${ctx.localNow}`);

  if (ctx.today.hrv != null)
    lines.push(`- HRV: ${ctx.today.hrv}ms`);
  if (ctx.today.rhr != null)
    lines.push(`- Resting HR: ${ctx.today.rhr}bpm`);
  if (ctx.today.sleepDurationMs != null) {
    const effStr =
      ctx.today.sleepEfficiency != null
        ? `, efficiency ${ctx.today.sleepEfficiency}%`
        : '';
    lines.push(`- Sleep: ${msToHm(ctx.today.sleepDurationMs)}${effStr}`);
  }
  if (ctx.today.steps != null)
    lines.push(`- Steps so far: ${ctx.today.steps.toLocaleString()}`);
  if (ctx.today.weight != null)
    lines.push(`- Weight: ${ctx.today.weight}kg`);

  if (ctx.today.workouts.length > 0) {
    for (const w of ctx.today.workouts) {
      const dist  = w.distanceM != null ? ` ${(w.distanceM / 1000).toFixed(1)}km` : '';
      const dur   = w.durationS != null ? ` ${Math.round(w.durationS / 60)}min` : '';
      const hr    = w.avgHr != null ? ` avg HR ${w.avgHr}bpm` : '';
      const cal   = w.calories != null ? ` ~${w.calories}kcal` : '';
      lines.push(`- Workout: ${w.type}${dist}${dur}${hr}${cal}`);
    }
  }

  const mealTotal = ctx.today.meals.reduce(
    (a, m) => ({ kcal: a.kcal + m.kcal, c: a.c + m.c, p: a.p + m.p, f: a.f + m.f }),
    { kcal: 0, c: 0, p: 0, f: 0 },
  );

  if (ctx.today.meals.length > 0) {
    lines.push(
      `- Meals logged today: ${ctx.today.meals.length}, ` +
      `${mealTotal.kcal}kcal (${mealTotal.c}g C / ${mealTotal.p}g P / ${mealTotal.f}g F)`,
    );
  } else {
    lines.push('- No meals logged today yet');
  }

  // ── Diet Budget — source of truth for calorie/macro targets ────────────────
  if (ctx.dietBudget) {
    const b = ctx.dietBudget;
    lines.push('\n### Diet Budget');
    lines.push(
      `- Mode: ${b.mode}${b.mode === 'auto' ? ' (auto-calculated)' : ' (user-pinned)'}, goal: ${b.goal}`,
    );
    lines.push(
      `- Target: ${b.targetKcal} kcal (${b.carbs}g C / ${b.protein}g P / ${b.fat}g F)`,
    );
    lines.push(`- Remaining today: ${b.targetKcal - mealTotal.kcal} kcal`);
  }

  // ── Schedule (next 48h calendar_blocks, if the user has synced) ────────────
  lines.push('\n### Schedule');
  if (ctx.schedule.length === 0) {
    lines.push('- No calendar synced yet');
  } else {
    for (const block of ctx.schedule.slice(0, 12)) {
      lines.push(formatScheduleLine(block, ctx.timezone));
    }
  }

  // ── App's meal plan for today (only if the daily brief cache is warm) ──────
  if (ctx.cachedBrief?.plan && ctx.cachedBrief.plan.length > 0) {
    lines.push("\n### App's meal plan for today");
    for (const item of ctx.cachedBrief.plan) {
      lines.push(`- ${item.name} · ${item.kcal} kcal · ${item.why}`);
    }
  }

  // ── Baselines snapshot (small durable facts — full history is tool-only) ───
  if (ctx.baselines.length > 0) {
    lines.push('\n### Baselines');
    for (const b of ctx.baselines) {
      const mean30Str = b.stats?.mean30 != null ? `${Math.round(b.stats.mean30)}` : 'n/a';
      lines.push(
        `- ${metricLabel(b.metric)} (${b.metric}): 30-day avg ${mean30Str}, ` +
        `${b.dataDays} days of data in the last 90d` +
        `${b.established ? ', established' : ', not yet established'}`,
      );
    }
  } else {
    lines.push('\n### Baselines\nNo baseline data yet — brand-new user, no history to compare against.');
  }

  // ── Calibration ──────────────────────────────────────────────────────────
  lines.push(`\n### Calibration: ${ctx.calibration.status}`);
  if (ctx.calibration.status === 'calibrating') {
    const parts = Object.entries(ctx.calibration.metrics).map(
      ([m, v]) => `${metricLabel(m)} ${v.dataDays}/14 days`,
    );
    lines.push(
      `Not yet established: ${parts.join(', ')}. Avoid recovery scores or training ` +
      `prescriptions until calibration is ready — say so plainly if asked.`,
    );
  }

  // ── Recent conversation ────────────────────────────────────────────────────
  if (ctx.recentMessages.length > 0) {
    lines.push('\n### Current Conversation (last 20 messages, chronological)');
    for (const m of ctx.recentMessages) {
      const preview =
        m.content.length > 300 ? m.content.slice(0, 300) + '…' : m.content;
      lines.push(`[${m.role}] ${preview}`);
    }
  }

  // ── Ontology ───────────────────────────────────────────────────────────────
  lines.push('\n### Ontology');
  if (ctx.hardConstraints.length > 0) {
    lines.push('HARD CONSTRAINTS (never violate):');
    for (const n of ctx.hardConstraints) {
      lines.push(`- ${n.type}: ${n.label} (weight ${n.weight.toFixed(2)})`);
    }
  } else {
    lines.push('No hard constraints on file.');
  }
  if (ctx.softFacts.length > 0) {
    lines.push('GOALS & PREFERENCES:');
    for (const n of ctx.softFacts.slice(0, 20)) {
      lines.push(`- ${n.type}: ${n.label} (weight ${n.weight.toFixed(2)})`);
    }
  }

  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function assembleContext(userId: string): Promise<CoachContext> {
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  // Only messages within the current conversation (since the last 4h
  // inactivity gap or manual "New chat" reset) are eligible for the prompt —
  // see lib/brain/conversationWindow.ts. Computed up front since the messages
  // query below depends on it.
  const conversationStart = await getConversationStart(db, userId, now);

  const in48h = new Date(now.getTime() + 48 * 3_600_000);

  // Run all queries in parallel for minimal latency. Only today's events are
  // fetched here — multi-day history lives behind the data tools (tools.ts),
  // not pre-computed into the prompt (Phase 3 tool-first design rule). The
  // schedule is the one exception: a small "next 48h" snapshot is worth the
  // prompt tokens so the coach doesn't need a tool round-trip for "am I free
  // this afternoon" — the full range stays tool-only via get_schedule.
  const [todayEvents, allNodes, rawMessages, baselines, calibration, [usersRow], schedule] = await Promise.all([
    db.select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.user_id, userId),
          gte(schema.events.timestamp, todayStart),
        ),
      )
      .orderBy(desc(schema.events.timestamp)),

    db.select()
      .from(schema.nodes)
      .where(eq(schema.nodes.user_id, userId))
      .orderBy(desc(schema.nodes.weight)),

    db.select({
        role:      schema.messages.role,
        content:   schema.messages.content,
        timestamp: schema.messages.timestamp,
      })
      .from(schema.messages)
      .where(
        conversationStart
          ? and(eq(schema.messages.user_id, userId), gte(schema.messages.timestamp, conversationStart))
          : eq(schema.messages.user_id, userId),
      )
      .orderBy(desc(schema.messages.timestamp))
      .limit(20),

    queryAllBaselines(userId),
    getCalibration(userId),
    db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1),
    queryScheduleWindow(userId, now, in48h),
  ]);

  // Compute user's local date/time in their timezone
  const tz = usersRow?.timezone ?? 'UTC';
  const nowFormat: Intl.DateTimeFormatOptions = {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  };
  let localNow: string;
  try {
    localNow = new Intl.DateTimeFormat('en-US', { ...nowFormat, timeZone: tz }).format(now);
  } catch {
    // invalid IANA id stored in DB — fall back to UTC
    localNow = new Intl.DateTimeFormat('en-US', { ...nowFormat, timeZone: 'UTC' }).format(now);
  }

  // Today snapshot
  const todayStr = todayStart.toISOString().split('T')[0];
  const today = buildDaySnapshot(todayStr, todayEvents);

  // Ontology partition
  const hardConstraints = allNodes.filter(n => HARD_CONSTRAINT_TYPES.has(n.type));
  const softFacts       = allNodes.filter(n => !HARD_CONSTRAINT_TYPES.has(n.type));

  // Messages in chronological order for the prompt
  const recentMessages = [...rawMessages].reverse();

  // Diet budget + today's cached brief (meal plan) — assembleContext has no
  // request timezone, so we key the brief lookup off the same UTC day used
  // for `today` above (best-effort; exact match when the brief was warmed
  // via /api/today or /api/brief on the same UTC day).
  const dietBudget  = usersRow ? await resolveDietBudget(usersRow, userId) : undefined;
  const cachedBrief = getCachedBrief(briefCacheKey(userId, todayStr));

  const partial: Omit<CoachContext, 'promptText'> = {
    userId,
    today,
    localNow,
    timezone: tz,
    schedule,
    recentMessages,
    hardConstraints,
    softFacts,
    baselines,
    calibration,
    dietBudget,
    cachedBrief,
  };

  return { ...partial, promptText: buildPromptText(partial) };
}
