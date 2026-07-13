# Proactive Notification Recovery Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomically recover exactly 14 operator-selected failed proactive analyses—exactly 8 workout and 6 sleep—while changing only the five approved analysis retry fields and `notification_state = 'pending'` so normal notification delivery can claim them.

**Architecture:** Extend the existing privacy-safe recovery boundary rather than adding a new command or database path. The pure recovery coordinator validates the exact input and locked populations, enforces the 8/6 distribution and all eligibility predicates, and rejects any per-table or combined returned-set mismatch inside one transaction; the Drizzle adapter locks both analysis tables and performs the six-field compare-and-set update. The deployed command remains an explicit, one-shot operator action, and normal analysis and notification workers remain solely responsible for processing and APNs delivery after commit.

**Tech Stack:** TypeScript, Node.js `node:test`, Drizzle ORM/PostgreSQL, Next.js, esbuild, npm, GitHub CLI

## Global Constraints

- Accept exactly 14 unique canonical UUIDs supplied only as repeated `--id` flags; do not commit production IDs, defaults, fallback lists, environment ID sources, discovery selectors, or broad queries.
- Require the locked population to equal all 14 supplied IDs exactly, with exactly 8 workout rows and 6 sleep rows.
- Require `status = 'failed'`, `lease_token IS NULL`, `result IS NULL`, `notification_state = 'failed'`, and `notification_sent_at IS NULL` at lock validation and compare-and-set update time.
- Perform all locking, eligibility checks, updates, and returned-set checks in one transaction; any missing, duplicate, extra, ineligible, concurrently changed, wrongly distributed, or unreturned row rolls back every mutation.
- Assign exactly `status = 'pending'`, `retry_count = 0`, `next_attempt_at = transaction time`, `lease_token = NULL`, `lease_expires_at = NULL`, and `notification_state = 'pending'`.
- Preserve `notification_retry_count`, `notification_next_attempt_at`, `notification_lease_token`, `notification_lease_expires_at`, `notification_sent_at`, payloads, `result`, ownership, source, date, and every unrelated field; do not explicitly assign `updated_at`.
- Preserve fixed count-only success and failure output; never expose an argument, identifier, row, payload, SQL statement, connection value, or exception detail.
- Do not change `db/schema.ts`, add a migration, add manual recovery SQL, automatically invoke recovery from deploy/startup/workers/schedules, call model generation or APNs from recovery, or bypass normal leases, retry policy, preferences, analysis workers, or notification workers.
- A second invocation with the recovered population must fail without mutation.
- Never run `drizzle-kit push`, push to `main`, merge a PR, or invoke the production recovery before the PR is merged and deployed through the normal release workflow.

---

## File Map

- Modify `lib/proactiveAnalysisRecovery.ts`: define the exact 14-row/8-workout/6-sleep contract, represent notification eligibility, validate locked and returned sets, and coordinate the all-or-nothing transaction.
- Modify `lib/proactiveAnalysisRecovery.test.ts`: exercise argument privacy, exact distribution, all eligibility/CAS failures, per-table and combined set equality, preservation, rollback, one-shot behavior, and count-only output.
- Modify `lib/proactiveAnalysisRecoveryDrizzle.ts`: project notification eligibility from both locked tables and add the one notification assignment plus both notification CAS predicates.
- Modify `lib/proactiveAnalysisRecoveryDrizzle.test.ts`: inspect both SQL update shapes and prove no unapproved assignment or missing predicate.
- Verify unchanged `scripts/recover-proactive-analysis-jobs.ts`: retain validation before dynamic database import, fixed failure output, and explicit operator-only invocation.
- Verify unchanged `db/schema.ts`, `db/migrations/`, `.github/workflows/`, `scripts/proactive-health-worker.ts`, and `package.json`: no schema, migration, deployment hook, worker hook, scheduled hook, alternate command, or manual SQL path.

---

### Task 1: Enforce the Exact 14-Row Recovery Contract

**Files:**
- Modify: `lib/proactiveAnalysisRecovery.test.ts`
- Modify: `lib/proactiveAnalysisRecovery.ts`

**Interfaces:**
- Consumes: `RecoveryStore.transaction<T>(operation: (tx: RecoveryTransaction) => Promise<T>): Promise<T>` and the existing operator-injected `now: Date` transaction time.
- Produces: `RECOVERY_JOB_COUNT = 14`, `RECOVERY_WORKOUT_COUNT = 8`, `RECOVERY_SLEEP_COUNT = 6`; `RecoveryRow` with `notificationState: string` and `notificationSentAt: Date | null`; unchanged `RecoveryTransaction.lockRows(ids: string[]): Promise<RecoveryRow[]>`, `RecoveryTransaction.recover(kind: RecoveryKind, ids: string[], now: Date): Promise<string[]>`, `parseRecoveryIds(argv: string[]): string[]`, `recoverProactiveAnalysisJobs(store: RecoveryStore, ids: string[], now: Date): Promise<RecoveryCounts>`, and `formatRecoveryCounts(counts: RecoveryCounts, success: boolean): string` signatures.

- [ ] **Step 1: Replace the nine-row fixtures with a representative 14-row, 8/6 eligible population**

In `lib/proactiveAnalysisRecovery.test.ts`, define synthetic canonical UUIDs and arrange the first eight as workout rows and the last six as sleep rows. These values are test-only counters, not production identifiers:

```ts
const ids = Array.from(
  { length: 14 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

const makeRows = (): FakeRow[] => ids.map((id, index) => ({
  id,
  kind: index < 8 ? 'workout' : 'sleep',
  status: 'failed',
  retryCount: index + 1,
  nextAttemptAt: new Date(`2026-06-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`),
  leaseToken: null,
  leaseExpiresAt: null,
  result: null,
  notificationState: 'failed',
  notificationRetryCount: 20 + index,
  notificationNextAttemptAt: new Date(`2026-08-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`),
  notificationLeaseToken: `notification-lease-${index}`,
  notificationLeaseExpiresAt: new Date(`2026-09-${String(index + 1).padStart(2, '0')}T03:00:00.000Z`),
  notificationSentAt: null,
  updatedAt: new Date(`2026-11-${String(index + 1).padStart(2, '0')}T05:00:00.000Z`),
  inputPayload: { source: `payload-${index}`, nested: { value: index } },
  userId: `user-${index}`,
  localDate: `2026-12-${String(index + 1).padStart(2, '0')}`,
  sourceId: `source-${index}`,
  deletedAt: null,
}));
```

Update the fake transaction's locked projection to include `notificationState` and `notificationSentAt`. Make its `recover` method require all five eligibility predicates and apply exactly the six approved assignments:

```ts
if (
  row.status !== 'failed'
  || row.leaseToken !== null
  || row.result !== null
  || row.notificationState !== 'failed'
  || row.notificationSentAt !== null
) continue;

row.status = 'pending';
row.retryCount = 0;
row.nextAttemptAt = recoveryNow;
row.leaseToken = null;
row.leaseExpiresAt = null;
row.notificationState = 'pending';
```

Retain transaction snapshot/rollback behavior. Add these narrowly scoped fake controls so later tests can prove each coordinator check rather than relying on one generic failure:

```ts
lockRowsTransform: (rows: RecoveryRow[]) => RecoveryRow[] = (rows) => rows;
beforeFirstRecover: (() => void) | null = null;
returnIdsTransform: (kind: RecoveryKind, ids: string[]) => string[] = (_kind, returnedIds) => returnedIds;
private ranBeforeRecover = false;
```

Apply `lockRowsTransform` only to the locked projection. At the start of `recover`, run `beforeFirstRecover` once before evaluating CAS predicates; after applying eligible mutations, return `returnIdsTransform(kind, recovered)`. This supports lock-set substitutions, distribution changes, concurrent eligibility changes, duplicate/foreign/cross-table returned IDs, and omissions while the existing transaction snapshot proves rollback.

- [ ] **Step 2: Write failing parser, distribution, eligibility, preservation, and returned-set tests**

Replace parser cases so counts 0 through 13 and 15 are rejected, and retain duplicate, uppercase, noncanonical, malformed, positional, missing-value, and unknown-flag cases. Add the exact success assertion:

```ts
test('parser returns exactly fourteen canonical UUIDs in input order', () => {
  assert.deepEqual(parseRecoveryIds(argv(ids)), ids);
});
```

Update the success test to assert exact counts rather than a summed split:

```ts
assert.deepEqual(counts, {
  requestedCount: 14,
  matchedCount: 14,
  eligibleCount: 14,
  workoutUpdatedCount: 8,
  sleepUpdatedCount: 6,
  totalUpdatedCount: 14,
});
```

For every row, clone the pre-recovery value, change only the five analysis fields and `notificationState`, and use `assert.deepEqual` against the complete row. This proves retry metadata, notification schedule and lease fields, null sent timestamp, payload, result, ownership, dates, source, `updatedAt`, and unrelated values remain unchanged.

Add table-driven rollback tests for each locked eligibility failure:

```ts
const eligibilityCases = [
  { name: 'pending analysis status', mutate: (row: FakeRow) => { row.status = 'pending'; } },
  { name: 'active analysis lease', mutate: (row: FakeRow) => { row.leaseToken = 'active-lease'; } },
  { name: 'existing analysis result', mutate: (row: FakeRow) => { row.result = { headline: 'existing' }; } },
  { name: 'pending notification state', mutate: (row: FakeRow) => { row.notificationState = 'pending'; } },
  { name: 'suppressed notification state', mutate: (row: FakeRow) => { row.notificationState = 'suppressed'; } },
  { name: 'sending notification state', mutate: (row: FakeRow) => { row.notificationState = 'sending'; } },
  { name: 'sent notification state', mutate: (row: FakeRow) => { row.notificationState = 'sent'; } },
  { name: 'sent notification timestamp', mutate: (row: FakeRow) => { row.notificationSentAt = now; } },
];
```

Each case must snapshot the entire fake store, call `recoverProactiveAnalysisJobs`, assert rejection, assert exact snapshot equality, and assert `opened === 1` and `commits === 0`. Add separate rollback tests for a missing row, duplicate locked ID, extra/foreign locked ID, changed locked ID, 9-workout/5-sleep and 7-workout/7-sleep distributions, a CAS miss caused by each of the five predicates, a duplicate returned ID, a foreign returned ID, a workout ID returned by the sleep update (and vice versa), and an omitted returned ID. Assert `recover` is never called for failures detected from locked rows.

Retain and update the second-invocation test so the first call commits a 14-row pending/pending population and the second call rejects with byte-for-byte equivalent state and exactly one total commit.

Update count-output fixtures to 14/14/14 with 8 workout and 6 sleep. For both success and failure, require every line to match `/^[a-z_]+=[0-9]+$/` and assert the output contains none of the synthetic IDs, field names, private errors, SQL, or connection strings.

- [ ] **Step 3: Run the focused test to establish RED**

Run:

```bash
npx tsx --test lib/proactiveAnalysisRecovery.test.ts
```

Expected: FAIL because `RECOVERY_JOB_COUNT` is still 9, `RecoveryRow` does not expose notification eligibility, the coordinator does not enforce the 8/6 split or exact locked/per-table returned sets, and successful fake recovery does not reset `notificationState`.

- [ ] **Step 4: Implement the minimal pure-contract changes**

In `lib/proactiveAnalysisRecovery.ts`, add exact constants and notification fields:

```ts
export const RECOVERY_JOB_COUNT = 14;
export const RECOVERY_WORKOUT_COUNT = 8;
export const RECOVERY_SLEEP_COUNT = 6;

export interface RecoveryRow {
  id: string;
  kind: RecoveryKind;
  status: string;
  retryCount: number;
  leaseToken: string | null;
  result: unknown;
  notificationState: string;
  notificationSentAt: Date | null;
}
```

Keep canonical UUID argument validation and fixed errors unchanged except for the count constant. Inside the single `store.transaction`, validate the locked set before any update:

```ts
const suppliedIds = new Set(ids);
const lockedIds = rows.map((row) => row.id);
if (
  rows.length !== RECOVERY_JOB_COUNT
  || new Set(lockedIds).size !== RECOVERY_JOB_COUNT
  || lockedIds.some((id) => !suppliedIds.has(id))
) {
  throw new Error('Proactive analysis recovery row mismatch.');
}
```

Then enforce all five row predicates and the exact distribution:

```ts
if (rows.some((row) => (
  row.status !== 'failed'
  || row.leaseToken !== null
  || row.result !== null
  || row.notificationState !== 'failed'
  || row.notificationSentAt !== null
))) {
  throw new Error('Proactive analysis recovery row is ineligible.');
}

const workoutIds = rows.filter((row) => row.kind === 'workout').map((row) => row.id);
const sleepIds = rows.filter((row) => row.kind === 'sleep').map((row) => row.id);
if (workoutIds.length !== RECOVERY_WORKOUT_COUNT || sleepIds.length !== RECOVERY_SLEEP_COUNT) {
  throw new Error('Proactive analysis recovery distribution mismatch.');
}
```

After both updates, compare each returned array to the corresponding requested table set, then compare the combined returned set to the supplied set. Use this helper so duplicates, omissions, substitutions, cross-table IDs, and foreign IDs all fail:

```ts
function hasExactIds(actual: string[], expected: string[]): boolean {
  const expectedIds = new Set(expected);
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && actual.every((id) => expectedIds.has(id));
}

if (
  !hasExactIds(workoutUpdatedIds, workoutIds)
  || !hasExactIds(sleepUpdatedIds, sleepIds)
  || !hasExactIds([...workoutUpdatedIds, ...sleepUpdatedIds], ids)
) {
  throw new Error('Proactive analysis recovery update mismatch.');
}
```

Throw before returning counts; the surrounding transaction supplies rollback.

- [ ] **Step 5: Run the pure recovery tests to establish GREEN**

Run:

```bash
npx tsx --test lib/proactiveAnalysisRecovery.test.ts
```

Expected: PASS with every parser, eligibility, distribution, set-equality, preservation, rollback, privacy, and one-shot test green.

- [ ] **Step 6: Type-check the new public recovery contract**

Run:

```bash
npx tsc --noEmit
```

Expected: PASS. The current adapter's explicit `RecoveryRow` assertion means type checking does not prove its runtime projection yet; Task 2's RED adapter test is the required runtime-contract proof.

- [ ] **Step 7: Commit the pure contract and tests**

```bash
git add lib/proactiveAnalysisRecovery.ts lib/proactiveAnalysisRecovery.test.ts
git commit -m "fix: enforce exact proactive recovery population"
```

Expected: one conventional commit containing only the coordinator and its unit tests.

---

### Task 2: Apply Notification Eligibility and Reset in the Drizzle Transaction

**Files:**
- Modify: `lib/proactiveAnalysisRecoveryDrizzle.test.ts`
- Modify: `lib/proactiveAnalysisRecoveryDrizzle.ts`

**Interfaces:**
- Consumes: Task 1's `RecoveryRow` fields `notificationState: string` and `notificationSentAt: Date | null`, plus unchanged `RecoveryTransaction.lockRows` and `RecoveryTransaction.recover` signatures.
- Produces: a Drizzle `RecoveryStore` whose locks expose all five eligibility values and whose compare-and-set update changes exactly the five approved analysis columns plus `notification_state`, returning only updated IDs.

- [ ] **Step 1: Write failing adapter assertions for notification projection, assignment, and CAS**

In `lib/proactiveAnalysisRecoveryDrizzle.test.ts`, make each locked table return a complete row containing `status`, `retryCount`, `leaseToken`, `result`, `notificationState: 'failed'`, and `notificationSentAt: null`. Assert `lockRows` preserves those two notification properties for both workout and sleep rows.

Replace the expected assignment-key assertion with exactly six keys:

```ts
assert.deepEqual(Object.keys(update.assigned).sort(), [
  'lease_expires_at',
  'lease_token',
  'next_attempt_at',
  'notification_state',
  'retry_count',
  'status',
]);
assert.deepEqual(update.assigned, {
  status: 'pending',
  retry_count: 0,
  next_attempt_at: now,
  lease_token: null,
  lease_expires_at: null,
  notification_state: 'pending',
});
```

Compile each workout and sleep `where` expression through `PgDialect` and require predicates for `id IN (...)`, failed status, null analysis lease, null result, failed notification state, and null notification sent timestamp. Require exact parameters `['requested-id', 'failed', 'failed']`. Continue to require the returning selection to contain only `id`.

- [ ] **Step 2: Run the adapter test to establish RED**

Run:

```bash
npx tsx --test lib/proactiveAnalysisRecoveryDrizzle.test.ts
```

Expected: FAIL because locked rows omit notification eligibility, the update omits `notification_state`, and its compare-and-set predicate omits `notification_state = 'failed'` and `notification_sent_at IS NULL`.

- [ ] **Step 3: Implement the minimal Drizzle adapter change**

Add these selections to the workout locked-table query in `lib/proactiveAnalysisRecoveryDrizzle.ts`:

```ts
notificationState: schema.workout_analyses.notification_state,
notificationSentAt: schema.workout_analyses.notification_sent_at,
```

Add the corresponding selections to the sleep locked-table query:

```ts
notificationState: schema.sleep_analyses.notification_state,
notificationSentAt: schema.sleep_analyses.notification_sent_at,
```

Do not introduce a discovery query or broader selector.

Add only `notification_state: 'pending'` to the update assignment and add both notification predicates to the existing compare-and-set:

```ts
const rows = await transaction.update(table).set({
  status: 'pending',
  retry_count: 0,
  next_attempt_at: now,
  lease_token: null,
  lease_expires_at: null,
  notification_state: 'pending',
}).where(and(
  inArray(table.id, requestedIds),
  eq(table.status, 'failed'),
  isNull(table.lease_token),
  isNull(table.result),
  eq(table.notification_state, 'failed'),
  isNull(table.notification_sent_at),
)).returning({ id: table.id });
```

Do not assign notification retry counts, schedule, lease fields, sent timestamp, payloads, `result`, `updated_at`, or any other column.

- [ ] **Step 4: Run focused recovery tests to establish GREEN**

Run:

```bash
npx tsx --test \
  lib/proactiveAnalysisRecovery.test.ts \
  lib/proactiveAnalysisRecoveryDrizzle.test.ts
```

Expected: PASS for the coordinator and both-table SQL adapter suites.

- [ ] **Step 5: Run type checking and lint for the completed interface**

Run:

```bash
npx tsc --noEmit
npm run lint -- --max-warnings=0 \
  lib/proactiveAnalysisRecovery.ts \
  lib/proactiveAnalysisRecovery.test.ts \
  lib/proactiveAnalysisRecoveryDrizzle.ts \
  lib/proactiveAnalysisRecoveryDrizzle.test.ts \
  scripts/recover-proactive-analysis-jobs.ts
```

Expected: both commands exit 0 with no type or lint errors.

- [ ] **Step 6: Commit the transactional adapter and tests**

```bash
git add lib/proactiveAnalysisRecoveryDrizzle.ts lib/proactiveAnalysisRecoveryDrizzle.test.ts
git commit -m "fix: reset failed proactive notification state"
```

Expected: one conventional commit containing only the adapter and its SQL-shape test.

---

### Task 3: Prove Guardrails, Verify the Branch, and Open the PR

**Files:**
- Verify unchanged: `scripts/recover-proactive-analysis-jobs.ts`
- Verify unchanged: `db/schema.ts`
- Verify unchanged: `db/migrations/`
- Verify unchanged: `.github/workflows/`
- Verify unchanged: `scripts/proactive-health-worker.ts`
- Verify unchanged: `package.json`
- Verify changed only as specified: `lib/proactiveAnalysisRecovery.ts`
- Verify changed only as specified: `lib/proactiveAnalysisRecovery.test.ts`
- Verify changed only as specified: `lib/proactiveAnalysisRecoveryDrizzle.ts`
- Verify changed only as specified: `lib/proactiveAnalysisRecoveryDrizzle.test.ts`

**Interfaces:**
- Consumes: the complete Task 1 coordinator and Task 2 transactional adapter.
- Produces: a reviewed feature branch and ready PR; it does not execute production recovery or change runtime invocation paths.

- [ ] **Step 1: Verify the recovery command still validates before database access and emits fixed failure output**

Inspect `scripts/recover-proactive-analysis-jobs.ts` and require this order to remain unchanged:

```ts
const ids = parseRecoveryIds(argv);
const { db, schema } = await import('@/db');
```

Run this executable ordering check:

```bash
node -e "const fs=require('node:fs');const s=fs.readFileSync('scripts/recover-proactive-analysis-jobs.ts','utf8');const parse=s.indexOf('const ids = parseRecoveryIds(argv)');const load=s.indexOf(\"await import('@/db')\");if(parse<0||load<0||parse>=load)process.exit(1)"
```

Expected: exit 0. Require the failure handler to call only `formatRecoveryCounts(emptyCounts(), false)` and set a nonzero exit code. Confirm there is no exception interpolation, identifier logging, database import before argument validation, built-in ID source, or automatic invocation.

- [ ] **Step 2: Run repository guardrail audits**

Run from the feature worktree:

```bash
base="$(git merge-base HEAD origin/main)"
git diff --exit-code "$base" -- db/schema.ts db/migrations .github/workflows scripts/proactive-health-worker.ts package.json
git diff --check "$base"..HEAD
git diff --name-only "$base"..HEAD
rg -n "recoverProactiveAnalysisJobs|recover:proactive-analysis|recover-proactive-analysis-jobs" \
  --glob '!docs/superpowers/**' \
  --glob '!lib/proactiveAnalysisRecovery*' \
  --glob '!scripts/recover-proactive-analysis-jobs.ts' \
  --glob '!package.json' .
rg -n -i "update[[:space:]]+(workout_analyses|sleep_analyses)|manual sql|production ids?|fallback ids?|recovery ids?" \
  docs scripts lib --glob '!docs/superpowers/specs/2026-07-13-proactive-notification-recovery-correction-design.md' \
  --glob '!docs/superpowers/plans/2026-07-13-proactive-notification-recovery-correction.md'
```

Expected: unchanged-path diff and `git diff --check` exit 0; the changed-file list contains only the approved spec/plan and four recovery implementation/test files; invocation search finds no automatic call site; the broad-selector/manual-SQL/embedded-ID audit finds no recovery instructions or ID source. Review any unrelated textual match rather than deleting valid application code.

- [ ] **Step 3: Run focused recovery, proactive worker, and notification ownership tests**

Run:

```bash
npx tsx --test \
  lib/proactiveAnalysisRecovery.test.ts \
  lib/proactiveAnalysisRecoveryDrizzle.test.ts \
  lib/proactiveHealthLeaseSemantics.test.ts \
  lib/proactiveHealthRepositoryBoundary.test.ts \
  lib/proactiveHealthWorker.test.ts \
  lib/proactiveHealthWorkerSupport.test.ts
```

Expected: PASS, proving recovery remains bounded and normal worker claim/retry/notification ownership is unchanged.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
export PATH="/Users/simantstha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
npx tsx --test lib/*.test.ts
npx tsc --noEmit
npm run lint -- --max-warnings=0
npm run build:worker
DATABASE_URL=postgresql://test:test@localhost:5432/test npm run build
```

Expected: every test passes, typecheck and lint exit 0, the worker bundle succeeds, and the production Next.js build exits 0; a pre-existing Next.js middleware deprecation warning is non-blocking.

- [ ] **Step 5: Review the final diff against every approved invariant**

Run:

```bash
base="$(git merge-base HEAD origin/main)"
git diff --stat "$base"..HEAD
git diff "$base"..HEAD -- \
  lib/proactiveAnalysisRecovery.ts \
  lib/proactiveAnalysisRecovery.test.ts \
  lib/proactiveAnalysisRecoveryDrizzle.ts \
  lib/proactiveAnalysisRecoveryDrizzle.test.ts \
  scripts/recover-proactive-analysis-jobs.ts
git status --short
```

Expected: exactly 14 inputs; exactly 8 workout and 6 sleep; all five eligibility predicates at lock and CAS time; per-table and combined returned-set equality; only six assignments; count-only output; no production identifiers; no schema, migration, automatic invocation, model, APNs, broad selector, or manual SQL path; clean worktree after committed plan and implementation.

- [ ] **Step 6: Push the feature branch and open a ready PR**

```bash
git push -u origin feat/recover-proactive-notifications
gh pr create \
  --base main \
  --head feat/recover-proactive-notifications \
  --title "fix: recover failed proactive notifications" \
  --body "$(cat <<'PR_BODY'
## Summary
- expand the one-shot recovery contract to exactly 14 operator-selected analyses with an exact 8-workout/6-sleep split
- require failed analysis and notification eligibility at lock and compare-and-set time
- atomically reset the five analysis retry fields and only notification_state while preserving all other notification and payload data

## Verification
- focused recovery and proactive worker suites
- full test suite
- TypeScript typecheck and ESLint
- proactive worker bundle and production build
- schema, migration, invocation, privacy, and SQL-path guardrail audits

## Rollout
- deployment does not invoke recovery
- after merge and a green release, an operator will reconfirm eligibility and invoke the command once with the 14 privately held IDs
PR_BODY
)"
```

Expected: the branch is pushed and a non-draft PR against `main` is opened. Stop without merging.

---

## Post-Merge One-Time Recovery and Verification Runbook

These steps are operational gates after the user merges the PR. They must not be encoded as automatic deployment behavior, committed identifiers, or manual SQL.

- [ ] **Step 1: Confirm the release succeeded before touching the recovery population**

```bash
release_run_id="$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$release_run_id"
gh run watch "$release_run_id" --exit-status --interval 30
gh run view "$release_run_id" --json status,conclusion,jobs
```

Expected: version, backend, and iOS jobs all report `success`; do not invoke recovery against an unverified deployment.

- [ ] **Step 2: Reconfirm the private operator-held population through the existing read-only production query path**

Expected: exactly 14 distinct supplied rows, exactly 8 workout and 6 sleep; every row has failed analysis state, null analysis lease, null result, failed notification state, null notification sent timestamp, and zero prior push attempts. Capture count-only pre-recovery evidence for notification retry metadata, schedule, leases, sent timestamps, payload integrity, and total rows; do not copy IDs or row content into source, task logs, PR comments, or committed artifacts.

- [ ] **Step 3: Invoke the deployed application command exactly once**

In the authorized production execution environment, construct repeated `--id` arguments from the operator's private 14-ID input and pass them directly to the deployed `npm run recover:proactive-analysis --` command. Do not paste identifiers into shell history, chat, logs, source files, environment defaults, or this runbook.

Expected fixed output:

```text
requested_count=14
matched_count=14
eligible_count=14
workout_updated_count=8
sleep_updated_count=6
total_updated_count=14
success_count=1
```

Any other output means the transaction rolled back. Stop, investigate the eligibility or concurrency mismatch through the application boundary, and do not broaden the selector or use manual SQL.

- [ ] **Step 4: Verify the atomic transition and preservation without exposing IDs**

Expected count-only evidence: all 14 rows left failed analysis state; all 14 changed from failed to pending notification state in the same transaction; the 8/6 distribution is unchanged; notification retry counts, next-attempt timestamps, lease tokens, lease expirations, sent timestamps, payloads, result, ownership, dates, sources, and unrelated fields match the captured pre-recovery values; zero additional rows changed.

- [ ] **Step 5: Observe normal analysis and notification workers**

Expected: normal workers claim the 14 analyses only after commit, produce ready analyses or follow existing bounded retry behavior, and the notification worker creates observable push attempts for the recovered rows. APNs success and retry outcomes must follow existing preferences, lease, and retry contracts; recovery itself must create no push attempt.

- [ ] **Step 6: Prove one-shot behavior through read-only state, not a second production mutation attempt**

Expected: the recovered rows no longer satisfy `status = 'failed'` and `notification_state = 'failed'`, so the same population is ineligible for replay. Do not invoke the production command a second time merely to demonstrate rejection; the unit test is the mutation-safe proof of second-call rollback.
