/**
 * Vital — natural-language strength-training phrase parser (pure, no I/O)
 *
 * Turns a spoken/typed phrase like "3 by 5 squat at 225" into a normalized
 * exercise name plus a list of sets (reps + load in kg). Backs the
 * `log_workout` coach tool (lib/brain/tools.ts) so a set can be logged by
 * voice — see docs/ux-spec-v4.md §5.4 and roadmap-v4-general-coach.md 1.3.
 *
 * Design:
 *  - All storage is metric (load_kg), matching db/schema.ts's convention
 *    (lib/units.ts: DB values are always metric; imperial is a display
 *    concern only). This module converts lb → kg at parse time.
 *  - Deliberately conservative: an input this can't confidently resolve to
 *    exactly one exercise returns `{ ok: false, reason: 'ambiguous', ... }`
 *    with candidate exercises for the caller to ask a follow-up question,
 *    rather than guessing (ux-spec §5.4: "Vital asks one question with 2
 *    chips"). Never invents a set count, rep count, or exercise.
 */

// ── Units ───────────────────────────────────────────────────────────────────

export const LB_TO_KG = 0.45359237;

export function lbToKg(lb: number): number {
  return lb * LB_TO_KG;
}

// ── Exercise alias map ───────────────────────────────────────────────────────
// Canonical name -> list of surface forms (already normalized: lowercase,
// letters only — see normalizeToken below). Distinct movements are kept as
// distinct canonical entries even when colloquially related (pull-up vs.
// chin-up: different grip, different exercise — never merged).

const EXERCISE_ALIASES: Record<string, string[]> = {
  squat: ['squat', 'squats', 'backsquat', 'backsquats'],
  'front squat': ['frontsquat', 'frontsquats'],
  'goblet squat': ['gobletsquat', 'gobletsquats'],
  'bench press': ['bench', 'benchpress', 'benchpresses'],
  'incline bench press': ['inclinebench', 'inclinebenchpress'],
  'overhead press': ['ohp', 'overheadpress', 'militarypress', 'strictpress'],
  deadlift: ['dl', 'deadlift', 'deadlifts'],
  'romanian deadlift': ['rdl', 'romaniandeadlift', 'romaniandeadlifts'],
  'sumo deadlift': ['sumodeadlift', 'sumodeadlifts'],
  'pull-up': ['pullup', 'pullups'],
  'chin-up': ['chinup', 'chinups'],
  'push-up': ['pushup', 'pushups'],
  row: ['row', 'rows', 'barbellrow', 'barbellrows', 'bentoverrow', 'bentoverrows'],
  'lat pulldown': ['latpulldown', 'latpulldowns', 'pulldown', 'pulldowns'],
  'leg press': ['legpress'],
  'leg curl': ['legcurl', 'legcurls', 'hamstringcurl', 'hamstringcurls'],
  'leg extension': ['legextension', 'legextensions'],
  lunge: ['lunge', 'lunges'],
  'bicep curl': ['bicepcurl', 'bicepcurls', 'curl', 'curls'],
  'tricep extension': ['tricepextension', 'tricepextensions'],
  'dumbbell shoulder press': ['dumbbellshoulderpress', 'dbshoulderpress'],
  plank: ['plank', 'planks'],
};

/** Ambiguous bare terms that could refer to more than one canonical exercise. */
const AMBIGUOUS_TERMS: Record<string, string[]> = {
  press: ['bench press', 'overhead press', 'leg press'],
  squat: [], // handled specially below only when qualifier conflicts; kept for documentation
  pulldown: ['lat pulldown'],
};

// Build the reverse lookup: normalized alias token -> canonical name.
const ALIAS_LOOKUP: Map<string, string> = new Map();
for (const [canonical, aliases] of Object.entries(EXERCISE_ALIASES)) {
  for (const alias of aliases) ALIAS_LOOKUP.set(alias, canonical);
  ALIAS_LOOKUP.set(normalizeToken(canonical), canonical);
}

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

// ── Parsed types ─────────────────────────────────────────────────────────────

export interface ParsedSet {
  reps: number;
  loadKg: number | null;
  rpe: number | null;
}

export interface ParsedWorkoutOk {
  ok: true;
  exercise: string;          // canonical, e.g. "squat"
  exerciseDisplay: string;   // as the user said it, e.g. "Squats"
  sets: ParsedSet[];
}

export interface ParsedWorkoutAmbiguous {
  ok: false;
  reason: 'ambiguous';
  message: string;
  candidates: string[];
}

export interface ParsedWorkoutUnrecognized {
  ok: false;
  reason: 'unrecognized_exercise' | 'no_exercise' | 'no_reps';
  message: string;
}

export type ParsedWorkout = ParsedWorkoutOk | ParsedWorkoutAmbiguous | ParsedWorkoutUnrecognized;

export interface ParseWorkoutOptions {
  /**
   * Unit assumed for a bare load number with no explicit "kg"/"lb" (e.g. "at
   * 225"). Required — deliberately no silent default, since defaulting to lb
   * for everyone would misload a metric user's "3x5 squat at 100" as 45kg.
   * Callers pass the user's display unit (lib/units.ts's resolveUnitSystem:
   * 'imperial' -> 'lb', else 'kg'). An explicit unit in the text ("100 kg",
   * "225 lb") always overrides this.
   */
  defaultUnit: 'kg' | 'lb';
}

// ── Regexes ──────────────────────────────────────────────────────────────────

const RPE_RE = /\brpe\s*[:=]?\s*(\d+(?:\.\d+)?)\b/i;

// Keyword-led load: "at 225", "@ 140kg" — unit optional.
const LOAD_KEYWORD_RE =
  /\b(?:at|@)\s*(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)?\b/i;
// Unit-led load with no keyword: "225 lb", "100kg".
const LOAD_UNIT_RE = /(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)\b/i;

const SETS_OF_RE = /\b(\d+)\s*sets?\s+of\s+(\d+)\b/i;
const SETS_X_RE = /\b(\d+)\s*[x×]\s*(\d+)\b/i;
const SETS_BY_RE = /\b(\d+)\s+by\s+(\d+)\b/i;
const BARE_REPS_RE = /\b(\d+)\s*reps?\b|\b(\d+)\b/i;

const FILLER_WORDS = new Set([
  'i', 'did', 'just', 'today', 'this', 'morning', 'now', 'and', 'a', 'an',
  'the', 'for', 'reps', 'rep', 'set', 'sets',
]);

function isKgUnit(unit: string | undefined): boolean | null {
  if (!unit) return null;
  const u = unit.toLowerCase();
  if (u.startsWith('kg') || u.startsWith('kilogram')) return true;
  if (u.startsWith('lb') || u.startsWith('pound')) return false;
  return null;
}

function stripFiller(text: string): string {
  return text
    .split(/\s+/)
    .filter(w => w.length > 0 && !FILLER_WORDS.has(w.toLowerCase()))
    .join(' ')
    .trim();
}

/** Resolve a free-text exercise phrase to a canonical name, or an ambiguity/miss. */
function resolveExercise(
  phraseRaw: string,
): { canonical: string; display: string } | { ambiguous: string[] } | null {
  const display = stripFiller(phraseRaw).trim();
  if (!display) return null;

  const key = normalizeToken(display);
  if (!key) return null;

  if (Object.prototype.hasOwnProperty.call(AMBIGUOUS_TERMS, key)) {
    const candidates = AMBIGUOUS_TERMS[key];
    if (candidates.length > 0) return { ambiguous: candidates };
  }

  const canonical = ALIAS_LOOKUP.get(key);
  if (canonical) return { canonical, display };

  // Try matching on individual words (e.g. "back squats today" after filler
  // strip is "back squats" — full-phrase key "backsquats" already matches
  // above; this second pass covers extra descriptive words the alias map
  // doesn't carry, e.g. "heavy bench press" -> "bench press").
  const words = display.split(/\s+/);
  for (let start = 0; start < words.length; start++) {
    for (let end = words.length; end > start; end--) {
      const candidateKey = normalizeToken(words.slice(start, end).join(''));
      if (!candidateKey) continue;
      if (Object.prototype.hasOwnProperty.call(AMBIGUOUS_TERMS, candidateKey)) {
        const candidates = AMBIGUOUS_TERMS[candidateKey];
        if (candidates.length > 0) return { ambiguous: candidates };
      }
      const hit = ALIAS_LOOKUP.get(candidateKey);
      if (hit) return { canonical: hit, display: words.slice(start, end).join(' ') };
    }
  }

  return null;
}

/**
 * Parse a natural-language strength-training phrase into an exercise + sets.
 * Pure function — no DB, no network. See module doc for design rationale.
 */
export function parseWorkoutPhrase(text: string, options: ParseWorkoutOptions): ParsedWorkout {
  const defaultUnit = options.defaultUnit;
  let working = ` ${text.trim().toLowerCase()} `;

  if (!text || !text.trim()) {
    return { ok: false, reason: 'no_exercise', message: 'No workout description given.' };
  }

  // 1. RPE (must come before load — "rpe 8" would otherwise look like a bare number)
  let rpe: number | null = null;
  const rpeMatch = working.match(RPE_RE);
  if (rpeMatch) {
    rpe = Number(rpeMatch[1]);
    working = working.replace(rpeMatch[0], ' ');
  }

  // 2. Load (keyword-led first, then unit-led)
  let loadKg: number | null = null;
  const loadKeywordMatch = working.match(LOAD_KEYWORD_RE);
  const loadMatch = loadKeywordMatch ?? working.match(LOAD_UNIT_RE);
  if (loadMatch) {
    const value = Number(loadMatch[1]);
    const unitIsKg = isKgUnit(loadMatch[2]);
    const kg = unitIsKg === null ? (defaultUnit === 'kg' ? value : lbToKg(value)) : unitIsKg ? value : lbToKg(value);
    loadKg = Math.round(kg * 100) / 100;
    working = working.replace(loadMatch[0], ' ');
  }

  // 3. Sets x reps (try the most specific patterns first)
  let setsCount: number | null = null;
  let reps: number | null = null;
  const setsOfMatch = working.match(SETS_OF_RE);
  const xMatch = !setsOfMatch ? working.match(SETS_X_RE) : null;
  const byMatch = !setsOfMatch && !xMatch ? working.match(SETS_BY_RE) : null;
  const combo = setsOfMatch ?? xMatch ?? byMatch;
  if (combo) {
    setsCount = Number(combo[1]);
    reps = Number(combo[2]);
    working = working.replace(combo[0], ' ');
  } else {
    const bareMatch = working.match(BARE_REPS_RE);
    if (bareMatch) {
      reps = Number(bareMatch[1] ?? bareMatch[2]);
      setsCount = 1;
      working = working.replace(bareMatch[0], ' ');
    }
  }

  if (reps === null || setsCount === null || !Number.isFinite(reps) || reps <= 0) {
    return {
      ok: false,
      reason: 'no_reps',
      message: `Couldn't find a rep count in "${text}". Try e.g. "3x5 squat at 225" or "20 pushups".`,
    };
  }

  // 4. Whatever's left is the exercise phrase
  const resolved = resolveExercise(working);
  if (resolved === null) {
    return {
      ok: false,
      reason: 'no_exercise',
      message: `Couldn't find an exercise name in "${text}".`,
    };
  }
  if ('ambiguous' in resolved) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `Which one did you mean: ${resolved.ambiguous.join(' or ')}?`,
      candidates: resolved.ambiguous,
    };
  }

  const sets: ParsedSet[] = Array.from({ length: setsCount }, () => ({
    reps: reps!,
    loadKg,
    rpe,
  }));

  return {
    ok: true,
    exercise: resolved.canonical,
    exerciseDisplay: resolved.display,
    sets,
  };
}

/** Canonical exercise names this parser recognizes (for validation / UI chips). */
export function knownExercises(): string[] {
  return Object.keys(EXERCISE_ALIASES);
}
