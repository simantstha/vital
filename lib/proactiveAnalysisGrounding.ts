import { type CoachAnalysis, parseCoachAnalysis } from './proactiveAnalysisSchema';

export interface ProactiveAnalysisSource {
  kind: 'workout' | 'sleep';
  date: string;
  input: unknown;
  availableContext: unknown;
}

declare const encodedBrand: unique symbol;
export interface EncodedProactiveAnalysisRequest { readonly [encodedBrand]: true }

interface PrivateEncodingState {
  payload: unknown;
  displays: ReadonlyMap<string, string>;
}

const encodings = new WeakMap<object, PrivateEncodingState>();
const TOKEN = /^\{\{EVIDENCE_[A-Z]+\}\}$/;
const TOKENS = /\{\{EVIDENCE_[A-Z]+\}\}/g;
const RAW_NUMBER = /\p{N}/u;
const RESERVED_EVIDENCE = /EVIDENCE_/iu;
const TOKEN_FRAGMENT = /EVIDENCE|\{\{EVID|ENCE_[A-Z]*\}\}/iu;
const NUMBER_START = /[-+.٫\p{N}]/u;
const SOURCE_LEXEME = /^(?:[-+]?(?:(?:\p{Nd}{1,3}(?:[,٬]\p{Nd}{3})+|\p{Nd}+)(?:[.٫]\p{Nd}+)?|[.٫]\p{Nd}+)(?:[eE][-+]?\p{Nd}+)?|[\p{Nl}\p{No}]+)(?:\s*(?:[%٪]|[°℃℉](?:\p{L}+)?|[\p{L}µμ]+)(?:[\/_·*.-][\p{L}µμ%٪]+)*)?/u;

export type AnalysisFailureCategory = 'parse_failure' | 'schema_failure' | 'grounding_failure';

export class AnalysisContentError extends Error {
  constructor(readonly category: AnalysisFailureCategory) {
    super('Proactive analysis content validation failed.');
    this.name = 'AnalysisContentError';
  }
}

declare const proofBrand: unique symbol;
export interface GroundedAnalysisProof { readonly [proofBrand]: true }

const proofs = new WeakMap<object, CoachAnalysis>();

function mintGroundedAnalysisProof(value: CoachAnalysis): GroundedAnalysisProof {
  const proof = Object.freeze({}) as GroundedAnalysisProof;
  proofs.set(proof as object, value);
  return proof;
}

export function consumeGroundedAnalysisProof(proof: GroundedAnalysisProof): CoachAnalysis {
  if (!proof || typeof proof !== 'object') throw new Error('Invalid grounded analysis proof.');
  const value = proofs.get(proof as object);
  if (!value) throw new Error('Invalid grounded analysis proof.');
  proofs.delete(proof as object);
  return value;
}

export function modelPayload(encoded: EncodedProactiveAnalysisRequest): unknown {
  const state = encodings.get(encoded as object);
  if (!state) throw new Error('Invalid encoded proactive analysis request.');
  return state.payload;
}

export function assertNoRawNumbers(content: string): void {
  if (RAW_NUMBER.test(content)) throw new AnalysisContentError('grounding_failure');
}

function stripCompleteJsonFence(text: string): string {
  const fence = text.match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return fence ? fence[1] : text;
}

function authoredStrings(value: CoachAnalysis): string[] {
  return [value.headline, value.shortInsight, value.narrative, ...value.observations, ...value.nextSteps];
}

function validateTokenUse(value: string, displays: ReadonlyMap<string, string>, used: Set<string>): void {
  assertNoRawNumbers(value);
  for (const match of value.matchAll(TOKENS)) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    if (!displays.has(token) || used.has(token)) throw new AnalysisContentError('grounding_failure');
    if (/[{}]/.test(value[start - 1] ?? '') || /[{}]/.test(value[end] ?? '')) {
      throw new AnalysisContentError('grounding_failure');
    }
    used.add(token);
  }
  const scratch = value.replace(TOKENS, '');
  if (TOKEN_FRAGMENT.test(scratch)) throw new AnalysisContentError('grounding_failure');
}

function resolveTokens(value: string, displays: ReadonlyMap<string, string>): string {
  return value.replace(TOKENS, (token) => {
    const display = displays.get(token);
    if (display === undefined) throw new AnalysisContentError('grounding_failure');
    return display;
  });
}

export function groundAnalysisText(text: string, encoded: EncodedProactiveAnalysisRequest): GroundedAnalysisProof {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stripCompleteJsonFence(text));
  } catch {
    throw new AnalysisContentError('parse_failure');
  }

  let validated: CoachAnalysis;
  try {
    validated = parseCoachAnalysis(decoded);
  } catch {
    throw new AnalysisContentError('schema_failure');
  }

  const state = encodings.get(encoded as object);
  if (!state) throw new AnalysisContentError('grounding_failure');

  try {
    const used = new Set<string>();
    for (const value of authoredStrings(validated)) validateTokenUse(value, state.displays, used);
    const resolved = {
      headline: resolveTokens(validated.headline, state.displays),
      shortInsight: resolveTokens(validated.shortInsight, state.displays),
      narrative: resolveTokens(validated.narrative, state.displays),
      observations: validated.observations.map((value) => resolveTokens(value, state.displays)),
      nextSteps: validated.nextSteps.map((value) => resolveTokens(value, state.displays)),
    };
    return mintGroundedAnalysisProof(parseCoachAnalysis(resolved));
  } catch {
    throw new AnalysisContentError('grounding_failure');
  }
}

function alphabeticName(index: number): string {
  let name = '';
  for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
  }
  return name;
}

const KNOWN_EXACT_KEY_UNITS: Readonly<Record<string, string>> = {
  activecalories: 'kcal',
  active_calories: 'kcal',
  activeenergykcal: 'kcal',
  active_energy_kcal: 'kcal',
  avghr: 'bpm',
  avghrv: 'ms',
  basalenergykcal: 'kcal',
  basal_energy_kcal: 'kcal',
  bodymasskg: 'kg',
  caloriesburned: 'kcal',
  calories_burned: 'kcal',
  distancem: 'm',
  durationmin: 'minutes',
  elevationgainm: 'm',
  heartrate: 'bpm',
  heartratevariabilitysdnn: 'ms',
  maxhr: 'bpm',
  paceminperkm: 'min/km',
  paceminmi: 'min/mi',
  paceminpermi: 'min/mi',
  restingheartrate: 'bpm',
  sleepefficiency: '%',
  stepcount: 'steps',
  vo2max: 'ml/kg/min',
  weightkg: 'kg',
};

const KNOWN_KEY_UNIT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:hrv(?:_[a-z]+)*|[a-z]+_hrv(?:_[a-z]+)*|[a-z][a-z0-9_]*_ms)$/, 'ms'],
  [/^(?:heart_rate|average_heart_rate|resting_heart_rate|resting_hr|avg_hr|hr_avg|rhr|max_hr)$/, 'bpm'],
  [/^(?:[a-z]+_)*(?:percent|percentage|efficiency)$/, '%'],
  [/^(?:weight|body_weight|[a-z][a-z0-9_]*_kg)$/, 'kg'],
  [/^(?:energy|calorie|calories|kcal)$/, 'kcal'],
  [/^(?:step|steps|step_count|steps_recorded)$/, 'steps'],
  [/^(?:second|seconds|[a-z][a-z0-9_]*_s)$/, 'seconds'],
  [/^(?:duration|minute|minutes|[a-z][a-z0-9_]*_min|(?:[a-z]+_)*minutes)$/, 'minutes'],
  [/^(?:distance|elevation)(?:_[a-z]+)*_m$/, 'm'],
  [/^pace(?:_min)?_per_km$/, 'min/km'],
  [/^pace(?:_min)?_per_mi$/, 'min/mi'],
  [/^vo2(?:_[a-z]+)*$/, 'ml/kg/min'],
  [/^(?:blood_pressure|systolic|diastolic)$/, 'mmHg'],
];

function inferredUnit(key: string): string | undefined {
  const lower = key.toLowerCase();
  const exact = KNOWN_EXACT_KEY_UNITS[lower];
  if (exact) return exact;
  return KNOWN_KEY_UNIT_PATTERNS.find(([pattern]) => pattern.test(lower))?.[1];
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

export function encodeProactiveAnalysisRequest(source: ProactiveAnalysisSource): EncodedProactiveAnalysisRequest {
  let nextToken = 0;
  const displays = new Map<string, string>();
  const ancestors = new WeakSet<object>();

  const allocate = (display: string): string => {
    const token = `{{EVIDENCE_${alphabeticName(nextToken++)}}}`;
    if (!TOKEN.test(token)) throw new Error('Invalid evidence token.');
    displays.set(token, display);
    return token;
  };

  const encodeString = (value: string): string => {
    if (RESERVED_EVIDENCE.test(value)) throw new Error('Source contains a reserved evidence-token namespace fragment.');
    let encoded = '';
    let remaining = value;
    while (remaining) {
      const index = remaining.search(NUMBER_START);
      if (index < 0) return encoded + remaining;
      encoded += remaining.slice(0, index);
      remaining = remaining.slice(index);
      const match = remaining.match(SOURCE_LEXEME);
      if (!match) {
        encoded += remaining[0];
        remaining = remaining.slice(1);
        continue;
      }
      encoded += allocate(match[0]);
      remaining = remaining.slice(match[0].length);
    }
    return encoded;
  };

  const encodeValue = (value: unknown, key: string, suppliedUnit?: string): unknown => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return encodeString(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Numeric evidence must be finite.');
      const lexeme = String(value);
      const unit = suppliedUnit ?? inferredUnit(key);
      return allocate(unit ? `${lexeme} ${unit}` : lexeme);
    }
    if (typeof value !== 'object') throw new Error(`Unsupported evidence value type: ${typeof value}.`);
    if (ancestors.has(value)) throw new Error('Evidence must not contain cycles.');
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Evidence objects must be plain objects.');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const output: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) throw new Error('Evidence arrays must not be sparse.');
          output.push(encodeValue(value[index], key));
        }
        return output;
      }
      const row = value as Record<string, unknown>;
      const exactUnit = typeof row.value === 'number' && typeof row.unit === 'string' ? row.unit : undefined;
      const metricKey = typeof row.value === 'number' && typeof row.metric === 'string' ? row.metric : undefined;
      const output: Record<string, unknown> = {};
      for (const childKey of Object.keys(row).sort()) {
        const child = row[childKey];
        output[childKey] = childKey === 'value' && typeof child === 'number'
          ? encodeValue(child, metricKey ?? key, exactUnit)
          : encodeValue(child, childKey);
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  };

  const semanticallyOrdered = {
    kind: encodeValue(source.kind, 'kind'),
    date: encodeValue(source.date, 'date'),
    input: encodeValue(source.input, 'input'),
    availableContext: encodeValue(source.availableContext, 'availableContext'),
  };
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(semanticallyOrdered).sort() as Array<keyof typeof semanticallyOrdered>) payload[key] = semanticallyOrdered[key];
  deepFreeze(payload);
  assertNoRawNumbers(JSON.stringify(payload));
  const encoded = payload as unknown as EncodedProactiveAnalysisRequest;
  encodings.set(encoded as object, { payload, displays });
  return encoded;
}
