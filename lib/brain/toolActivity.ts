/**
 * Vital Brain — chat activity (tool_call `kind`/`summary`/`sources`/`memory`,
 * and history's done-form `label`).
 *
 * Pure, no DB/network imports — everything here takes an already-computed
 * tool result string (or the parsed-JSON form of it) and derives a small,
 * honest, plain-text description of what happened. None of these functions
 * invent data: every value in a returned string/object traces back to the
 * tool's own input or result.
 *
 * See scratchpad contract "Chat activity contract (server <-> iOS)" for the
 * wire shapes these feed (lib/brain/coach.ts's `tool_call` SSE event and
 * GET /api/coach's `activity` history field).
 */

import type { UnitSystem } from '../units';
import { formatMinutes, formatWeight, LB_PER_KG, roundTo } from '../metricFormat';
import { METRIC_CATALOG, toDisplay } from '../metricCatalog';
import { metricLabel, EVENT_TYPE_LABELS } from './toolLabels';

export type ToolKind = 'data' | 'memory' | 'action' | 'calendar' | 'other';

export interface MemorySource {
  text: string;
  date?: string;
}

export type MemoryOpKind = 'saved' | 'proposed' | 'updated' | 'removed';

export interface MemoryOp {
  op: MemoryOpKind;
  text: string;
  factId?: string;
}

// ── kind ─────────────────────────────────────────────────────────────────────

const MEMORY_TOOLS_SET = new Set([
  'read_memory', 'write_memory', 'append_observation',
  'query_ontology', 'read_entity',
  'remember_fact', 'propose_fact', 'confirm_fact', 'resolve_fact',
]);

const ACTION_TOOLS_SET = new Set([
  'log_meal', 'delete_meal', 'log_weight', 'set_goal_target', 'log_workout', 'update_diet_budget',
]);

const CALENDAR_TOOLS_SET = new Set(['get_schedule']);

const DATA_TOOLS_SET = new Set([
  'get_metric_trend', 'get_weight_trend', 'get_sleep_summary', 'get_workouts',
  'get_baseline', 'compare_periods', 'query_events', 'get_training_history',
  'calculate_macros',
]);

/** Maps a tool name to the contract's `kind` enum. Unknown tools (including
 * the specialist handoff pseudo-tools) fall through to 'other'. */
export function toolKind(name: string): ToolKind {
  if (MEMORY_TOOLS_SET.has(name)) return 'memory';
  if (ACTION_TOOLS_SET.has(name)) return 'action';
  if (CALENDAR_TOOLS_SET.has(name)) return 'calendar';
  if (DATA_TOOLS_SET.has(name)) return 'data';
  return 'other';
}

// ── ok ───────────────────────────────────────────────────────────────────────

/**
 * A tool call is NOT ok when its result text starts with "Error" — the
 * uniform failure marker every tool executor in tools.ts/lib/memory.ts uses
 * on a thrown/guarded failure, including confirm_fact's not-found reply
 * (`` `Error: No pending_fact found with id ${factId}.` `` — see its branch
 * in executeToolCall) — OR when the result parses as a JSON object whose own
 * `ok` field is `false`. Several tools report a failure this second way:
 * valid JSON, no "Error" prefix, but `{ ok: false, ... }` — e.g.
 * resolve_fact's "no matching active fact" and log_workout's
 * needs-clarification/no-history/no-reps replies. Those mean nothing
 * actually happened and must not be reported as a successful step.
 */
export function isToolResultOk(resultString: string): boolean {
  if (resultString.startsWith('Error')) return false;
  const parsed = tryParseJson(resultString);
  if (isRecord(parsed) && parsed.ok === false) return false;
  return true;
}

// ── done-form label (history's `label`) ─────────────────────────────────────

/** Past-tense counterpart of tools.ts's toolCallLabel, for history's
 * `activity[].label` (§3 of the contract) — e.g. "Checked your sleep", not
 * "Looking at your sleep…". */
export function doneLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'query_events':
      return `Checked your ${EVENT_TYPE_LABELS[String(input.type ?? '')] ?? 'recent activity'}`;
    case 'query_ontology':
      return 'Checked what I know about you';
    case 'calculate_macros':
      return 'Calculated your macros';
    case 'update_diet_budget':
      return 'Updated your diet budget';
    case 'remember_fact':
      return 'Remembered that';
    case 'propose_fact':
      return 'Prepared that for your confirmation';
    case 'confirm_fact':
      return 'Updated that';
    case 'resolve_fact':
      return 'Updated your record';
    case 'log_meal':
      return 'Logged your meal';
    case 'delete_meal':
      return 'Removed that';
    case 'log_weight':
      return 'Logged your weigh-in';
    case 'set_goal_target':
      return 'Set your goal';
    case 'get_metric_trend':
      return `Checked your ${metricLabel(String(input.metric ?? ''))} trend`;
    case 'get_weight_trend':
      return 'Checked your weight trend';
    case 'get_sleep_summary':
      return 'Checked your sleep';
    case 'get_workouts':
      return 'Checked your workouts';
    case 'get_baseline':
      return `Checked your ${metricLabel(String(input.metric ?? ''))} baseline`;
    case 'compare_periods':
      return 'Compared periods';
    case 'get_schedule':
      return 'Checked your schedule';
    case 'read_entity':
      return 'Checked what I know about them';
    case 'read_memory':
      return 'Checked my notes on you';
    case 'write_memory':
      return 'Saved that';
    case 'append_observation':
      return 'Jotted that down';
    case 'log_workout':
      return 'Logged your workout';
    case 'get_training_history':
      return 'Checked your training history';
    default:
      return 'Done';
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

/** Capitalizes the first letter only — metricLabel() returns prose-cased
 * strings ("weight", "steps") meant to follow "Checking your…", but a
 * summary line stands alone and reads better sentence-cased. Already-
 * capitalized labels (e.g. "HRV") pass through unchanged. */
function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

function truncate(text: string, max = 60): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function tryParseJson(resultString: string): unknown {
  try {
    return JSON.parse(resultString);
  } catch {
    return undefined;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const TOOL_KINDS: ReadonlySet<ToolKind> = new Set(['data', 'memory', 'action', 'calendar', 'other']);

function isToolKind(v: unknown): v is ToolKind {
  return typeof v === 'string' && TOOL_KINDS.has(v as ToolKind);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Display value + unit for a `daily_metrics` metric name, converting
 * `body_mass_kg` for an imperial user the same way lib/brain/coachViz.ts
 * does — reused here (not imported, to avoid a runtime dependency) so this
 * module stays a pure leaf. */
function displayMetricValue(
  metric: string,
  value: number,
  unitSystem: UnitSystem,
): { value: number; unit: string } {
  if (metric === 'body_mass_kg' && unitSystem === 'imperial') {
    return { value: Math.round(value * LB_PER_KG), unit: 'lb' };
  }
  const spec = METRIC_CATALOG[metric];
  if (!spec) return { value: roundTo(value, 1) ?? value, unit: '' };
  return { value: toDisplay(metric, value), unit: spec.displayUnit === 'count' ? '' : spec.displayUnit };
}

const MEMORY_FILE_LABELS: Record<string, string> = {
  'memory-index.md':        'memory index',
  'core-profile.md':        'core profile',
  'coach-observations.md':  'observations',
  'health-conditions.json': 'health conditions',
  'training-history.json':  'training history',
  'nutrition-habits.json':  'nutrition habits',
  'life-context.json':      'life context',
  'lab-results.json':       'lab results',
  'user-profile.md':        'user profile',
};

function memoryFileLabel(filename: string): string {
  return MEMORY_FILE_LABELS[filename] ?? filename;
}

// ── toolResultSummary ────────────────────────────────────────────────────────

/**
 * Pure, ≤60-char, honest one-line summary of a tool's result — reuses
 * lib/metricFormat.ts/lib/metricCatalog.ts for units, never fabricates a
 * number or quote. Returns undefined when there's nothing meaningful to say
 * (no data, a failure isToolResultOk didn't already gate out, an
 * unrecognized shape) — callers omit `summary` in that case.
 */
export function toolResultSummary(
  name: string,
  input: Record<string, unknown>,
  resultString: string,
  unitSystem: UnitSystem = 'metric',
): string | undefined {
  if (!isToolResultOk(resultString)) return undefined;

  switch (name) {
    case 'get_sleep_summary': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed)) return undefined;
      const nights = Array.isArray(parsed.nights) ? parsed.nights : [];
      if (nights.length === 0) return undefined;
      const mean = num(parsed.meanMinutes);
      const avg = mean != null ? formatMinutes(mean) : null;
      return avg
        ? truncate(`Last ${nights.length} night${nights.length === 1 ? '' : 's'} · avg ${avg}`)
        : truncate(`Last ${nights.length} night${nights.length === 1 ? '' : 's'}`);
    }

    case 'get_workouts': {
      const parsed = tryParseJson(resultString);
      if (!Array.isArray(parsed)) return undefined;
      const days = Number(input.days ?? 7);
      return truncate(`${parsed.length} workout${parsed.length === 1 ? '' : 's'} · last ${days} days`);
    }

    case 'get_metric_trend': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed)) return undefined;
      const metric = String(parsed.metric ?? '');
      const points = Array.isArray(parsed.points) ? parsed.points : [];
      if (points.length === 0) return undefined;
      const lastPoint = points[points.length - 1] as Record<string, unknown>;
      const latest = num(lastPoint?.value);
      if (latest == null) return undefined;
      const dv = displayMetricValue(metric, latest, unitSystem);
      const label = capitalize(metricLabel(metric));
      const unitSuffix = dv.unit ? ` ${dv.unit}` : '';
      const direction = parsed.direction;
      const dirWord = direction === 'above' ? 'above baseline'
        : direction === 'below' ? 'below baseline'
        : direction === 'similar' ? 'near baseline'
        : null;
      return truncate(`${label}: ${dv.value}${unitSuffix}${dirWord ? ` · ${dirWord}` : ''}`);
    }

    case 'get_weight_trend': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed)) return undefined;
      const days = Array.isArray(parsed.days) ? parsed.days as Array<Record<string, unknown>> : [];
      if (days.length === 0) return undefined;
      const last = days[days.length - 1];
      const trendKg = num(last?.trendKg);
      if (trendKg == null) return undefined;
      const w = formatWeight(trendKg, unitSystem);
      const delta = num(parsed.delta7dKgPerWeek);
      if (w == null || delta == null) return w ? truncate(w) : undefined;
      const deltaDisplay = unitSystem === 'imperial'
        ? `${(delta * LB_PER_KG).toFixed(1)} lb/wk`
        : `${delta.toFixed(1)} kg/wk`;
      const sign = delta > 0 ? '+' : '';
      return truncate(`${w} · ${sign}${deltaDisplay}`);
    }

    case 'get_baseline': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed)) return undefined;
      if (!parsed.established || !isRecord(parsed.stats)) return undefined;
      const metric = String(parsed.metric ?? '');
      const p25 = num(parsed.stats.p25);
      const p75 = num(parsed.stats.p75);
      if (p25 == null || p75 == null) return undefined;
      const dvLo = displayMetricValue(metric, p25, unitSystem);
      const dvHi = displayMetricValue(metric, p75, unitSystem);
      const label = capitalize(metricLabel(metric));
      const unitSuffix = dvHi.unit ? ` ${dvHi.unit}` : '';
      return truncate(`${label} normal ${dvLo.value}–${dvHi.value}${unitSuffix}`);
    }

    case 'compare_periods': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed)) return undefined;
      const metric = String(parsed.metric ?? '');
      const deltaPct = num(parsed.deltaPct);
      if (deltaPct == null) return undefined;
      const label = capitalize(metricLabel(metric));
      const periodDays = Number(parsed.periodDays ?? input.periodDays ?? 7);
      const sign = deltaPct > 0 ? '+' : '';
      return truncate(`${label} ${sign}${Math.round(deltaPct)}% vs prior ${periodDays}d`);
    }

    case 'query_events': {
      const parsed = tryParseJson(resultString);
      if (!Array.isArray(parsed)) return undefined;
      const type = String(input.type ?? '');
      const days = Number(input.rangeDays ?? 7);
      const label = EVENT_TYPE_LABELS[type] ?? 'entries';
      return truncate(`${parsed.length} ${label} · last ${days}d`);
    }

    case 'get_training_history': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed)) return undefined;
      if (typeof parsed.exercise === 'string' && Array.isArray(parsed.sets)) {
        if (parsed.sets.length === 0) return undefined;
        return truncate(`${parsed.sets.length} sets · ${parsed.exercise}`);
      }
      if (Array.isArray(parsed.exercises)) {
        if (parsed.exercises.length === 0) return undefined;
        return truncate(`${parsed.exercises.length} exercises tracked`);
      }
      return undefined;
    }

    case 'calculate_macros': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || !isRecord(parsed.macros)) return undefined;
      const targetCal = num(parsed.targetCal);
      const c = num(parsed.macros.c);
      const p = num(parsed.macros.p);
      const f = num(parsed.macros.f);
      if (targetCal == null) return undefined;
      return truncate(`${targetCal} kcal · ${c ?? 0}C/${p ?? 0}P/${f ?? 0}F`);
    }

    case 'log_meal': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true) return undefined;
      const kcal = num(parsed.kcal);
      return kcal != null ? truncate(`Logged · ${kcal} kcal`) : undefined;
    }

    case 'delete_meal': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true) return undefined;
      const mealName = typeof parsed.name === 'string' ? parsed.name : 'meal';
      return truncate(`Removed · ${mealName}`);
    }

    case 'log_weight': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true) return undefined;
      const valueKg = num(parsed.valueKg);
      if (valueKg == null) return undefined;
      const w = formatWeight(valueKg, unitSystem);
      return w ? truncate(`Logged · ${w}`) : undefined;
    }

    case 'set_goal_target': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true) return undefined;
      const bits: string[] = [];
      const kg = num(parsed.targetWeightKg);
      if (kg != null) {
        const w = formatWeight(kg, unitSystem);
        if (w) bits.push(w);
      }
      if (typeof parsed.targetDate === 'string') bits.push(`by ${parsed.targetDate}`);
      const sessions = num(parsed.weeklySessionsTarget);
      if (sessions != null) bits.push(`${sessions}x/week`);
      return bits.length ? truncate(`Goal set · ${bits.join(' ')}`) : undefined;
    }

    case 'log_workout': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true || !Array.isArray(parsed.sets)) return undefined;
      const sets = parsed.sets as Array<Record<string, unknown>>;
      if (sets.length === 0) return undefined;
      const exercise = typeof parsed.exercise === 'string'
        ? parsed.exercise
        : (typeof sets[0]?.exercise === 'string' ? sets[0].exercise : null);
      return truncate(`Logged · ${sets.length} set${sets.length === 1 ? '' : 's'}${exercise ? ` ${exercise}` : ''}`);
    }

    case 'update_diet_budget': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.budget)) return undefined;
      const targetKcal = num(parsed.budget.targetKcal);
      return targetKcal != null ? truncate(`Budget updated · ${targetKcal} kcal`) : undefined;
    }

    case 'get_schedule': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || !Array.isArray(parsed.busy)) return undefined;
      const days = Math.max(1, Math.min(14, Math.round(Number(input.days ?? 3))));
      return truncate(`${parsed.busy.length} event${parsed.busy.length === 1 ? '' : 's'} over next ${days}d`);
    }

    case 'query_ontology': {
      const parsed = tryParseJson(resultString);
      if (!Array.isArray(parsed)) return undefined;
      return truncate(`${parsed.length} note${parsed.length === 1 ? '' : 's'}`);
    }

    case 'read_entity': {
      if (resultString.startsWith('No entity')) return undefined;
      const match = /^# (.+)$[\s\S]*?· (\d+) fact/m.exec(resultString);
      if (!match) return undefined;
      const [, label, count] = match;
      return truncate(`${label} · ${count} fact${count === '1' ? '' : 's'}`);
    }

    case 'read_memory': {
      if (/not found\.$/.test(resultString)) return undefined;
      return truncate(`Reviewed ${memoryFileLabel(String(input.filename ?? ''))}`);
    }

    case 'write_memory': {
      if (resultString !== 'Memory updated.') return undefined;
      return truncate(`Updated ${memoryFileLabel(String(input.filename ?? ''))}`);
    }

    case 'append_observation': {
      if (resultString !== 'Observation appended.') return undefined;
      const note = typeof input.note === 'string' ? input.note : '';
      return note ? truncate(`Noted: ${note}`) : undefined;
    }

    case 'remember_fact': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true) return undefined;
      const label = typeof parsed.label === 'string' ? parsed.label : '';
      return label ? truncate(`Noted: ${label}`) : undefined;
    }

    case 'propose_fact': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true) return undefined;
      const label = typeof input.label === 'string' ? input.label : '';
      return label ? truncate(`Proposed: ${label}`) : undefined;
    }

    case 'confirm_fact': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true) return undefined;
      return parsed.status === 'confirmed' ? 'Confirmed' : 'Rejected';
    }

    case 'resolve_fact': {
      const parsed = tryParseJson(resultString);
      if (!isRecord(parsed) || parsed.ok !== true || parsed.resolved !== true) return undefined;
      const label = typeof parsed.label === 'string' ? parsed.label : '';
      return label ? truncate(`Removed: ${label}`) : undefined;
    }

    default:
      return undefined;
  }
}

// ── memory sources (reads) ───────────────────────────────────────────────────

const MAX_SOURCES = 3;
const SOURCE_TEXT_MAX = 140;

/** For memory READS (read_memory, query_ontology, read_entity): the specific
 * notes/facts the tool returned, most relevant first, at most 3. Returns
 * undefined for every other tool, or when the read found nothing. */
export function extractMemorySources(name: string, resultString: string): MemorySource[] | undefined {
  if (!isToolResultOk(resultString)) return undefined;

  if (name === 'query_ontology') {
    const parsed = tryParseJson(resultString);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const sources: MemorySource[] = [];
    for (const row of parsed.slice(0, MAX_SOURCES)) {
      if (!isRecord(row)) continue;
      const properties = isRecord(row.properties) ? row.properties : null;
      const evidence = properties && typeof properties.evidence === 'string' ? properties.evidence : '';
      const label = typeof row.label === 'string' ? row.label : '';
      const text = evidence || label;
      if (!text) continue;
      const createdAt = typeof row.created_at === 'string' ? row.created_at.slice(0, 10) : undefined;
      sources.push({ text: truncate(text, SOURCE_TEXT_MAX), ...(createdAt ? { date: createdAt } : {}) });
    }
    return sources.length > 0 ? sources : undefined;
  }

  if (name === 'read_entity') {
    if (resultString.startsWith('No entity')) return undefined;
    const factRe = /^- (.+)\n\s+evidence: "([^"]*)"\n\s+source: .*? recorded (\d{4}-\d{2}-\d{2})/gm;
    const sources: MemorySource[] = [];
    let m: RegExpExecArray | null;
    while ((m = factRe.exec(resultString)) && sources.length < MAX_SOURCES) {
      const [, label, evidence, date] = m;
      const text = evidence || label;
      if (!text) continue;
      sources.push({ text: truncate(text, SOURCE_TEXT_MAX), date });
    }
    return sources.length > 0 ? sources : undefined;
  }

  if (name === 'read_memory') {
    if (/not found\.$/.test(resultString)) return undefined;
    const lines = resultString
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('```'));
    const sources = lines.slice(0, MAX_SOURCES).map((l) => ({ text: truncate(l, SOURCE_TEXT_MAX) }));
    return sources.length > 0 ? sources : undefined;
  }

  return undefined;
}

// ── memory op (writes) ───────────────────────────────────────────────────────

/** For memory WRITES: what changed, in one honest line, plus (only for
 * remember_fact) the id `POST /api/memory/facts/{factId}/undo` accepts.
 * Returns undefined for every other tool, or when the write didn't happen. */
export function extractMemoryOp(
  name: string,
  input: Record<string, unknown>,
  resultString: string,
): MemoryOp | undefined {
  if (!isToolResultOk(resultString)) return undefined;

  if (name === 'remember_fact') {
    const parsed = tryParseJson(resultString);
    if (!isRecord(parsed) || parsed.ok !== true) return undefined;
    const label = typeof parsed.label === 'string' ? parsed.label : '';
    const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId : undefined;
    if (!label) return undefined;
    return { op: 'saved', text: truncate(label, SOURCE_TEXT_MAX), ...(nodeId ? { factId: nodeId } : {}) };
  }

  if (name === 'write_memory') {
    if (resultString !== 'Memory updated.') return undefined;
    const filename = String(input.filename ?? '');
    return { op: 'saved', text: truncate(`Updated ${memoryFileLabel(filename)}`, SOURCE_TEXT_MAX) };
  }

  if (name === 'append_observation') {
    if (resultString !== 'Observation appended.') return undefined;
    const note = typeof input.note === 'string' ? input.note : '';
    if (!note) return undefined;
    return { op: 'saved', text: truncate(note, SOURCE_TEXT_MAX) };
  }

  if (name === 'propose_fact') {
    const parsed = tryParseJson(resultString);
    if (!isRecord(parsed) || parsed.ok !== true) return undefined;
    const label = typeof input.label === 'string' ? input.label : '';
    const factId = typeof parsed.factId === 'string' ? parsed.factId : undefined;
    if (!label) return undefined;
    return { op: 'proposed', text: truncate(label, SOURCE_TEXT_MAX), ...(factId ? { factId } : {}) };
  }

  if (name === 'confirm_fact') {
    const parsed = tryParseJson(resultString);
    if (!isRecord(parsed) || parsed.ok !== true) return undefined;
    const text = parsed.status === 'confirmed' ? 'Fact confirmed' : 'Fact rejected';
    return { op: 'updated', text };
  }

  if (name === 'resolve_fact') {
    const parsed = tryParseJson(resultString);
    if (!isRecord(parsed) || parsed.ok !== true || parsed.resolved !== true) return undefined;
    const label = typeof parsed.label === 'string' ? parsed.label : '';
    if (!label) return undefined;
    return { op: 'removed', text: truncate(label, SOURCE_TEXT_MAX) };
  }

  return undefined;
}

// ── history: activity from a persisted messages.tool_calls jsonb value ─────

/** One step of an assistant message's `activity` (§3 of the contract). */
export interface ActivityStep {
  name: string;
  label: string;
  kind: ToolKind;
  ok?: boolean;
  summary?: string;
  sources?: MemorySource[];
  memory?: MemoryOp;
}

function isMemorySourceArray(v: unknown): v is MemorySource[] {
  return Array.isArray(v) && v.every((s) => isRecord(s) && typeof s.text === 'string');
}

function isMemoryOpShape(v: unknown): v is MemoryOp {
  return isRecord(v) && typeof v.text === 'string' &&
    (v.op === 'saved' || v.op === 'proposed' || v.op === 'updated' || v.op === 'removed');
}

/**
 * Derives GET /api/coach's `activity` array from one assistant message's
 * persisted `tool_calls` jsonb value, without a schema change (§3 of the
 * contract). An entry written before this feature only ever has `{name,
 * input?}` — no `label`/`kind`/etc — so those are derived the same way the
 * live SSE path would have: `doneLabel`/`toolKind` from `name` (+ `input`
 * when present). An entry written by the new persistence path (coach.ts)
 * already carries every field, and those stored values are trusted as-is
 * (they were themselves derived from a real tool result, never invented).
 * Returns undefined when the message had no tool calls, so `activity` is
 * omitted entirely rather than serialized as `[]` or `null`.
 */
export function deriveActivityFromToolCalls(toolCalls: unknown): ActivityStep[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;

  const activity: ActivityStep[] = [];
  for (const entry of toolCalls) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    const name = entry.name;
    const input = isRecord(entry.input) ? entry.input : {};
    const label = typeof entry.label === 'string' ? entry.label : doneLabel(name, input);
    const kind = isToolKind(entry.kind) ? entry.kind : toolKind(name);

    const step: ActivityStep = { name, label, kind };
    if (typeof entry.ok === 'boolean') step.ok = entry.ok;
    if (typeof entry.summary === 'string') step.summary = entry.summary;
    if (isMemorySourceArray(entry.sources)) step.sources = entry.sources;
    if (isMemoryOpShape(entry.memory)) step.memory = entry.memory;
    activity.push(step);
  }

  return activity.length > 0 ? activity : undefined;
}
