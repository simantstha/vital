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
const RAW_NUMBER = /\p{N}/u;
const RESERVED_EVIDENCE = /EVIDENCE_/iu;
const NUMBER_START = /[-+\p{N}]/u;
const SOURCE_LEXEME = /^(?:[-+]?(?:(?:\p{Nd}{1,3}(?:[,٬]\p{Nd}{3})+|\p{Nd}+)(?:[.٫]\p{Nd}+)?|[.٫]\p{Nd}+)(?:[eE][-+]?\p{Nd}+)?|[\p{Nl}\p{No}]+)(?:\s*(?:[%٪]|[°℃℉](?:\p{L}+)?|[\p{L}µμ]+)(?:[\/_·*.-][\p{L}µμ%٪]+)*)?/u;

export type AnalysisFailureCategory = 'parse_failure' | 'schema_failure' | 'grounding_failure';

export class AnalysisContentError extends Error {
  constructor(readonly category: AnalysisFailureCategory) {
    super('Proactive analysis content validation failed.');
    this.name = 'AnalysisContentError';
  }
}

export function modelPayload(encoded: EncodedProactiveAnalysisRequest): unknown {
  const state = encodings.get(encoded as object);
  if (!state) throw new Error('Invalid encoded proactive analysis request.');
  return state.payload;
}

export function assertNoRawNumbers(content: string): void {
  if (RAW_NUMBER.test(content)) throw new AnalysisContentError('grounding_failure');
}

function alphabeticName(index: number): string {
  let name = '';
  for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
  }
  return name;
}

function inferredUnit(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (lower.includes('vo2')) return 'ml/kg/min';
  if (lower.includes('blood_pressure') || lower.includes('systolic') || lower.includes('diastolic')) return 'mmHg';
  if (lower.includes('pace') && /per_?km|perkm/.test(lower)) return 'min/km';
  if (lower.includes('pace') && /per_?mi|permi/.test(lower)) return 'min/mi';
  if (lower.includes('hrv') || lower.endsWith('_ms') || lower.endsWith('ms')) return 'ms';
  if (lower.includes('heart_rate') || ['rhr', 'resting_hr', 'avg_hr', 'hr_avg', 'avghr', 'maxhr'].includes(lower) || lower.endsWith('avghr') || lower.endsWith('maxhr')) return 'bpm';
  if (lower.includes('percent') || lower.includes('percentage') || lower.includes('efficiency')) return '%';
  if (lower.includes('weight') || lower.endsWith('_kg')) return 'kg';
  if (lower.includes('calorie') || lower.includes('kcal') || lower.includes('energy')) return 'kcal';
  if (lower.includes('step')) return 'steps';
  if (lower.includes('duration') || lower.includes('minute') || lower.endsWith('_min') || lower.endsWith('min')) return 'minutes';
  if (lower.endsWith('_s') || lower.endsWith('seconds') || lower.includes('second')) return 'seconds';
  if ((lower.includes('distance') || lower.includes('elevation')) && (lower.endsWith('_m') || lower.endsWith('m'))) return 'm';
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
