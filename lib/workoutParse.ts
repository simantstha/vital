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
 *  - Exercise identity lives in lib/exerciseCanonical.ts (shared with the
 *    HTTP routes). Unknown exercise names are accepted as-is rather than
 *    rejected; the parser still fails when there is no rep count at all.
 *  - Deliberately conservative about numbers: never invents a set count or
 *    rep count, caps sets at MAX_SETS, and an ambiguous bare term ("press")
 *    asks a follow-up question instead of guessing.
 */

import {
  EXERCISE_ALIASES,
  QUALIFIER_TOKENS,
  canonicalExercise,
  lookupKnownExercise,
  tokenizeExercise,
} from '@/lib/exerciseCanonical';

// ── Units ───────────────────────────────────────────────────────────────────

export const LB_TO_KG = 0.45359237;

export function lbToKg(lb: number): number {
  return lb * LB_TO_KG;
}

/** Most sets a single phrase may expand to. */
export const MAX_SETS = 10;

/** In "N x M", N above this is read as a load, not a set count. */
const LOAD_THRESHOLD = 20;

/** Ambiguous bare terms that could refer to more than one canonical exercise. */
const AMBIGUOUS_TERMS: Record<string, string[]> = {
  press: ['bench press', 'overhead press', 'leg press'],
  pulldown: ['lat pulldown'],
};

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
  exercise: string;          // canonical key, e.g. "bench press"
  exerciseDisplay: string;   // canonical display, e.g. "Bench Press"
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
  reason: 'unrecognized_exercise' | 'no_exercise' | 'no_reps' | 'too_many_sets';
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

const UNIT = '(?:kg|kgs|kilograms?|lb|lbs|pounds?)';
const NUM = '(\\d+(?:\\.\\d+)?)';

// Keyword-led load: "at 225", "@ 140kg" — unit optional.
const LOAD_KEYWORD_RE =
  /\b(?:at|@)\s*(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)?\b/i;
// Unit-led load with no keyword: "225 lb", "100kg".
const LOAD_UNIT_RE = /(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)\b/i;

// "<load> x <reps> x <sets>": "225x5x3", "100 kg x 5 x 3"
const LOAD_REPS_SETS_RE = new RegExp(`(?<![\\d.])${NUM}\\s*(${UNIT})?\\s*[x×]\\s*(\\d+)\\s*[x×]\\s*(\\d+)(?!\\d)`, 'i');
// "<load> x <reps>": "225x5", "100 kg x 5"  (gated on load-ness below)
const LOAD_X_REPS_RE = new RegExp(`(?<![\\d.])${NUM}\\s*(${UNIT})?\\s*[x×]\\s*(\\d+)(?!\\d)`, 'i');
// "<load> for <reps>": "225 for 5", "225 lb for 5 reps"
const LOAD_FOR_REPS_RE = new RegExp(`(?<![\\d.])${NUM}\\s*(${UNIT})?\\s+for\\s+(\\d+)(?!\\d)`, 'i');

const SETS_OF_RE = /\b(\d+)\s*sets?\s+of\s+(\d+)\b/i;
const SETS_X_RE = /\b(\d+)\s*[x×]\s*(\d+)\b/i;
const SETS_BY_RE = /\b(\d+)\s+by\s+(\d+)\b/i;
const BARE_REPS_RE = /\b(\d+)\s*reps?\b|\b(\d+)\b/i;

const FILLER_WORDS = new Set([
  'i', 'did', 'just', 'today', 'this', 'morning', 'now', 'and', 'a', 'an',
  'the', 'for', 'reps', 'rep', 'set', 'sets', 'of', 'at', 'with', 'x',
]);

function isKgUnit(unit: string | undefined): boolean | null {
  if (!unit) return null;
  const u = unit.toLowerCase();
  if (u.startsWith('kg') || u.startsWith('kilogram')) return true;
  if (u.startsWith('lb') || u.startsWith('pound')) return false;
  return null;
}

function toKg(value: number, unit: string | undefined, defaultUnit: 'kg' | 'lb'): number {
  const unitIsKg = isKgUnit(unit);
  const kg = unitIsKg === null ? (defaultUnit === 'kg' ? value : lbToKg(value)) : unitIsKg ? value : lbToKg(value);
  return Math.round(kg * 100) / 100;
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
  const phrase = stripFiller(phraseRaw).replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim();
  if (!phrase) return null;
  const key = normalizeToken(phrase);
  if (!key) return null;

  if (Object.prototype.hasOwnProperty.call(AMBIGUOUS_TERMS, key)) {
    return { ambiguous: AMBIGUOUS_TERMS[key] };
  }

  // Whole phrase is a known lift (qualifiers already respected: exact match only).
  const exact = lookupKnownExercise(phrase);
  if (exact) return { canonical: exact, display: canonicalExercise(exact).display };

  // Descriptive extras ("heavy bench press today" -> "bench press"). A window
  // may only fold when the leftover words carry no qualifier — otherwise
  // "paused ... bench" style variants would be swallowed by the base lift.
  const words = phrase.split(/\s+/);
  for (let start = 0; start < words.length; start++) {
    for (let end = words.length; end > start; end--) {
      const windowWords = words.slice(start, end);
      const candidateKey = normalizeToken(windowWords.join(''));
      if (!candidateKey) continue;
      const rest = [...words.slice(0, start), ...words.slice(end)];
      const restHasQualifier = rest.some(w => tokenizeExercise(w).some(t => QUALIFIER_TOKENS.has(t)));
      if (restHasQualifier) continue;
      if (windowWords.length < words.length && Object.prototype.hasOwnProperty.call(AMBIGUOUS_TERMS, candidateKey)) {
        return { ambiguous: AMBIGUOUS_TERMS[candidateKey] };
      }
      const hit = lookupKnownExercise(windowWords.join(' '));
      if (hit) return { canonical: hit, display: canonicalExercise(hit).display };
    }
  }

  // Unknown movement: accept as-is under its normalized identity.
  const generic = canonicalExercise(phrase);
  if (!generic.key || !/[a-z]/.test(generic.key)) return null;
  return { canonical: generic.key, display: generic.display };
}

/**
 * Parse a natural-language strength-training phrase into an exercise + sets.
 * Pure function — no DB, no network. See module doc for design rationale.
 */
export function parseWorkoutPhrase(text: string, options: ParseWorkoutOptions): ParsedWorkout {
  const defaultUnit = options.defaultUnit;

  if (!text || !text.trim()) {
    return { ok: false, reason: 'no_exercise', message: 'No workout description given.' };
  }
  let working = ` ${text.trim().toLowerCase()} `;

  // 1. RPE (must come before load — "rpe 8" would otherwise look like a bare number)
  let rpe: number | null = null;
  const rpeMatch = working.match(RPE_RE);
  if (rpeMatch) {
    rpe = Number(rpeMatch[1]);
    working = working.replace(rpeMatch[0], ' ');
  }

  let loadKg: number | null = null;
  let setsCount: number | null = null;
  let reps: number | null = null;
  const hasKeywordLoad = LOAD_KEYWORD_RE.test(working);

  // 2. Load-first phrasings: "225x5x3", "225x5", "225 for 5". The leading
  // number is a load only if it carries a unit or exceeds LOAD_THRESHOLD;
  // otherwise "3x5" stays sets x reps.
  const isLoadLead = (value: number, unit: string | undefined) => unit !== undefined || value > LOAD_THRESHOLD;

  const lrs = working.match(LOAD_REPS_SETS_RE);
  if (lrs && isLoadLead(Number(lrs[1]), lrs[2])) {
    loadKg = toKg(Number(lrs[1]), lrs[2], defaultUnit);
    reps = Number(lrs[3]);
    setsCount = Number(lrs[4]);
    working = working.replace(lrs[0], ' ');
  }

  if (reps === null) {
    const lxr = hasKeywordLoad ? null : working.match(LOAD_X_REPS_RE);
    if (lxr && isLoadLead(Number(lxr[1]), lxr[2])) {
      loadKg = toKg(Number(lxr[1]), lxr[2], defaultUnit);
      reps = Number(lxr[3]);
      setsCount = 1;
      working = working.replace(lxr[0], ' ');
    }
  }

  if (reps === null) {
    const lfr = hasKeywordLoad ? null : working.match(LOAD_FOR_REPS_RE);
    if (lfr && isLoadLead(Number(lfr[1]), lfr[2])) {
      loadKg = toKg(Number(lfr[1]), lfr[2], defaultUnit);
      reps = Number(lfr[3]);
      setsCount = 1;
      working = working.replace(lfr[0], ' ');
    }
  }

  // 3. Keyword-led / unit-led load, then sets x reps.
  if (reps === null) {
    const loadKeywordMatch = working.match(LOAD_KEYWORD_RE);
    const loadMatch = loadKeywordMatch ?? working.match(LOAD_UNIT_RE);
    if (loadMatch) {
      loadKg = toKg(Number(loadMatch[1]), loadMatch[2], defaultUnit);
      working = working.replace(loadMatch[0], ' ');
    }

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
  }

  if (reps === null || setsCount === null || !Number.isFinite(reps) || reps <= 0 || setsCount <= 0) {
    return {
      ok: false,
      reason: 'no_reps',
      message: `Couldn't find a rep count in "${text}". Try e.g. "3x5 squat at 225" or "20 pushups".`,
    };
  }

  if (setsCount > MAX_SETS) {
    return {
      ok: false,
      reason: 'too_many_sets',
      message: `That's ${setsCount} sets — I log at most ${MAX_SETS} at a time. If you meant a weight, try "225 for 5" or "squat at 225, 3x5".`,
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
