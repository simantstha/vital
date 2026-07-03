/**
 * GET /api/logs?days=3
 *
 * Returns a unified activity log across meal_logged, workout_completed,
 * weight_logged, hrv_reading, and sleep_session events — newest first.
 *
 * Response:
 * {
 *   items: [{
 *     id:        string,
 *     type:      string,
 *     timestamp: string (ISO 8601),
 *     title:     string,
 *     subtitle:  string,
 *   }]
 * }
 */

import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, gte, inArray, desc } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// ── Payload helpers ─────────────────────────────────────────────────────────

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

const LOG_TYPES = ['meal_logged', 'workout_completed', 'weight_logged', 'hrv_reading', 'sleep_session'];

// ── Format helpers per event type ───────────────────────────────────────────

function formatTitle(type: string, payload: unknown): string {
  const p = pl(payload);
  switch (type) {
    case 'meal_logged': {
      const desc = str(p.description) ?? str(p.name) ?? str(p.items) ?? 'Meal';
      const kcal = num(p.kcal) ?? num(p.calories);
      return kcal != null ? `${desc} · ${Math.round(kcal)} kcal` : desc;
    }
    case 'workout_completed': {
      const wtype = str(p.type) ?? str(p.workout_type) ?? 'Workout';
      const label = wtype.charAt(0).toUpperCase() + wtype.slice(1);
      const distM = num(p.distance_m);
      const durS  = num(p.duration_s);
      if (distM != null) return `${label} — ${(distM / 1000).toFixed(1)} km`;
      if (durS  != null) return `${label} — ${Math.round(durS / 60)} min`;
      return label;
    }
    case 'weight_logged': {
      let w = num(p.value) ?? num(p.weight);
      if (w == null) return 'Weight logged';
      const unit = str(p.unit);
      if (unit === 'lbs' || unit === 'lb') w *= 0.453592;
      return `Weight: ${(Math.round(w * 10) / 10).toFixed(1)} kg`;
    }
    case 'hrv_reading': {
      const v = num(p.value) ?? num(p.hrv) ?? num(p.valueMs) ?? num(p.sdnn);
      return v != null ? `HRV: ${Math.round(v)} ms` : 'HRV reading';
    }
    case 'sleep_session': {
      const durMs = num(p.duration_ms) ?? (num(p.duration_s) != null ? num(p.duration_s)! * 1_000 : null);
      return durMs != null ? `Sleep: ${msToHm(durMs)}` : 'Sleep logged';
    }
    default:
      return type;
  }
}

function formatSubtitle(type: string, payload: unknown): string {
  const p = pl(payload);
  switch (type) {
    case 'meal_logged': {
      const parts: string[] = [];
      const c = num(p.c) ?? num(p.carbs);
      const protein = num(p.p) ?? num(p.protein);
      const f = num(p.f) ?? num(p.fat);
      if (c != null)       parts.push(`${Math.round(c)}g carbs`);
      if (protein != null) parts.push(`${Math.round(protein)}g protein`);
      if (f != null)       parts.push(`${Math.round(f)}g fat`);
      return parts.join(' · ') || 'Nutrition logged';
    }
    case 'workout_completed': {
      const parts: string[] = [];
      const calories = num(p.calories);
      const avgHr    = num(p.avg_hr) ?? num(p.average_heart_rate);
      if (calories != null) parts.push(`~${Math.round(calories)} kcal`);
      if (avgHr != null)    parts.push(`avg ${Math.round(avgHr)} bpm`);
      return parts.join(' · ') || 'Workout logged';
    }
    case 'weight_logged':
      return 'Body weight';
    case 'hrv_reading':
      return 'Heart rate variability';
    case 'sleep_session': {
      const eff = num(p.efficiency) ?? num(p.sleep_efficiency);
      const rhr = num(p.rhr) ?? num(p.resting_heart_rate);
      const parts: string[] = [];
      if (eff != null) parts.push(`${Math.round(eff)}% efficiency`);
      if (rhr != null) parts.push(`RHR ${Math.round(rhr)} bpm`);
      return parts.join(' · ') || 'Sleep tracked';
    }
    default:
      return '';
  }
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const days = Math.max(1, Math.min(90, Number(searchParams.get('days') ?? '3')));

  let userId: string;
  try {
    userId = getUserIdFromRequest(request);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 401 });
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  since.setUTCHours(0, 0, 0, 0);

  const events = await db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.user_id, userId),
        gte(schema.events.timestamp, since),
        inArray(schema.events.type, LOG_TYPES),
      ),
    )
    .orderBy(desc(schema.events.timestamp))
    .limit(200);

  const items = events.map(e => {
    const thumb = str(pl(e.payload).imageThumb);
    return {
      id:        e.id,
      type:      e.type,
      timestamp: e.timestamp.toISOString(),
      title:     formatTitle(e.type, e.payload),
      subtitle:  formatSubtitle(e.type, e.payload),
      ...(thumb ? { imageThumb: thumb } : {}),
    };
  });

  return NextResponse.json({ items });
}
