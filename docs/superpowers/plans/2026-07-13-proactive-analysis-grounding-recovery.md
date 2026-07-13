# Proactive Analysis Evidence-Token Grounding and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-visible health numbers with opaque evidence tokens, resolve only valid token use into the unchanged `CoachAnalysis` schema, require a one-shot runtime proof before queued or morning-brief output can be used, and preserve the already-correct exact-nine recovery.

**Architecture:** Move the public analysis shape and exact validator into a dependency-light schema module, then put canonical input encoding, outbound guarding, token validation/resolution, and the private one-shot proof registry in a focused grounding module. The generation module encodes once and permits one content repair without replaying rejected text; queued analyses and morning briefs consume the resolver-minted proof at their existing ownership boundaries before persistence or delivery.

**Tech Stack:** TypeScript, Node.js 22, `node:test`, Anthropic SDK, Drizzle ORM 0.45, PostgreSQL, esbuild, Next.js 16

## Global Constraints

- Default proactive generation to exactly `claude-sonnet-4-6`; preserve the `PROACTIVE_ANALYSIS_MODEL` override.
- The canonical model payload contains exactly analysis kind and date, job input, and available context; sort object keys, preserve array order, and reject cycles, non-JSON values, and non-finite numbers before any model call.
- Replace every finite JSON number and every complete numeric lexeme in source strings with a distinct deterministic token matching exactly `/^\{\{EVIDENCE_[A-Z]+\}\}$/`; tokens contain no digits and disclose no source meaning or identifier.
- Known health fields may use typed input-side path/key formatters to append their defined unit. Source strings preserve their exact numeric lexeme and exact adjacent source unit text. Unknown numeric fields remain explicitly unitless. Never calculate, normalize, round, convert, or group a source value.
- Every model-visible initial and repair system/user string must pass a raw-number guard using Unicode numeric-code-point detection before transport. The model identifier is transport metadata and is excluded.
- The model may copy a known token only once and only into `headline`, `shortInsight`, `narrative`, an `observations` item, or a `nextSteps` item. Reject raw numbers, unknown/duplicate/malformed/partial/split/nested/concatenated tokens, and token use anywhere else.
- Parse JSON, validate the exact public schema, prove token use, resolve exact source display text atomically, and validate the resolved schema again, in that order.
- The grounding module alone mints runtime-verifiable proofs in module-private state. Proof consumption verifies membership, consumes once, and returns only clean `CoachAnalysis`; casts, copies, spreads, serialization, and fabrication must fail.
- `runClaimedAnalysis` and the morning-brief path accept only resolver-minted proofs. Consume immediately before the existing queued persistence boundary or owned morning completion boundary.
- Permit exactly one repair call only after `parse_failure`, `schema_failure`, or `grounding_failure`. Repair reuses the same encoded request and fixed category, omits rejected model text and exception text, and passes the same outbound guard. Transport, authentication, timeout, and no-text failures do not repair.
- Diagnostics contain only attempt, fixed category, and fixed outcome. Never log prompts, source displays, token values/maps/counts, model text, exceptions, identifiers, request IDs, or health/database content.
- Preserve analysis leases, status-and-token compare-and-set persistence, retry/backoff and terminal failure, morning-slot ownership, notification sequencing/preferences, APNs behavior, queue ordering, sleep reservation, and the public/database `CoachAnalysis` shape.
- Leave `lib/proactiveAnalysisRecovery.ts`, `lib/proactiveAnalysisRecoveryDrizzle.ts`, their tests, `scripts/recover-proactive-analysis-jobs.ts`, and the package recovery command behavior unchanged, including the operator-injected `Date` used as transaction time.
- Do not add schema changes, migrations, dependencies, production UUIDs, or an automatic recovery invocation.
- Work only on `feat/fix-proactive-analysis-grounding`; never push or merge `main`.

---

## File Map

- Create `lib/proactiveAnalysisSchema.ts`: unchanged public `CoachAnalysis` type, field limits, and exact `parseCoachAnalysis` validator.
- Create `lib/proactiveAnalysisSchema.test.ts`: exact-shape and post-resolution length regression tests.
- Create `lib/proactiveAnalysisGrounding.ts`: canonical encoder, typed input display adapters, outbound guard, token proof/resolution, and private runtime-proof registry.
- Create `lib/proactiveAnalysisGrounding.test.ts`: exhaustive encoding, outbound, token, resolution, and proof tests.
- Modify `lib/proactiveAnalysisGeneration.ts`: token-only prompts, fixed failure classification, one encoded request, one guarded repair, proof return type, and privacy-safe events.
- Modify `lib/proactiveAnalysisGeneration.test.ts`: bounded initial/repair tests using tokenized requests and runtime proofs; delete obsolete raw-number/unit-scanner expectations.
- Modify `lib/proactiveHealthWorker.ts`: remove the output-side numeric/unit scanner, re-export the schema API, consume a fresh proof before lease renewal and persistence, and expose a small owned morning-analysis helper.
- Modify `lib/proactiveHealthWorker.test.ts`: proof-forgery, lease, retry, persistence, and notification regressions; remove obsolete scanner tests.
- Modify `scripts/proactive-health-worker.ts`: use the proof-returning analyzer for queued jobs and morning briefs, consuming the morning proof immediately before owned completion.
- Verify unchanged `lib/proactiveHealthLeaseSemantics.test.ts`, `lib/proactiveAnalysisRecovery.test.ts`, and `lib/proactiveAnalysisRecoveryDrizzle.test.ts` as ownership and exact-nine regression coverage.

---

### Task 1: Extract the Exact Public Schema and Encode the Complete Model Payload

**Files:**
- Create: `lib/proactiveAnalysisSchema.ts`
- Create: `lib/proactiveAnalysisSchema.test.ts`
- Create: `lib/proactiveAnalysisGrounding.ts`
- Create: `lib/proactiveAnalysisGrounding.test.ts`
- Modify: `lib/proactiveHealthWorker.ts:3-163`
- Modify: `lib/proactiveHealthWorker.test.ts:1-89`

**Interfaces:**
- Produces: `CoachAnalysis` and `parseCoachAnalysis(value: unknown): CoachAnalysis` from `lib/proactiveAnalysisSchema.ts`.
- Produces: `ProactiveAnalysisSource = { kind: 'workout' | 'sleep'; date: string; input: unknown; availableContext: unknown }`.
- Produces: opaque `EncodedProactiveAnalysisRequest`, `encodeProactiveAnalysisRequest(source)`, `modelPayload(encoded)`, and `assertNoRawNumbers(content)`.
- Produces: `AnalysisFailureCategory = 'parse_failure' | 'schema_failure' | 'grounding_failure'` and `AnalysisContentError`; the outbound guard throws the fixed `grounding_failure` category.
- Preserves: imports from `lib/proactiveHealthWorker.ts` through explicit re-exports of `CoachAnalysis` and `parseCoachAnalysis`.
- Establishes: module-private `WeakMap<EncodedProactiveAnalysisRequest, PrivateEncodingState>`; no token map or source display is exported or serializable.

- [ ] **Step 1: Write failing schema and encoder tests**

Create `lib/proactiveAnalysisSchema.test.ts` with the current exact-schema assertions moved out of the worker test:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCoachAnalysis } from './proactiveAnalysisSchema';

const valid = {
  headline: 'A useful signal',
  shortInsight: 'Recovery held steady.',
  narrative: 'Available data suggests a steady day.',
  observations: ['Sleep duration was recorded.'],
  nextSteps: ['Keep today comfortable.'],
};

test('accepts only the unchanged CoachAnalysis shape and limits', () => {
  assert.deepEqual(parseCoachAnalysis(valid), valid);
  assert.throws(() => parseCoachAnalysis({ ...valid, invented: true }), /unexpected field/);
  assert.throws(() => parseCoachAnalysis({ ...valid, observations: [''] }), /observations/);
  assert.throws(() => parseCoachAnalysis({ ...valid, headline: 'x'.repeat(121) }), /headline/);
  assert.throws(() => parseCoachAnalysis({ ...valid, nextSteps: Array(6).fill('Rest') }), /nextSteps/);
});
```

Create the first section of `lib/proactiveAnalysisGrounding.test.ts`. Use `structuredClone`-safe inputs and assert:

```ts
const source = {
  kind: 'workout' as const,
  date: '2026-07-13',
  input: {
    nested: [{ metric: 'hrv_sdnn', value: 45 }, { distance_m: 5 }],
    summary: 'Duration: 2 hours; temperature 37.5°C; score 1,000.',
    duplicate: 45,
  },
  availableContext: { enabled: true, timezone: 'UTC-5', profile: {}, baselines: {}, metrics: [] },
};

const valid = {
  headline: 'A useful signal', shortInsight: 'Recovery held steady.',
  narrative: 'Available data suggests a steady day.',
  observations: ['Sleep duration was recorded.'], nextSteps: ['Keep today comfortable.'],
};

test('encodes every number in date input and context deterministically', () => {
  const left = modelPayload(encodeProactiveAnalysisRequest(source));
  const right = modelPayload(encodeProactiveAnalysisRequest(source));
  assert.deepEqual(left, right);
  const serialized = JSON.stringify(left);
  assert.doesNotMatch(serialized, /\p{N}/u);
  const tokens = serialized.match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
  assert.equal(tokens.length, new Set(tokens).size);
  assert.ok(tokens.length >= 10);
});

test('sorts object keys but preserves array order', () => {
  const encoded = modelPayload(encodeProactiveAnalysisRequest({
    kind: 'sleep', date: 'date', input: { z: 1, a: 2 }, availableContext: [{ value: 3 }, { value: 4 }],
  })) as Record<string, unknown>;
  assert.deepEqual(Object.keys(encoded), ['availableContext', 'date', 'input', 'kind']);
  assert.deepEqual(Object.keys(encoded.input as object), ['a', 'z']);
  assert.notEqual(JSON.stringify(encoded.availableContext).indexOf('EVIDENCE_C'), -1);
});

test('rejects non-JSON and non-finite input before transport', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const input of [cycle, { value: Number.NaN }, { value: Infinity }, { value: 1n }, { value: undefined }, { value: () => 1 }]) {
    assert.throws(() => encodeProactiveAnalysisRequest({ kind: 'workout', date: 'date', input, availableContext: {} }));
  }
});

test('the outbound guard rejects every Unicode numeric code point', () => {
  for (const content of ['raw 45', 'raw ٤٥', 'raw Ⅻ', 'raw ²']) assert.throws(() => assertNoRawNumbers(content));
  assert.doesNotThrow(() => assertNoRawNumbers('Use {{EVIDENCE_ALPHA}} only.'));
});
```

Also assert that identical displays at different paths receive different tokens, source objects are not mutated, token names contain only uppercase ASCII letters, source token-like strings are rejected as reserved namespace collisions, and `JSON.stringify(encoded)` exposes only the encoded payload—not a token map or source display text.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveAnalysisSchema.test.ts lib/proactiveAnalysisGrounding.test.ts
```

Expected: exit `1` because both new modules are missing.

- [ ] **Step 3: Extract the schema without changing its public behavior**

Create `lib/proactiveAnalysisSchema.ts` with the existing limits and validator verbatim:

```ts
export interface CoachAnalysis {
  headline: string;
  shortInsight: string;
  narrative: string;
  observations: string[];
  nextSteps: string[];
}

const limits: Record<keyof CoachAnalysis, number> = {
  headline: 120, shortInsight: 240, narrative: 1200, observations: 6, nextSteps: 5,
};

export function parseCoachAnalysis(value: unknown): CoachAnalysis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coach output must be an object');
  const row = value as Record<string, unknown>;
  const expected = Object.keys(limits);
  for (const key of Object.keys(row)) if (!expected.includes(key)) throw new Error(`unexpected field: ${key}`);
  for (const key of ['headline', 'shortInsight', 'narrative'] as const) {
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > limits[key]) throw new Error(`invalid ${key}`);
  }
  for (const key of ['observations', 'nextSteps'] as const) {
    if (!Array.isArray(row[key]) || row[key].length > limits[key] || row[key].some((item) => typeof item !== 'string' || !item.trim() || item.length > 240)) throw new Error(`invalid ${key}`);
  }
  return row as unknown as CoachAnalysis;
}
```

In `lib/proactiveHealthWorker.ts`, import the type for local use and re-export both names so existing repository/API imports remain stable. Delete `limits`, the local parser, `UNITLESS`, unit aliases, `inferredUnit`, and all of `validateGroundedAnalysis`; do not replace them with another output-side number/unit scanner.

- [ ] **Step 4: Implement the deterministic encoder and outbound guard**

Create the grounding module with these public types and private state:

```ts
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
```

Implement an Excel-style alphabetic allocator (`A` through `Z`, then `AA`, `AB`, …) and wrap it as `{{EVIDENCE_<letters>}}`. Traverse the exact root `{ kind, date, input, availableContext }`; sort object keys and preserve array positions. Reject `undefined`, bigint, symbol, function, non-finite number, cycles, non-plain objects, and any source string containing `{{EVIDENCE_` or a token-like reserved fragment.

For strings, use one anchored source-lexeme matcher repeatedly so signs, decimals, leading decimals, exponents, grouped numbers, percentages, and Unicode numeric code points are consumed as complete source occurrences. Capture adjacent source units exactly when already present in the source string. For JSON numeric fields, use typed input-side formatters keyed by an explicit allowlist of existing known health paths/keys (`hrv*`/`*_ms` → `ms`, heart-rate keys → `bpm`, percentage/efficiency keys → `%`, weight/`*_kg` → `kg`, energy/calorie keys → `kcal`, step keys → `steps`, duration/minute keys → `minutes`, second keys → `seconds`, distance/elevation `*_m` → `m`, pace-per-km → `min/km`, pace-per-mi → `min/mi`, VO2 → `ml/kg/min`, blood-pressure keys → `mmHg`). An object containing numeric `value` plus an exact string `unit` uses that exact supplied unit; an object containing `metric` plus `value` uses the typed metric adapter. Unknown paths store only the exact numeric lexeme with no invented unit.

Finish by asserting `assertNoRawNumbers(JSON.stringify(payload))`, freezing the encoded payload, and registering `{ payload, displays }` in `encodings`. Never attach `displays` to the returned object.

- [ ] **Step 5: Run Task 1 tests and confirm GREEN**

Run:

```bash
npx tsx --test lib/proactiveAnalysisSchema.test.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveHealthWorker.test.ts
npx tsc --noEmit
```

Expected: schema and encoder tests pass; the retained worker scheduling/APNs/retry tests pass; TypeScript exits `0`; no scanner exports or scanner tests remain.

- [ ] **Step 6: Commit Task 1**

```bash
git add lib/proactiveAnalysisSchema.ts lib/proactiveAnalysisSchema.test.ts lib/proactiveAnalysisGrounding.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveHealthWorker.ts lib/proactiveHealthWorker.test.ts
git commit -m "refactor: encode proactive analysis evidence"
```

---

### Task 2: Prove Token Use, Resolve Exact Displays, and Mint a One-Shot Runtime Proof

**Files:**
- Modify: `lib/proactiveAnalysisGrounding.ts`
- Modify: `lib/proactiveAnalysisGrounding.test.ts`
- Modify: `lib/proactiveAnalysisSchema.test.ts`

**Interfaces:**
- Consumes: `AnalysisFailureCategory` and `AnalysisContentError` from Task 1, classified without exception-message inspection.
- Produces: opaque `GroundedAnalysisProof`, `groundAnalysisText(text, encoded): GroundedAnalysisProof`, and `consumeGroundedAnalysisProof(proof): CoachAnalysis`.
- Guarantees: only successful exact-token resolution can register a proof; proof membership and value are held in a module-private `WeakMap`; consumption deletes membership before returning.

- [ ] **Step 1: Add failing boundary, resolution, and proof tests**

Extend `lib/proactiveAnalysisGrounding.test.ts` with a helper that obtains the deterministic tokens from `modelPayload(encoded)` and builds a valid token-only response. Cover each ordered boundary:

```ts
test('resolves exact private displays and consumes proof once', () => {
  const encoded = encodeProactiveAnalysisRequest({
    kind: 'workout', date: 'date',
    input: { metrics: [{ metric: 'hrv_sdnn', value: 45 }], summary: 'Duration was 2 hours.' },
    availableContext: {},
  });
  const tokens = JSON.stringify(modelPayload(encoded)).match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
  const proof = groundAnalysisText(JSON.stringify({
    headline: 'A useful signal',
    shortInsight: 'Recovery held steady.',
    narrative: `HRV was ${tokens[0]}.`,
    observations: [`Duration was ${tokens[1]}.`],
    nextSteps: ['Keep today comfortable.'],
  }), encoded);
  const resolved = consumeGroundedAnalysisProof(proof);
  assert.match(resolved.narrative, /45 ms/);
  assert.match(resolved.observations[0], /2 hours/);
  assert.doesNotMatch(JSON.stringify(resolved), /EVIDENCE/);
  assert.throws(() => consumeGroundedAnalysisProof(proof));
});

test('revalidates schema limits after token expansion', () => {
  const encoded = encodeProactiveAnalysisRequest({ kind: 'sleep', date: 'date', input: { summary: '9'.repeat(241) }, availableContext: {} });
  const [token] = JSON.stringify(modelPayload(encoded)).match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
  assert.throws(
    () => groundAnalysisText(JSON.stringify({ ...valid, shortInsight: token }), encoded),
    (error: unknown) => error instanceof AnalysisContentError && error.category === 'grounding_failure',
  );
});
```

Add tables asserting `parse_failure` for malformed/fenced-invalid JSON; `schema_failure` for missing/extra keys, numeric fields, nested objects, tokens in keys/extra fields/array structure; and `grounding_failure` for raw ASCII/Unicode integers, signs, decimals, leading decimals, exponents, grouped numbers, percentages, temperatures, numeric list labels, unknown tokens, duplicate tokens, malformed/partial/split/nested/concatenated tokens, or a token copied from a different encoded request.

Add proof-forgery tests:

```ts
for (const forged of [valid, { value: valid }, { ...proof }, JSON.parse(JSON.stringify(proof))]) {
  assert.throws(() => consumeGroundedAnalysisProof(forged as GroundedAnalysisProof));
}
```

Also prove identical source displays receive distinct capabilities: using one occurrence's token twice fails, and the other occurrence's token independently resolves.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisSchema.test.ts
```

Expected: exit `1` because proof/resolution exports do not exist.

- [ ] **Step 3: Implement ordered parse, schema, token proof, and exact resolution**

`groundAnalysisText` must use the fixed `AnalysisContentError` categories created in Task 1 and never inspect an exception message. It must:

1. Strip only one optional complete JSON code fence and `JSON.parse`; catch only this boundary as `parse_failure`.
2. Call `parseCoachAnalysis`; catch only this boundary as `schema_failure`.
3. Enumerate only the five validated string locations. Reject `/\p{N}/u` in model-authored strings. Match complete tokens with `/\{\{EVIDENCE_[A-Z]+\}\}/g`; require exact membership in the private display map and global one-use membership in a `Set`.
4. Remove valid exact tokens from a scratch copy of each string, then reject any remaining `EVIDENCE`, unmatched braces belonging to the protocol, adjacent token boundaries, or token fragments. This makes malformed, partial, split, nested, and concatenated forms fail closed.
5. Replace each token through a callback lookup, never through numeric parsing or unit recognition. Call `parseCoachAnalysis` again; classify lookup/replacement/revalidation failures as `grounding_failure`.
6. Register the clean result in private proof state and return the opaque proof.

- [ ] **Step 4: Implement the runtime proof registry and one-shot consumer**

Use private runtime state, not a public symbol or structural marker:

```ts
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
```

Keep `mintGroundedAnalysisProof` private and call it only at the end of `groundAnalysisText`. Do not add a public arbitrary-result minting helper or serialize/store proof state.

- [ ] **Step 5: Run Task 2 tests and confirm GREEN**

Run:

```bash
npx tsx --test lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisSchema.test.ts
npx tsc --noEmit
```

Expected: all boundary/proof tests pass and TypeScript exits `0`.

- [ ] **Step 6: Commit Task 2**

```bash
git add lib/proactiveAnalysisGrounding.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisSchema.test.ts
git commit -m "feat: prove and resolve proactive evidence tokens"
```

---

### Task 3: Integrate One Guarded Initial Call and One Privacy-Safe Repair

**Files:**
- Modify: `lib/proactiveAnalysisGeneration.ts`
- Modify: `lib/proactiveAnalysisGeneration.test.ts`

**Interfaces:**
- Consumes: `encodeProactiveAnalysisRequest`, `modelPayload`, `assertNoRawNumbers`, `groundAnalysisText`, and `GroundedAnalysisProof`.
- Produces: `generateGroundedAnalysis(args): Promise<GroundedAnalysisProof>`.
- Preserves: `DEFAULT_PROACTIVE_ANALYSIS_MODEL`, `proactiveAnalysisModel`, and the closed `AnalysisFailureEvent` allowlist.
- Removes: raw `evidence`, unencoded `promptInput`, rejected response replay, and `Promise<CoachAnalysis>` from the generation boundary.
- Re-exports: `AnalysisFailureCategory` and `AnalysisContentError` from the grounding module only if existing callers need compatibility; there must be one runtime error class, not a duplicate generation-local class.

- [ ] **Step 1: Replace obsolete generation tests with failing token-contract tests**

Rewrite fixtures to contain representative date/input/context numbers and have the fake model copy tokens from the request content. Assert:

```ts
test('valid token output returns a consumable proof after one guarded call', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const proof = await generateGroundedAnalysis({
    source,
    generate: async (request) => {
      calls.push(request);
      assert.doesNotMatch(request.system + request.content, /\p{N}/u);
      const [token] = request.content.match(/\{\{EVIDENCE_[A-Z]+\}\}/g) ?? [];
      return JSON.stringify({ ...valid, narrative: `HRV was ${token}.` });
    },
    report: () => {},
  });
  assert.equal(calls.length, 1);
  assert.match(consumeGroundedAnalysisProof(proof).narrative, /45 ms/);
});
```

For initial parse/schema/grounding failures, assert exactly two calls, the same encoded token payload in both calls, and fixed events `repair_started` then `repair_succeeded`. Assert the repair request contains only `{ request: <same encoded payload>, category }`, contains neither rejected text nor exception text, and passes the Unicode number guard.

For repair parse/schema/grounding failure, assert exactly two calls and `repair_exhausted`, never a third call. For transport, authentication, timeout, and no-text errors, assert one call, no repair, and no content event. Assert source objects remain unchanged and encoding occurs once per `generateGroundedAnalysis` invocation.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts
```

Expected: exit `1` because generation still sends raw numbers, replays rejected text, and returns `CoachAnalysis`.

- [ ] **Step 3: Replace prompts and request types with the exact token contract**

Use prompts containing no digit code points and explicitly require JSON-only, observational, non-diagnostic output plus these rules: copy only supplied evidence tokens exactly; copy only into the five schema string locations; use each at most once; never alter, split, concatenate, nest, enumerate, or manufacture a token; never write a raw number or numeric symbol sequence; use qualitative language when no token fits.

Define:

```ts
export interface AnalysisGenerationRequest {
  attempt: 'initial' | 'repair';
  system: string;
  content: string;
}

export interface GenerateGroundedAnalysisArgs {
  source: ProactiveAnalysisSource;
  generate(request: AnalysisGenerationRequest): Promise<string>;
  report(event: AnalysisFailureEvent): void;
}
```

Before each `generate` call, serialize its user object and call `assertNoRawNumbers` on both `system` and `content`. Put the guarded initial request and `groundAnalysisText` in the same `try` so an outbound-guard failure is classified as `grounding_failure` and enters the single repair branch without making the unsafe initial transport call. Guard failure on the repair request reports `repair_exhausted`. The transport callback continues to choose `proactiveAnalysisModel(process.env)` separately; do not inspect the model identifier.

- [ ] **Step 4: Implement exact one-repair orchestration returning proofs**

Encode once before the initial call. Validate each response only with `groundAnalysisText(response, encoded)`. Only `AnalysisContentError` enters repair. The repair user payload is exactly:

```ts
const repairPayload = {
  category: initialError.category,
  request: modelPayload(encoded),
};
```

Do not include `initialText`, an error, a stack, a cause, or a sanitized rendering. On repair success, report the original category with `repair_succeeded`; on repair content failure, report the repair category with `repair_exhausted` and rethrow. Do not loop and do not catch transport/no-text failures.

- [ ] **Step 5: Run Task 3 tests and confirm GREEN**

Run:

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisSchema.test.ts
npx tsc --noEmit
```

Expected: all generation/grounding/schema tests pass and TypeScript exits `0`.

- [ ] **Step 6: Commit Task 3**

```bash
git add lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisGeneration.test.ts
git commit -m "fix: bound token-only proactive analysis repair"
```

---

### Task 4: Require Fresh Runtime Proofs at Queued and Morning Ownership Boundaries

**Files:**
- Modify: `lib/proactiveHealthWorker.ts:193-215`
- Modify: `lib/proactiveHealthWorker.test.ts:90-205`
- Modify: `scripts/proactive-health-worker.ts:3-69`
- Verify unchanged: `lib/proactiveHealthWorkerRepository.ts:63,144-165`
- Verify unchanged: `lib/proactiveHealthLeaseSemantics.test.ts`

**Interfaces:**
- Changes queued analyzer: `(job, context) => Promise<GroundedAnalysisProof>`.
- Produces: `consumeMorningAnalysisProof(proof): CoachAnalysis`, a narrow helper that delegates only to the trusted one-shot consumer.
- Preserves: queued lease renewal before analysis and before `storeReady`, repository status-and-lease-token CAS, morning-slot lease renewal/CAS in `completeMorningBrief`, retries, and notifications.

- [ ] **Step 1: Write failing queued proof and lease tests**

Create a test-local `trustedProof()` only by encoding a source and calling `groundAnalysisText` with a valid token response. Update successful worker tests to use it. Add assertions that a plain result cast to `GroundedAnalysisProof`, an empty object, a spread/serialized proof, and an already-consumed proof all cause the job retry path and never call `storeReady`, `claimNotification`, or push.

Keep and adapt the lease-loss regression:

```ts
test('a grounded proof is not stored after lease ownership is lost', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  let renewals = 0;
  repo.renewAnalysisLease = async () => ++renewals === 1;
  repo.storeReady = async () => { calls.push('store'); return true; };
  await runClaimedAnalysis(job(), repo, async () => trustedProof(), async () => ({ outcome: 'sent', retireToken: false }), now);
  assert.equal(calls.includes('store'), false);
});
```

Retain first-retry (`12:01:00.000Z`), retry-limit, disabled preference, duplicate notification, APNs, timezone, and exponential-backoff tests.

- [ ] **Step 2: Write failing morning-proof ownership tests**

Test `consumeMorningAnalysisProof` with a fresh trusted proof, a cast plain result, copied/serialized proof, and a consumed proof. A forged proof must fail before the fake owned-completion callback is invoked. Retain `unique morning date admits exactly one concurrent sleep-or-brief winner` and `repeated morning analysis failures use owner CAS, back off, and become terminal` unchanged in `lib/proactiveHealthLeaseSemantics.test.ts`.

- [ ] **Step 3: Run focused worker tests and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveHealthWorker.test.ts lib/proactiveHealthLeaseSemantics.test.ts
```

Expected: exit `1` because `runClaimedAnalysis` still accepts unknown/plain results and the morning proof helper does not exist.

- [ ] **Step 4: Consume the queued proof before persistence ownership is renewed**

Change the analyzer type and result boundary exactly as follows:

```ts
analyze: (job: AnalysisJob, context: AnalysisContext) => Promise<GroundedAnalysisProof>,
// ...
const proof = await analyze(job, context);
const result = consumeGroundedAnalysisProof(proof);
if (!await repository.renewAnalysisLease(job, new Date())) return;
if (!await repository.storeReady(job, result)) return;
```

No parse, cast, or fallback is allowed in `runClaimedAnalysis`. Keep proof consumption before the second lease renewal so a forged proof cannot reach persistence. Keep the existing catch/retry behavior.

- [ ] **Step 5: Consume the morning proof immediately before owned completion**

Add only this narrow helper to the worker module:

```ts
export function consumeMorningAnalysisProof(proof: GroundedAnalysisProof): CoachAnalysis {
  return consumeGroundedAnalysisProof(proof);
}
```

In `scripts/proactive-health-worker.ts`, make `analyze` return `Promise<GroundedAnalysisProof>` and pass `source: { kind, date, input, availableContext }`. For queued jobs, pass `analyze` directly to `runClaimedAnalysis`. For morning briefs:

```ts
const proof = await analyze(job, context);
const result = consumeMorningAnalysisProof(proof);
await completeMorningBrief(claim, result, sendMorningPush, now);
```

This consumption must be immediately adjacent to and before `completeMorningBrief`; do not introduce an alternate parser or result path. Leave `completeMorningBrief` unchanged so its per-device lease renewal and final slot-token CAS remain authoritative.

- [ ] **Step 6: Run Task 4 tests and worker bundle**

Run:

```bash
npx tsx --test lib/proactiveHealthWorker.test.ts lib/proactiveHealthLeaseSemantics.test.ts lib/proactiveHealthWorkerSupport.test.ts lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisGrounding.test.ts
npx tsc --noEmit
npm run build:worker
```

Expected: all focused tests pass with `0` failures; TypeScript exits `0`; esbuild emits `dist/proactive-health-worker.cjs`.

- [ ] **Step 7: Commit Task 4**

```bash
git add lib/proactiveHealthWorker.ts lib/proactiveHealthWorker.test.ts scripts/proactive-health-worker.ts
git commit -m "fix: enforce proactive analysis proof ownership"
```

---

### Task 5: Verify Privacy, Ownership, and the Unchanged Exact-Nine Recovery

**Files:**
- Modify only if an acceptance regression is missing: `lib/proactiveAnalysisGrounding.test.ts`, `lib/proactiveAnalysisGeneration.test.ts`, or `lib/proactiveHealthWorker.test.ts`
- Verify unchanged: `lib/proactiveAnalysisRecovery.ts`
- Verify unchanged: `lib/proactiveAnalysisRecovery.test.ts`
- Verify unchanged: `lib/proactiveAnalysisRecoveryDrizzle.ts`
- Verify unchanged: `lib/proactiveAnalysisRecoveryDrizzle.test.ts`
- Verify unchanged: `scripts/recover-proactive-analysis-jobs.ts`
- Verify unchanged: `package.json`

**Interfaces:**
- Verifies: encoder, outbound guard, token proof/resolution, runtime proof, repair, leases, morning ownership, transitions, notifications, exact-nine recovery, worker bundle, full suite, and production build.
- Prohibits: executing the recovery command, editing recovery semantics, schema/migration/workflow changes, or logging any sensitive material.

- [ ] **Step 1: Run the complete focused acceptance matrix**

Run:

```bash
npx tsx --test \
  lib/proactiveAnalysisSchema.test.ts \
  lib/proactiveAnalysisGrounding.test.ts \
  lib/proactiveAnalysisGeneration.test.ts \
  lib/proactiveHealthWorker.test.ts \
  lib/proactiveHealthLeaseSemantics.test.ts \
  lib/proactiveHealthWorkerSupport.test.ts \
  lib/proactiveAnalysisRecovery.test.ts \
  lib/proactiveAnalysisRecoveryDrizzle.test.ts
```

Expected: all focused tests pass with `0` failures. Recovery tests still prove exact-nine argument validation before database access, both-table locks, four CAS predicates, exactly five assignments, all-or-nothing returned-ID matching, notification/unrelated-field preservation, second-run rollback, and count-only output.

- [ ] **Step 2: Audit the closed model and proof boundaries**

Run:

```bash
rg -n "validateGroundedAnalysis|unitAliases|unsupportedHealthUnits|rejectedText|initialText.*repair|Promise<unknown>" lib/proactiveAnalysis*.ts lib/proactiveHealthWorker.ts scripts/proactive-health-worker.ts
rg -n "console\.(log|warn|error)" lib/proactiveAnalysis*.ts lib/proactiveHealthWorker.ts scripts/proactive-health-worker.ts scripts/recover-proactive-analysis-jobs.ts
rg -n "GroundedAnalysisProof|consumeGroundedAnalysisProof|consumeMorningAnalysisProof" lib scripts/proactive-health-worker.ts
```

Expected: the obsolete output scanner and rejected-text replay have no matches; no analyzer returns `Promise<unknown>`; console calls are limited to the worker's allowlisted JSON events and the recovery CLI's fixed count output; proof consumption appears only at the trusted queued/morning boundaries and tests.

- [ ] **Step 3: Prove recovery and database/release files did not change**

Run:

```bash
git diff ba4813b -- \
  lib/proactiveAnalysisRecovery.ts \
  lib/proactiveAnalysisRecovery.test.ts \
  lib/proactiveAnalysisRecoveryDrizzle.ts \
  lib/proactiveAnalysisRecoveryDrizzle.test.ts \
  scripts/recover-proactive-analysis-jobs.ts \
  package.json \
  db/schema.ts db/migrations .github/workflows
```

Expected: no output. Do not run `npm run recover:proactive-analysis`; its nine IDs remain operator-supplied after deployment and its injected `Date` remains unchanged.

- [ ] **Step 4: Run project-wide verification**

Run:

```bash
npx tsx --test lib/*.test.ts lib/specialists/*.test.ts lib/brain/*.test.ts db/*.test.ts
npx tsc --noEmit
npm run lint
npm run build:worker
npm run build
git diff --check
git status --short
```

Expected: full test suite passes with `0` failures; TypeScript, lint, worker bundle, and production Next.js build exit `0`; no whitespace errors; only intended evidence-token files are modified.

- [ ] **Step 5: Commit any acceptance-only test additions**

If Step 1 exposed a missing acceptance assertion and only tests were added, commit them separately:

```bash
git add lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisGeneration.test.ts lib/proactiveHealthWorker.test.ts
git commit -m "test: cover proactive evidence-token acceptance"
```

If no test changes were needed, do not create an empty commit.

- [ ] **Step 6: Push the feature branch and open the PR**

```bash
git push -u origin feat/fix-proactive-analysis-grounding
gh pr create --base main --head feat/fix-proactive-analysis-grounding \
  --title "fix: enforce evidence-token proactive grounding" \
  --body $'## Summary\n- encode all proactive date, input, and context numbers as opaque evidence tokens\n- resolve exact trusted displays and require one-shot runtime proofs at queued and morning ownership boundaries\n- keep one privacy-safe repair and preserve the exact-nine recovery unchanged\n\n## Verification\n- focused proactive and recovery tests\n- full TypeScript test suite\n- typecheck, lint, worker bundle, and production build'
```

The PR body must summarize the token-only model boundary, exact resolution, runtime proof ownership, one bounded repair, privacy constraints, unchanged exact-nine recovery, and the verification commands above. Stop after opening the PR; do not merge it.

---

## Acceptance Traceability

- Encoder and source-display requirements: Task 1 Steps 1 and 4.
- Outbound initial/repair number guard: Task 1 Step 4 and Task 3 Steps 1 and 3.
- Token-only prompt contract: Task 3 Step 3.
- Parse/schema/token/resolution order and post-resolution limits: Task 2 Steps 1 and 3.
- Raw, unknown, duplicate, malformed, misplaced, split, nested, concatenated, and cross-request token rejection: Task 2 Step 1.
- Private one-shot proof and anti-forgery behavior: Task 2 Steps 1 and 4.
- Queued lease/CAS and morning-slot ownership: Task 4 Steps 1-6.
- Exactly one privacy-safe repair and no repair for transport/no-text failures: Task 3 Steps 1 and 4.
- Fixed allowlisted diagnostics with no prompt/evidence/token/identifier leakage: Task 3 Step 1 and Task 5 Step 2.
- Unchanged retries, backoff, notifications, APNs, queue ordering, and sleep reservation: Task 4 Step 1 and Task 5 Steps 1 and 4.
- Unchanged exact-nine recovery, field preservation, count-only output, and injected transaction time: Task 5 Steps 1 and 3.
- Full tests, typecheck, lint, worker bundle, and production build: Task 5 Step 4.
