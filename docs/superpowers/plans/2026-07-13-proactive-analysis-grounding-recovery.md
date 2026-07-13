# Proactive Analysis Grounding Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover malformed or ungrounded proactive model output with one strict repair attempt and atomically requeue exactly nine known failed analyses without exposing private data or changing notification state.

**Architecture:** Put model selection, prompts, explicit parse/schema/grounding classification, repair orchestration, and sanitized analysis events in one dependency-light module used by both queued analyses and morning briefs. Put exact-nine argument validation and transactional recovery policy in a separate pure module; a thin CLI dynamically loads the database adapter only after validation and performs compare-and-set updates in one transaction.

**Tech Stack:** TypeScript, Node.js 22, `node:test`, Anthropic SDK, Drizzle ORM 0.45, postgres.js 3.4, PostgreSQL

## Global Constraints

- Default to exactly `claude-sonnet-4-6`; preserve the `PROACTIVE_ANALYSIS_MODEL` override.
- Any numeric token in model output must occur exactly in supplied evidence with the same unit; prompts must forbid arithmetic, ratios, percentages, deltas, conversion, rounding, estimation, extrapolation, and invented numeric labels.
- Never weaken, bypass, or special-case `parseCoachAnalysis` or `validateGroundedAnalysis`.
- Permit exactly one repair call only after `parse_failure`, `schema_failure`, or `grounding_failure`; transport, authentication, timeout, and no-text failures use the existing retry path without content repair.
- Preserve analysis leases, status-and-token compare-and-set persistence, retry limit, exponential backoff, terminal failure behavior, notification ordering, morning-slot ownership, and APNs behavior.
- Diagnostic output may contain only fixed allowlisted event fields and count labels; never emit model text, evidence, prompts, messages, stacks, causes, IDs, UUIDs, row data, SQL, database URLs, tokens, or health content.
- Recovery accepts exactly nine unique canonical UUIDs at runtime, runs in one transaction, and commits only if all nine eligible rows transition.
- Recovery updates only `status`, `retry_count`, `next_attempt_at`, `lease_token`, and `lease_expires_at`; it must not assign `result`, `updated_at`, any notification column, or any other field.
- Do not add schema changes or migrations, do not embed production UUIDs, and do not run the recovery automatically during release or worker startup.
- Work only on `feat/fix-proactive-analysis-grounding`; never push or merge `main`.

---

### Task 1: Classify and repair proactive analysis output once

**Files:**
- Create: `lib/proactiveAnalysisGeneration.ts`
- Create: `lib/proactiveAnalysisGeneration.test.ts`
- Modify: `scripts/proactive-health-worker.ts:1-55`
- Modify: `lib/proactiveHealthWorker.test.ts`

**Interfaces:**
- Produces: `DEFAULT_PROACTIVE_ANALYSIS_MODEL = 'claude-sonnet-4-6'`
- Produces: `proactiveAnalysisModel(env: NodeJS.ProcessEnv): string`
- Produces: `AnalysisFailureCategory = 'parse_failure' | 'schema_failure' | 'grounding_failure'`
- Produces: `AnalysisFailureEvent = { event: 'proactive_analysis_failure'; attempt: 'initial' | 'repair'; category: AnalysisFailureCategory; outcome: 'repair_started' | 'repair_succeeded' | 'repair_exhausted' }`
- Produces: `analysisFailureEvent(attempt, category, outcome): AnalysisFailureEvent`
- Produces: `generateGroundedAnalysis(args: GenerateGroundedAnalysisArgs): Promise<CoachAnalysis>`
- Consumes unchanged: `parseCoachAnalysis(value: unknown): CoachAnalysis`
- Consumes unchanged: `validateGroundedAnalysis(result: CoachAnalysis, evidence: unknown): CoachAnalysis`
- Preserves: `runClaimedAnalysis` lease renewal, `storeReady` compare-and-set, `nextRetryAt`, `markRetry`, and `markFailed`

- [ ] **Step 1: Write failing tests for model selection, prompts, classification, and bounded repair**

Create `lib/proactiveAnalysisGeneration.test.ts` with table-driven fakes. The test file must import the new public interfaces and use this grounded fixture:

```ts
const evidence = {
  input: { source: 'workout' },
  context: { enabled: true, timezone: 'UTC', baselines: {}, profile: {}, metrics: [{ metric: 'hrv_sdnn', value: 45 }] },
};
const promptInput = { kind: 'workout' as const, date: '2026-07-13', input: evidence.input, availableContext: evidence.context };
const valid = {
  headline: 'A useful signal',
  shortInsight: 'Recovery held steady.',
  narrative: 'Your HRV was 45 ms.',
  observations: ['HRV data was available.'],
  nextSteps: ['Keep today comfortable.'],
};
```

Add explicit assertions for all of the following:

```ts
test('defaults to Sonnet 4.6 and preserves the environment override', () => {
  assert.equal(proactiveAnalysisModel({}), 'claude-sonnet-4-6');
  assert.equal(proactiveAnalysisModel({ PROACTIVE_ANALYSIS_MODEL: 'custom-model' }), 'custom-model');
});

test('initial and repair prompts forbid every derived-number class', () => {
  for (const phrase of ['arithmetic', 'ratios', 'percentages', 'differences', 'unit conversion', 'rounding', 'estimation', 'extrapolation', 'numeric list labels']) {
    assert.match(PROACTIVE_ANALYSIS_SYSTEM_PROMPT, new RegExp(phrase, 'i'));
    assert.match(PROACTIVE_ANALYSIS_REPAIR_PROMPT, new RegExp(phrase, 'i'));
  }
});

test('valid initial output returns after one call', async () => {
  const calls: AnalysisGenerationRequest[] = [];
  const result = await generateGroundedAnalysis({ promptInput, evidence, generate: async (request) => { calls.push(request); return JSON.stringify(valid); }, report: () => {} });
  assert.deepEqual(result, valid);
  assert.equal(calls.length, 1);
});
```

For malformed JSON, schema-invalid JSON, an unsupported number, and a mismatched unit, assert the first rejection produces the exact category, makes exactly one repair request, sends the same evidence plus rejected text and only the fixed category, and accepts a valid grounded replacement. Add a second table where the repair response fails parse/schema/grounding and assert exactly two model calls, `repair_exhausted`, and rejection with the typed category. Add transport and no-text cases that reject after one call and never emit a content-repair event. Serialize every event and assert it contains none of the rejected response, evidence values, exception messages, IDs, UUIDs, prompts, stacks, causes, or tokens.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts
```

Expected: exit `1` because `./proactiveAnalysisGeneration` does not exist.

- [ ] **Step 3: Implement the pure output boundary and one-repair orchestration**

Create `lib/proactiveAnalysisGeneration.ts` with these exact public types and constants:

```ts
import { parseCoachAnalysis, validateGroundedAnalysis, type CoachAnalysis } from './proactiveHealthWorker';

export const DEFAULT_PROACTIVE_ANALYSIS_MODEL = 'claude-sonnet-4-6';
export type AnalysisFailureCategory = 'parse_failure' | 'schema_failure' | 'grounding_failure';
export type AnalysisAttempt = 'initial' | 'repair';
export type AnalysisFailureOutcome = 'repair_started' | 'repair_succeeded' | 'repair_exhausted';

export interface AnalysisFailureEvent {
  event: 'proactive_analysis_failure';
  attempt: AnalysisAttempt;
  category: AnalysisFailureCategory;
  outcome: AnalysisFailureOutcome;
}

export interface AnalysisGenerationRequest {
  attempt: AnalysisAttempt;
  system: string;
  content: string;
}

export interface GenerateGroundedAnalysisArgs {
  promptInput: {
    kind: 'workout' | 'sleep';
    date: string;
    input: unknown;
    availableContext: unknown;
  };
  evidence: unknown;
  generate(request: AnalysisGenerationRequest): Promise<string>;
  report(event: AnalysisFailureEvent): void;
}

export class AnalysisContentError extends Error {
  constructor(readonly category: AnalysisFailureCategory) {
    super('Proactive analysis content validation failed.');
    this.name = 'AnalysisContentError';
  }
}
```

Export `PROACTIVE_ANALYSIS_SYSTEM_PROMPT` and `PROACTIVE_ANALYSIS_REPAIR_PROMPT`. Both must retain the existing JSON-only, observational, non-diagnostic contract and explicitly forbid every derived-number class in the spec. Implement `proactiveAnalysisModel` without reading any other environment value:

```ts
export function proactiveAnalysisModel(env: NodeJS.ProcessEnv): string {
  return env.PROACTIVE_ANALYSIS_MODEL ?? DEFAULT_PROACTIVE_ANALYSIS_MODEL;
}

export function analysisFailureEvent(
  attempt: AnalysisAttempt,
  category: AnalysisFailureCategory,
  outcome: AnalysisFailureOutcome,
): AnalysisFailureEvent {
  return { event: 'proactive_analysis_failure', attempt, category, outcome };
}
```

Implement the validation boundary with separate catches so classification never inspects an error message:

```ts
function validateText(text: string, evidence: unknown): CoachAnalysis {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    throw new AnalysisContentError('parse_failure');
  }

  let shaped: CoachAnalysis;
  try {
    shaped = parseCoachAnalysis(decoded);
  } catch {
    throw new AnalysisContentError('schema_failure');
  }

  try {
    return validateGroundedAnalysis(shaped, evidence);
  } catch {
    throw new AnalysisContentError('grounding_failure');
  }
}
```

`generateGroundedAnalysis` must call `generate` once with the initial prompt and `JSON.stringify(promptInput)`. Only an `AnalysisContentError` may enter the repair branch. Report `repair_started`, call `generate` exactly once more with the repair prompt and a JSON object containing `promptInput`, the rejected text, and the fixed category, then validate the full replacement with `validateText(evidence)`. On success report `repair_succeeded` using the original category. On any repair content error report `repair_exhausted` using the repair category and rethrow it. Do not catch transport/no-text errors, do not log inside this module, and do not loop.

- [ ] **Step 4: Integrate the shared analyzer into queued jobs and morning briefs**

In `scripts/proactive-health-worker.ts`, replace direct model parsing with `generateGroundedAnalysis`. The Anthropic callback must select the model with `proactiveAnalysisModel(process.env)`, require one text block, and return its text without parsing. Pass `promptInput: { kind: job.kind, date: job.localDate, input: job.input, availableContext: context }` to preserve the existing request content, and pass the unchanged strict-grounding evidence separately as `{ input: job.input, context }`.

Both queued jobs and morning briefs must call the same analyzer. Emit events only through:

```ts
const reportAnalysisFailure = (event: AnalysisFailureEvent): void => {
  console.error(JSON.stringify(event));
};
```

Do not pass raw exceptions or model responses to `console.error`. Leave `runClaimedAnalysis` unchanged so a successful repaired value is revalidated, the lease is renewed before storage, and `storeReady` retains its existing status-and-token compare-and-set. Leave the morning-slot failure transition unchanged.

- [ ] **Step 5: Add ownership, retry, and log-shape regression tests**

Extend `lib/proactiveHealthWorker.test.ts` with fakes that prove:

```ts
test('a repaired result is not stored after lease ownership is lost', async () => {
  const calls: string[] = [];
  const repo = fakeRepository(calls, true);
  let renewals = 0;
  repo.renewAnalysisLease = async () => ++renewals === 1;
  repo.storeReady = async () => { calls.push('store'); return true; };
  await runClaimedAnalysis(job(), repo, async () => valid, async () => ({ outcome: 'sent', retireToken: false }), new Date('2026-07-13T12:00:00Z'));
  assert.equal(calls.includes('store'), false);
});
```

Add one failing-analysis case at `retryCount: 0` that asserts exactly one `markRetry` call with `2026-07-13T12:01:00.000Z`, and one at `retryCount: 5` that asserts `markFailed` and no `markRetry`. Keep the existing strict numeric/unit tests unchanged and green.

- [ ] **Step 6: Run Task 1 verification and confirm GREEN**

Run:

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts lib/proactiveHealthWorker.test.ts lib/proactiveHealthLeaseSemantics.test.ts lib/proactiveHealthWorkerSupport.test.ts
npx tsc --noEmit
npm run build:worker
```

Expected: all focused tests pass with `0` failures; TypeScript exits `0`; esbuild emits `dist/proactive-health-worker.cjs`.

- [ ] **Step 7: Commit Task 1**

```bash
git add lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisGeneration.test.ts lib/proactiveHealthWorker.test.ts scripts/proactive-health-worker.ts
git commit -m "fix: repair proactive analysis grounding failures"
```

---

### Task 2: Atomically requeue exactly nine failed analyses

**Files:**
- Create: `lib/proactiveAnalysisRecovery.ts`
- Create: `lib/proactiveAnalysisRecovery.test.ts`
- Create: `scripts/recover-proactive-analysis-jobs.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `RECOVERY_JOB_COUNT = 9`
- Produces: `parseRecoveryIds(argv: string[]): string[]`
- Produces: `RecoveryRow`, `RecoveryCounts`, `RecoveryTransaction`, and `RecoveryStore`
- Produces: `recoverProactiveAnalysisJobs(store, ids, now): Promise<RecoveryCounts>`
- Produces: `formatRecoveryCounts(counts, success): string`
- Consumes: exactly nine repeated `--id <canonical-uuid>` pairs
- Preserves: all notification fields and every non-analysis-queue field

- [ ] **Step 1: Write failing tests for exact-nine input validation and atomic recovery**

Create `lib/proactiveAnalysisRecovery.test.ts`. Use these nine synthetic canonical UUIDs, which are lowercase and have valid version `4` and variant `8` bits, never production values:

```ts
const ids = Array.from(
  { length: 9 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);
```

Define a fake `RecoveryStore` that snapshots rows before a transaction, restores them on throw, records whether a connection/transaction was opened, and applies only the five allowed queue assignments.

Add table-driven parser tests that reject zero through eight IDs, ten IDs, duplicates, uppercase/noncanonical/malformed UUIDs, positional values, missing flag values, and unknown flags. Every parser failure must occur before the fake store is called. Assert nine unique lowercase canonical UUIDs are returned in input order.

Add recovery tests for a mixed workout/sleep set and assert:

```ts
assert.equal(counts.requestedCount, 9);
assert.equal(counts.matchedCount, 9);
assert.equal(counts.eligibleCount, 9);
assert.equal(counts.workoutUpdatedCount + counts.sleepUpdatedCount, 9);
assert.equal(counts.totalUpdatedCount, 9);
```

Seed each row with distinct notification fields and unrelated values. After success, assert only `status`, `retryCount`, `nextAttemptAt`, `leaseToken`, and `leaseExpiresAt` changed; `result` stayed `null`; all six notification fields, `updatedAt`, payload, user, date, and source identifiers are deeply equal to the snapshot.

Add rollback cases for an absent UUID, `pending`/`processing`/`ready`/`deleted` status, non-null lease, non-null result, and a fake concurrent CAS miss. Each must reject, restore all rows, and record zero commits. Invoke the successful set a second time and assert zero rows update, the second transaction rolls back, and the first committed state remains unchanged.

Capture `formatRecoveryCounts` output for success and failure. Assert every non-empty line matches `/^[a-z_]+=[0-9]+$/` and contains none of the UUIDs, row fields, error text, SQL, or database URL.

- [ ] **Step 2: Run the focused recovery test and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveAnalysisRecovery.test.ts
```

Expected: exit `1` because `./proactiveAnalysisRecovery` does not exist.

- [ ] **Step 3: Implement the pure exact-nine recovery policy**

Create `lib/proactiveAnalysisRecovery.ts` with these interfaces:

```ts
export const RECOVERY_JOB_COUNT = 9;
export type RecoveryKind = 'workout' | 'sleep';

export interface RecoveryRow {
  id: string;
  kind: RecoveryKind;
  status: string;
  retryCount: number;
  leaseToken: string | null;
  result: unknown;
}

export interface RecoveryCounts {
  requestedCount: number;
  matchedCount: number;
  eligibleCount: number;
  workoutUpdatedCount: number;
  sleepUpdatedCount: number;
  totalUpdatedCount: number;
}

export interface RecoveryTransaction {
  lockRows(ids: string[]): Promise<RecoveryRow[]>;
  recover(kind: RecoveryKind, ids: string[], now: Date): Promise<string[]>;
}

export interface RecoveryStore {
  transaction<T>(operation: (tx: RecoveryTransaction) => Promise<T>): Promise<T>;
}
```

`parseRecoveryIds` must require `argv.length === 18`, accept only alternating `--id` and lowercase canonical UUID values matching `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`, and require a set size of `9`. Throw only `new Error('Invalid proactive analysis recovery arguments.')`.

`recoverProactiveAnalysisJobs` must revalidate count and uniqueness, then open exactly one transaction. Inside it, lock rows, require both `rows.length === 9` and `new Set(rows.map((row) => row.id)).size === 9`, and require every row to satisfy `status === 'failed'`, `leaseToken === null`, and `result === null`. Partition IDs by kind, call `recover` once per non-empty partition, require both the combined returned-array length to equal `9` and its ID set to equal the supplied set exactly, and throw on any mismatch so the store rolls back. Return only integer counts after all checks pass.

`formatRecoveryCounts` must produce fixed `label=integer` lines for requested, matched, eligible, workout updated, sleep updated, total updated, and either `success_count=1` or `failure_count=1`. It must accept no error object or free-form string.

- [ ] **Step 4: Implement the thin Drizzle CLI adapter**

Create `scripts/recover-proactive-analysis-jobs.ts`. Its `main(argv)` must call `parseRecoveryIds` before dynamically importing `@/db`. The adapter must use one `db.transaction`, lock matching rows in both analysis tables, and update each table with all of these compare-and-set predicates:

```ts
and(
  inArray(table.id, ids),
  eq(table.status, 'failed'),
  isNull(table.lease_token),
  isNull(table.result),
)
```

The `.set(...)` object must be exactly:

```ts
{
  status: 'pending',
  retry_count: 0,
  next_attempt_at: now,
  lease_token: null,
  lease_expires_at: null,
}
```

Return IDs from both updates so the pure recovery policy can compare affected sets. Do not set `updated_at`, `result`, or any notification column. The CLI must catch every failure, print count-only output, set a nonzero exit code, and never print the caught value. On success it prints count-only output with `success_count=1` and exits `0`.

Add this package script:

```json
"recover:proactive-analysis": "tsx scripts/recover-proactive-analysis-jobs.ts"
```

Document invocation only as `npm run recover:proactive-analysis -- --id <runtime-uuid>` repeated nine times; do not include UUID-shaped examples. This command is a separate post-deploy operator action and must not be referenced from the release workflow or worker startup.

- [ ] **Step 5: Run focused recovery and proactive-worker verification**

Run:

```bash
npx tsx --test lib/proactiveAnalysisRecovery.test.ts
npx tsx --test lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisRecovery.test.ts lib/proactiveHealthWorker.test.ts lib/proactiveHealthLeaseSemantics.test.ts lib/proactiveHealthWorkerSupport.test.ts
npx tsc --noEmit
npm run lint
npm run build:worker
```

Expected: all focused tests pass with `0` failures; TypeScript and lint exit `0`; the worker bundle is emitted successfully.

- [ ] **Step 6: Run the complete project verification**

Run:

```bash
npx tsx --test lib/*.test.ts lib/specialists/*.test.ts lib/brain/*.test.ts db/*.test.ts
npm run build
git diff --check
git diff origin/main...HEAD -- db/schema.ts db/migrations .github/workflows
rg -n "console\.(log|warn|error)" scripts/proactive-health-worker.ts scripts/recover-proactive-analysis-jobs.ts lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisRecovery.ts
git status --short
```

Expected: the complete test suite passes with `0` failures; the Node 22 Next.js production build exits `0`; there are no whitespace errors or schema, migration, or workflow changes; only allowlisted structured/count-only console output exists; the worktree contains only the intended Task 2 changes before commit.

- [ ] **Step 7: Commit Task 2**

```bash
git add lib/proactiveAnalysisRecovery.ts lib/proactiveAnalysisRecovery.test.ts scripts/recover-proactive-analysis-jobs.ts package.json
git commit -m "fix: add bounded proactive analysis recovery"
```

- [ ] **Step 8: Audit the final branch without executing recovery**

Run:

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git status --short
```

Expected: the branch contains the approved design commits, this plan commit, and exactly the two conventional implementation commits; the worktree is clean. Do not run `npm run recover:proactive-analysis` during development, CI, release, or verification.
