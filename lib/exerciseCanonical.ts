/**
 * Vital — exercise identity (pure, no I/O)
 *
 * One function, `canonicalExercise(name)`, decides which history a logged
 * exercise belongs to. Every write/read path (voice parser, coach tool,
 * POST /api/workouts/sets, GET /api/workouts/last, repeat-last) funnels
 * through it so "Bench", "bench press" and "BB bench" share one history.
 *
 * Rules:
 *  - Generic spellings of a base lift fold together ("bench", "barbell bench"
 *    -> "bench press").
 *  - Qualified variants stay DISTINCT ("db bench" -> "dumbbell bench press",
 *    "close-grip bench press", "front squat", "romanian deadlift" ...). A
 *    qualifier word never folds into the base lift; only an exact alias hit
 *    counts, never a partial/subsequence match.
 *  - Unknown names are accepted as-is (lowercase, punctuation stripped,
 *    spaces collapsed) with a Title Case display.
 */

/** Canonical name -> alias keys (letters only, lowercase, abbreviations expanded). */
export const EXERCISE_ALIASES: Record<string, string[]> = {
  squat: ['squat', 'squats', 'backsquat', 'backsquats'],
  'front squat': ['frontsquat', 'frontsquats'],
  'goblet squat': ['gobletsquat', 'gobletsquats'],
  'split squat': ['splitsquat', 'splitsquats'],
  'bulgarian split squat': ['bulgariansplitsquat', 'bulgariansplitsquats', 'bulgariansquat', 'bulgariansquats'],
  'paused squat': ['pausedsquat', 'pausedsquats'],
  'smith machine squat': ['smithsquat', 'smithmachinesquat'],
  'bench press': ['bench', 'benchpress', 'benchpresses'],
  'dumbbell bench press': ['dumbbellbench', 'dumbbellbenchpress', 'dumbbellbenchpresses'],
  'incline bench press': ['inclinebench', 'inclinebenchpress', 'inclinebarbellbench', 'inclinebarbellbenchpress'],
  'incline dumbbell bench press': ['inclinedumbbellbench', 'inclinedumbbellbenchpress', 'inclinedumbbellpress'],
  'decline bench press': ['declinebench', 'declinebenchpress'],
  'close-grip bench press': ['closegripbench', 'closegripbenchpress'],
  'paused bench press': ['pausedbench', 'pausedbenchpress'],
  'smith machine bench press': ['smithbench', 'smithbenchpress', 'smithmachinebench', 'smithmachinebenchpress'],
  'machine chest press': ['machinechestpress', 'chestpressmachine'],
  'overhead press': ['ohp', 'overheadpress', 'militarypress', 'strictpress'],
  deadlift: ['dl', 'deadlift', 'deadlifts'],
  'romanian deadlift': ['rdl', 'romaniandeadlift', 'romaniandeadlifts'],
  'sumo deadlift': ['sumodeadlift', 'sumodeadlifts'],
  'trap bar deadlift': ['trapbardeadlift', 'hexbardeadlift'],
  'pull-up': ['pullup', 'pullups'],
  'chin-up': ['chinup', 'chinups'],
  'push-up': ['pushup', 'pushups'],
  dip: ['dip', 'dips'],
  row: ['row', 'rows', 'barbellrow', 'barbellrows', 'bentoverrow', 'bentoverrows'],
  'dumbbell row': ['dumbbellrow', 'dumbbellrows', 'onearmrow', 'onearmdumbbellrow'],
  'cable row': ['cablerow', 'cablerows', 'seatedcablerow', 'seatedrow'],
  'lat pulldown': ['latpulldown', 'latpulldowns', 'pulldown', 'pulldowns'],
  'leg press': ['legpress'],
  'leg curl': ['legcurl', 'legcurls', 'hamstringcurl', 'hamstringcurls'],
  'leg extension': ['legextension', 'legextensions'],
  lunge: ['lunge', 'lunges'],
  'bicep curl': ['bicepcurl', 'bicepcurls', 'bicepscurl', 'bicepscurls', 'curl', 'curls'],
  'dumbbell curl': ['dumbbellcurl', 'dumbbellcurls', 'dumbbellbicepcurl', 'dumbbellbicepcurls'],
  'hammer curl': ['hammercurl', 'hammercurls', 'dumbbellhammercurl', 'dumbbellhammercurls'],
  'tricep extension': ['tricepextension', 'tricepextensions', 'tricepsextension', 'tricepsextensions'],
  'tricep pushdown': ['tricepspushdown', 'tricepspushdowns', 'triceppushdown', 'triceppushdowns'],
  'dumbbell shoulder press': ['dumbbellshoulderpress', 'dumbbellshoulder'],
  'lateral raise': ['lateralraise', 'lateralraises', 'sidelateralraise', 'sidelateralraises', 'dumbbelllateralraise', 'dumbbelllateralraises'],
  'face pull': ['facepull', 'facepulls'],
  'calf raise': ['calfraise', 'calfraises'],
  'hip thrust': ['hipthrust', 'hipthrusts'],
  shrug: ['shrug', 'shrugs'],
  'kettlebell swing': ['kettlebellswing', 'kettlebellswings'],
  plank: ['plank', 'planks'],
};

/**
 * Words that make a movement a different exercise from the base lift. A
 * phrase containing one of these never folds into a shorter alias.
 */
export const QUALIFIER_TOKENS = new Set([
  'dumbbell', 'kettlebell', 'incline', 'decline', 'close', 'closegrip', 'wide', 'split', 'bulgarian',
  'hammer', 'front', 'romanian', 'sumo', 'paused', 'pause', 'smith', 'cable', 'machine', 'goblet',
  'trap', 'hex', 'single', 'one', 'seated', 'standing', 'reverse', 'pendlay', 'deficit', 'rack',
]);

/** Spoken/typed shorthand expanded before lookup. */
const ABBREVIATIONS: Record<string, string> = {
  db: 'dumbbell', dbs: 'dumbbell', dumbbells: 'dumbbell',
  bb: 'barbell',
  kb: 'kettlebell', kbs: 'kettlebell', kettlebells: 'kettlebell',
};

/** Words dropped when what remains is a known lift ("barbell bench", "flat bench"). */
const NOISE_PREFIXES = new Set(['barbell', 'flat', 'standard']);

function letterKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

const ALIAS_LOOKUP: Map<string, string> = new Map();
for (const [canonical, aliases] of Object.entries(EXERCISE_ALIASES)) {
  for (const alias of aliases) ALIAS_LOOKUP.set(alias, canonical);
  ALIAS_LOOKUP.set(letterKey(canonical), canonical);
}

export function tokenizeExercise(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(t => ABBREVIATIONS[t] ?? t);
}

/** Title Case ("close-grip bench press" -> "Close-Grip Bench Press"). */
export function exerciseDisplayName(key: string): string {
  return key
    .split(' ')
    .map(word => word.split('-').map(p => (p ? p[0].toUpperCase() + p.slice(1) : p)).join('-'))
    .join(' ');
}

/** Exact alias lookup on already-tokenized words; null when not a known lift. */
function lookupTokens(tokens: string[]): string | null {
  const direct = ALIAS_LOOKUP.get(tokens.join(''));
  if (direct) return direct;
  // Drop noise prefixes ("barbell bench" -> "bench") only if the rest is known.
  let rest = tokens;
  while (rest.length > 1 && NOISE_PREFIXES.has(rest[0])) {
    rest = rest.slice(1);
    const hit = ALIAS_LOOKUP.get(rest.join(''));
    if (hit) return hit;
  }
  // Trailing plural of the final word.
  const last = rest[rest.length - 1];
  if (last && last.length > 3 && last.endsWith('s') && !last.endsWith('ss')) {
    const singular = [...rest.slice(0, -1), last.slice(0, -1)].join('');
    const hit = ALIAS_LOOKUP.get(singular);
    if (hit) return hit;
  }
  return null;
}

/** Canonical key for a recognised lift, or null for an unknown name. */
export function lookupKnownExercise(name: string): string | null {
  const tokens = tokenizeExercise(name);
  if (tokens.length === 0) return null;
  return lookupTokens(tokens);
}

export interface CanonicalExercise {
  key: string;      // stable identity stored in workout_sets.exercise
  display: string;  // Title Case name for UI / responses
}

/**
 * Map any spelling of an exercise to one identity. Empty/punctuation-only
 * input returns `{ key: '', display: '' }` — callers should reject it.
 */
export function canonicalExercise(name: string): CanonicalExercise {
  const tokens = tokenizeExercise(String(name ?? ''));
  if (tokens.length === 0) return { key: '', display: '' };
  const known = lookupTokens(tokens);
  const key = known ?? tokens.join(' ');
  return { key, display: exerciseDisplayName(key) };
}
