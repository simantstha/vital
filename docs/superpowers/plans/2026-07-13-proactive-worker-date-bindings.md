# Proactive Worker Date Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore workout, sleep, and morning-brief processing by serializing raw-SQL timestamps correctly and making worker failures observable without exposing private data.

**Architecture:** Put raw timestamp conversion and error-event shaping in one dependency-free support module so they can be tested without database or secret initialization. Repository methods use ISO strings only inside raw `sql` interpolations while retaining `Date` objects for typed Drizzle operations and domain logic. The worker reports a fixed stage to its loop, which emits one allowlisted, sanitized structured event on failure and continues polling.

**Tech Stack:** TypeScript, Node.js `node:test`, Drizzle ORM 0.45, postgres.js 3.4, Fly.io worker process

## Global Constraints

- Do not add or change database schema, migrations, indexes, APNs configuration, provisioning, retry policy, lease duration, notification ordering, or morning-slot ownership.
- Use ISO-8601 strings only for timestamp values interpolated into raw Drizzle `sql` fragments; keep `Date` objects in typed `.set(...)`, `.values(...)`, and in-memory transitions.
- Error logs may contain only `event`, an allowlisted `stage`, `errorName`, and an optional string or numeric `code`.
- Never log arbitrary messages, stacks, causes, SQL, query parameters, health content, IDs, device tokens, secrets, or environment values.
- The worker must keep its existing catch-wait-continue polling behavior.
- Work only on `feat/fix-proactive-worker-date-bindings`; never push or merge `main`.

---

### Task 1: Add the raw-SQL timestamp boundary

**Files:**
- Create: `lib/proactiveHealthWorkerSupport.ts`
- Create: `lib/proactiveHealthWorkerSupport.test.ts`

**Interfaces:**
- Produces: `rawSqlTimestamp(date: Date): string`
- Produces: `rawSqlTimeBindings(now: Date, leaseMs: number): { now: string; lease: string }`
- Consumes: no database, environment, APNs, or worker dependencies

- [ ] **Step 1: Write failing timestamp tests**

Create `lib/proactiveHealthWorkerSupport.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { rawSqlTimeBindings, rawSqlTimestamp } from './proactiveHealthWorkerSupport';

test('raw SQL timestamps are ISO strings rather than Date instances', () => {
  const now = new Date('2026-07-13T12:34:56.789Z');
  const bindings = rawSqlTimeBindings(now, 5 * 60_000);

  assert.deepEqual(bindings, {
    now: '2026-07-13T12:34:56.789Z',
    lease: '2026-07-13T12:39:56.789Z',
  });
  assert.equal(typeof bindings.now, 'string');
  assert.equal(typeof bindings.lease, 'string');
  assert.equal(Object.values(bindings).some((value: unknown) => value instanceof Date), false);
});

test('raw SQL timestamp conversion rejects invalid dates before query execution', () => {
  assert.throws(
    () => rawSqlTimestamp(new Date(Number.NaN)),
    (error: unknown) => error instanceof TypeError && error.message === 'Invalid raw SQL timestamp.',
  );
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts
```

Expected: FAIL because `./proactiveHealthWorkerSupport` does not exist.

- [ ] **Step 3: Implement the pure timestamp helpers**

Create `lib/proactiveHealthWorkerSupport.ts` with:

```ts
export interface RawSqlTimeBindings {
  now: string;
  lease: string;
}

export function rawSqlTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid raw SQL timestamp.');
  return date.toISOString();
}

export function rawSqlTimeBindings(now: Date, leaseMs: number): RawSqlTimeBindings {
  return {
    now: rawSqlTimestamp(now),
    lease: rawSqlTimestamp(new Date(now.getTime() + leaseMs)),
  };
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts
```

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit the timestamp boundary**

```bash
git add lib/proactiveHealthWorkerSupport.ts lib/proactiveHealthWorkerSupport.test.ts
git commit -m "fix: serialize proactive worker SQL timestamps"
```

---

### Task 2: Route every proactive raw timestamp through the boundary

**Files:**
- Modify: `lib/proactiveHealthWorkerRepository.ts:1-124`
- Test: `lib/proactiveHealthWorkerSupport.test.ts`

**Interfaces:**
- Consumes: `rawSqlTimestamp(date: Date): string`
- Consumes: `rawSqlTimeBindings(now: Date, leaseMs: number): { now: string; lease: string }`
- Preserves: all exported repository signatures, `LEASE_MS = 5 * 60_000`, typed Drizzle writes, transaction locking, and return values

- [ ] **Step 1: Add a source-boundary regression test and confirm RED**

Append this test to `lib/proactiveHealthWorkerSupport.test.ts`. It checks the repository contract without importing the database module:

```ts
import { readFileSync } from 'node:fs';

test('proactive repository does not interpolate Date variables at raw SQL boundaries', () => {
  const source = readFileSync(new URL('./proactiveHealthWorkerRepository.ts', import.meta.url), 'utf8');
  const rawTemplates = [...source.matchAll(/sql(?:<[^`]+>)?`[\s\S]*?`/g)].map(([template]) => template);

  assert.ok(rawTemplates.length >= 10);
  for (const template of rawTemplates) {
    assert.doesNotMatch(template, /\$\{now\}/);
    assert.doesNotMatch(template, /\$\{lease\}/);
  }
});
```

Run:

```bash
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts
```

Expected: FAIL because the current repository raw templates still contain `${now}` and `${lease}`.

- [ ] **Step 2: Import the boundary and update analysis claim queries**

Add this import to `lib/proactiveHealthWorkerRepository.ts`:

```ts
import { rawSqlTimeBindings, rawSqlTimestamp } from './proactiveHealthWorkerSupport';
```

At the beginning of `claimAnalysisJobs`, replace the standalone lease calculation with:

```ts
const lease = new Date(now.getTime() + LEASE_MS);
const { now: nowSql, lease: leaseSql } = rawSqlTimeBindings(now, LEASE_MS);
```

In both the sleep and workout raw claim templates, make the exhaustive substitutions:

```text
${now}  -> ${nowSql}
${lease} -> ${leaseSql}
```

The typed `lease` variable is no longer used by those raw statements and should be removed. The resulting method starts with only:

```ts
const { now: nowSql, lease: leaseSql } = rawSqlTimeBindings(now, LEASE_MS);
```

Keep `capacity`, `token`, `FOR UPDATE SKIP LOCKED`, sleep reservation, and result mapping unchanged.

- [ ] **Step 3: Update raw notification eligibility predicates**

In `suppressNotification`, compute `const nowSql = rawSqlTimestamp(now);` and use `${nowSql}` in the expired-sending predicate while continuing to pass `now` to typed `updated_at`.

At the beginning of `claimNotification`, after the token, add:

```ts
const nowSql = rawSqlTimestamp(now);
```

Use `${nowSql}` in all four raw timestamp comparisons in this method:

```ts
sql`${schema.morning_notification_slots.next_attempt_at} <= ${nowSql}`
sql`(${schema.morning_notification_slots.status} = 'failed' or (${schema.morning_notification_slots.status} = 'claimed' and ${schema.morning_notification_slots.lease_expires_at} <= ${nowSql}))`
sql`${t.notification_next_attempt_at} <= ${nowSql}`
sql`(${t.notification_state} = 'pending' or (${t.notification_state} = 'sending' and ${t.notification_lease_expires_at} <= ${nowSql}))`
```

Keep `now` and `lease` as `Date` objects in `.set(...)`, `.values(...)`, `localMinute`, and `suppressNotification` calls.

- [ ] **Step 4: Update candidate and morning-brief raw queries**

At the start of `listReadyNotificationCandidates`, add:

```ts
const nowSql = rawSqlTimestamp(now);
```

Use `${nowSql}` for all four raw comparisons in the workout/sleep union. Keep the original `now` in the `notificationClaimable(...)` in-memory check.

At the start of `claimDueMorningBriefs`, add:

```ts
const nowSql = rawSqlTimestamp(now);
```

Use `${nowSql}` in all five `at time zone p.timezone` interpolations. In `tryRecover`, use `${nowSql}` for `next_attempt_at` and expired `lease_expires_at` comparisons. Keep the original `now`/`lease` `Date` values in inserts, typed updates, candidate transitions, and return objects.

- [ ] **Step 5: Run boundary and existing transition tests and confirm GREEN**

Run:

```bash
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts lib/proactiveHealthLeaseSemantics.test.ts lib/proactiveHealthWorker.test.ts
```

Expected: all tests pass; the source-boundary test sees no `${now}` or `${lease}` in any raw template.

Run:

```bash
npm run build:worker
```

Expected: esbuild exits 0 and writes `dist/proactive-health-worker.cjs`.

- [ ] **Step 6: Commit repository integration**

```bash
git add lib/proactiveHealthWorkerRepository.ts lib/proactiveHealthWorkerSupport.test.ts
git commit -m "fix: bind proactive worker query dates as strings"
```

---

### Task 3: Emit sanitized stage-aware worker failures

**Files:**
- Modify: `lib/proactiveHealthWorkerSupport.ts`
- Modify: `lib/proactiveHealthWorkerSupport.test.ts`
- Modify: `scripts/proactive-health-worker.ts:21-38`

**Interfaces:**
- Produces: `WorkerStage`, the exact union of the seven stages in the approved spec
- Produces: `workerErrorEvent(stage: WorkerStage, error: unknown): WorkerErrorEvent`
- Produces: `WorkerErrorEvent = { event: 'proactive_worker_error'; stage: WorkerStage; errorName: string; code?: string | number }`
- Consumes: `console.error(JSON.stringify(workerErrorEvent(stage, error)))` as the only failure logging boundary

- [ ] **Step 1: Write failing diagnostic redaction tests**

Extend the support-module import in `lib/proactiveHealthWorkerSupport.test.ts` to include `workerErrorEvent`, then append:

```ts
test('worker diagnostics expose only allowlisted stage and safe error metadata', () => {
  const error = Object.assign(new Error('user u1 device secret-token SQL select *'), {
    code: 'ERR_INVALID_ARG_TYPE',
    cause: new Error('private cause'),
    deviceToken: 'secret-token',
  });

  const event = workerErrorEvent('claim-analysis-jobs', error);

  assert.deepEqual(event, {
    event: 'proactive_worker_error',
    stage: 'claim-analysis-jobs',
    errorName: 'Error',
    code: 'ERR_INVALID_ARG_TYPE',
  });
  const serialized = JSON.stringify(event);
  for (const forbidden of ['user u1', 'secret-token', 'select *', 'private cause', 'message', 'stack', 'cause']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('worker diagnostics normalize unknown throws and discard unsafe codes', () => {
  assert.deepEqual(workerErrorEvent('process-morning-brief', 'private health content'), {
    event: 'proactive_worker_error',
    stage: 'process-morning-brief',
    errorName: 'UnknownError',
  });
  const customNamedError = Object.assign(new Error('private'), { name: 'user-u1-secret', code: 'secret-token' });
  assert.deepEqual(workerErrorEvent('deliver-notification', customNamedError), {
    event: 'proactive_worker_error',
    stage: 'deliver-notification',
    errorName: 'Error',
  });
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts
```

Expected: FAIL because `workerErrorEvent` is not exported.

- [ ] **Step 3: Implement the diagnostic event contract**

Append to `lib/proactiveHealthWorkerSupport.ts`:

```ts
export const WORKER_STAGES = [
  'ensure-default-preferences',
  'claim-analysis-jobs',
  'process-analysis-job',
  'list-notification-candidates',
  'deliver-notification',
  'claim-morning-briefs',
  'process-morning-brief',
] as const;

export type WorkerStage = (typeof WORKER_STAGES)[number];

export interface WorkerErrorEvent {
  event: 'proactive_worker_error';
  stage: WorkerStage;
  errorName: string;
  code?: string | number;
}

const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'PostgresError', 'DrizzleQueryError']);
const SAFE_STRING_CODE = /^(?:ERR_[A-Z0-9_]{1,59}|[0-9A-Z]{5})$/;

export function workerErrorEvent(stage: WorkerStage, error: unknown): WorkerErrorEvent {
  const candidateName = error instanceof Error ? error.name : 'UnknownError';
  const errorName = SAFE_ERROR_NAMES.has(candidateName) ? candidateName : error instanceof Error ? 'Error' : 'UnknownError';
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const base: WorkerErrorEvent = { event: 'proactive_worker_error', stage, errorName };
  if (typeof code === 'string' && SAFE_STRING_CODE.test(code)) return { ...base, code };
  if (typeof code === 'number' && Number.isFinite(code)) return { ...base, code };
  return base;
}
```

- [ ] **Step 4: Replace silent catches with stage reporting**

Import `workerErrorEvent` and `type WorkerStage` into `scripts/proactive-health-worker.ts`.

Change `tick` to accept a stage reporter and set the stage immediately before every awaited stage:

```ts
async function tick(reportStage: (stage: WorkerStage) => void): Promise<void> {
  const now = new Date();
  reportStage('ensure-default-preferences');
  await ensureDefaultPreferencesForRegisteredUsers();

  reportStage('claim-analysis-jobs');
  const jobs = await claimAnalysisJobs(now);
  for (const job of jobs) {
    reportStage('process-analysis-job');
    await runClaimedAnalysis(job, workerRepository, analyze, (device, result) => apns.send(device, result, { type: `${job.kind}_analysis`, id: job.id, deepLink: `vital://${job.kind}-analysis/${job.id}` }), now);
  }

  reportStage('list-notification-candidates');
  const candidates = await listReadyNotificationCandidates(now);
  for (const candidate of candidates) {
    reportStage('deliver-notification');
    const token = await workerRepository.claimNotification(candidate.job, now);
    if (token) await deliverNotification(candidate.job, candidate.result, token, workerRepository, (device, result) => apns.send(device, result, { type: `${candidate.job.kind}_analysis`, id: candidate.job.id, deepLink: `vital://${candidate.job.kind}-analysis/${candidate.job.id}` }), now);
  }

  reportStage('claim-morning-briefs');
  const claims = await claimDueMorningBriefs(now);
  for (const claim of claims) {
    reportStage('process-morning-brief');
    const job: AnalysisJob = { id: claim.idempotencyKey, kind: 'sleep', userId: claim.userId, localDate: claim.localDate, input: { purpose: 'morning brief' }, retryCount: 0, notificationRetryCount: claim.retryCount, leaseToken: claim.leaseToken };
    try {
      const context = await workerRepository.getContext(job);
      const result = validateGroundedAnalysis(parseCoachAnalysis(await analyze(job, context)), { input: job.input, context });
      await completeMorningBrief(claim, result, (device, value) => apns.send(device, value, { type: 'morning_brief', deepLink: 'vital://today' }), now);
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent('process-morning-brief', error)));
      await failMorningBrief(claim, new Date());
    }
  }
}
```

Replace the one-line `main` with:

```ts
async function main(): Promise<void> {
  for (;;) {
    let stage: WorkerStage = 'ensure-default-preferences';
    try {
      await tick((nextStage) => { stage = nextStage; });
    } catch (error) {
      console.error(JSON.stringify(workerErrorEvent(stage, error)));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
```

Do not add any other `console` output. In particular, do not pass an error object directly to `console.error`.

- [ ] **Step 5: Run diagnostics, worker, and transition tests and confirm GREEN**

Run:

```bash
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts lib/proactiveHealthWorker.test.ts lib/proactiveHealthLeaseSemantics.test.ts
```

Expected: all tests pass; diagnostic assertions prove sensitive properties are absent.

Run:

```bash
npm run build:worker
```

Expected: esbuild exits 0; `WorkerStage` and event imports resolve in the bundled worker.

- [ ] **Step 6: Commit sanitized diagnostics**

```bash
git add lib/proactiveHealthWorkerSupport.ts lib/proactiveHealthWorkerSupport.test.ts scripts/proactive-health-worker.ts
git commit -m "fix: log sanitized proactive worker failures"
```

---

### Task 4: Complete local verification and prepare the PR

**Files:**
- Verify only: all files changed in Tasks 1-3
- Do not create: schema files or `db/migrations/*`

**Interfaces:**
- Consumes: final branch commits from Tasks 1-3
- Produces: evidence that tests and production bundles succeed before push/PR

- [ ] **Step 1: Run the complete backend test suite**

```bash
npx tsx --test lib/*.test.ts lib/specialists/*.test.ts lib/brain/*.test.ts db/*.test.ts
```

Expected: all discovered Node tests pass with 0 failures.

- [ ] **Step 2: Run lint and both production builds**

```bash
npm run lint
npm run build:worker
npm run build
```

Expected: all commands exit 0; Next.js production build completes and the worker bundle is emitted.

- [ ] **Step 3: Audit scope and privacy**

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD -- db/schema.ts db/migrations
rg -n "console\.(log|warn|error)" scripts/proactive-health-worker.ts lib/proactiveHealthWorkerSupport.ts
git status --short
```

Expected: no whitespace errors; no schema/migration diff; exactly the two intentional sanitized `console.error(JSON.stringify(workerErrorEvent(...)))` calls; clean worktree.

- [ ] **Step 4: Push the feature branch and open, but do not merge, the PR**

```bash
git push -u origin feat/fix-proactive-worker-date-bindings
gh pr create --base main --head feat/fix-proactive-worker-date-bindings --title "fix: restore proactive notification worker processing" --body "Fixes raw Date bindings in proactive worker SQL, adds privacy-safe stage diagnostics, and covers both with regression tests. No schema changes."
```

Expected: branch push succeeds and GitHub returns a PR URL. Stop without merging.

## Post-merge rollout verification

The user performs the merge. After the automatic release succeeds, verify production without mutating queued rows:

```bash
RELEASE_RUN_ID=$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RELEASE_RUN_ID" --json status,conclusion,jobs
fly status -a vital-coach
fly logs -a vital-coach --no-tail
```

Expected: release jobs and worker machine are healthy; no repeated `proactive_worker_error` at `claim-analysis-jobs`; logs contain only the approved event fields. Through the existing read-only production query path, confirm due workout and sleep rows leave `pending`, notification states reach `sent` or an explicit APNs retry/failure, and push-attempt rows appear. Then ingest one workout and one sleep record and confirm each is processed on the next eligible worker poll.
