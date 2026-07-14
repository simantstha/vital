# Proactive Notification Recovery Correction Design

**Date:** 2026-07-13
**Status:** Approved for implementation planning

## Summary

The evidence-token grounding release corrected proactive analysis generation, but the approved one-shot recovery does not make the affected notifications claimable. Production inspection confirmed 14 eligible terminal analysis rows: 8 workout analyses and 6 sleep analyses. All 14 have `notification_state = 'failed'`, and there have been zero push attempts for them. Requeueing analysis work while preserving that terminal notification state cannot produce an APNs attempt.

This correction expands the bounded recovery contract from exactly nine rows to exactly 14 operator-supplied rows and atomically resets each row's analysis retry fields together with `notification_state = 'pending'`. It preserves every other notification field, the analysis payload, and all unrelated data. The correction also ships the existing TypeScript command as a dedicated Node.js bundle in the backend image so an operator can invoke it on the Fly worker after deployment. It remains a one-shot manual action implemented through the application recovery boundary; it is not a general retry facility.

## Confirmed production evidence

- Exactly 14 terminal rows satisfy the intended recovery population.
- The population is exactly 8 workout rows and 6 sleep rows.
- Every row has failed analysis state, no result, no active analysis lease, failed notification state, and no notification sent timestamp.
- There have been zero push attempts for these rows.
- The failed notification state is terminal for the notification claimer, so analysis requeue by itself cannot cause APNs delivery.

The production identifiers are operational input. They must not be committed to source, tests, fixtures, examples, documentation, logs, or defaults.

## Goals

- Recover exactly 14 operator-selected production rows in one all-or-nothing transaction.
- Require every selected row to remain eligible at lock and update time.
- Requeue analysis processing and make its notification claimable in the same atomic change.
- Preserve the existing privacy-safe argument, output, and error contracts.
- Preserve payloads, notification retry metadata, and all unrelated fields.
- Make a second invocation against the recovered rows fail without mutation.
- Ship a directly executable recovery artifact in the deployed backend image.
- Verify that normal workers process the rows and that notification delivery produces observable push attempts after commit.

## Non-goals

- Embedding production IDs anywhere in the repository.
- Changing either analysis-table schema or adding a database migration.
- Automatically invoking recovery during deploy, startup, worker execution, or a scheduled job.
- Adding a recovery process group, entrypoint hook, release step, worker loop call, or package lifecycle hook.
- Running or documenting manual SQL as an operational alternative.
- Sweeping arbitrary failed rows or accepting any count other than exactly 14.
- Resetting notification retry counters, notification scheduling, notification leases, notification sent timestamps, payloads, or other notification fields.
- Bypassing normal analysis workers, notification workers, leases, retry policy, APNs delivery, or notification preferences.

## Invocation contract

The recovery command accepts exactly 14 unique canonical UUIDs supplied by the operator as repeated `--id` flags. It has no built-in IDs, fallback list, environment-based ID source, broad selector, or discovery query.

Argument validation occurs before database import or connection. It rejects:

- fewer or more than 14 IDs;
- duplicate IDs;
- positional arguments or unknown flags;
- malformed, uppercase, or otherwise noncanonical UUIDs.

Failure output remains fixed and count-only. It must not echo an argument, identifier, row, payload, database value, SQL statement, connection value, or exception detail.

## Deployable recovery artifact

The repository adds a separate `build:recovery` package script that bundles `scripts/recover-proactive-analysis-jobs.ts` with esbuild for Node.js 22 at `dist/recover-proactive-analysis-jobs.cjs`. The Docker builder runs `npm run build:recovery` after the application and worker builds. The existing `COPY --from=builder /app/dist ./dist` copies both worker and recovery bundles into the runtime image; no additional runtime copy, dependency install, entrypoint, command, process group, or automatic invocation is added.

The deployed artifact is invoked manually on an existing Fly worker machine as:

```text
node dist/recover-proactive-analysis-jobs.cjs [fourteen repeated --id arguments]
```

The bracketed text is operational notation only and must never be replaced by a production identifier in source, tests, fixtures, examples, documentation, logs, or defaults. At invocation time, the operator supplies all 14 private identifiers as repeated command-line flags. The bundle has no embedded identifiers and does not read identifiers from environment variables, files, database discovery, or defaults.

Argument parsing must still happen before the bundled database module is initialized. An invalid-argument smoke test runs the built artifact without `DATABASE_URL`, instruments access to that environment key, and requires the fixed count-only failure with exit status 1 and zero `DATABASE_URL` reads. This proves the deployable bundle preserves validation-before-database-access behavior rather than relying only on source order.

## Eligibility contract

Within one transaction, the recovery locks matching rows across `workout_analyses` and `sleep_analyses`. The locked population must contain exactly the 14 distinct supplied IDs, with exactly 8 workout rows and 6 sleep rows.

Every locked row must satisfy all of these predicates:

- `status = 'failed'`;
- `lease_token IS NULL`;
- `result IS NULL`;
- `notification_state = 'failed'`;
- `notification_sent_at IS NULL`.

These same predicates, including the notification predicates, are compare-and-set conditions on each update. A missing row, duplicate match, wrong table distribution, changed field, or update miss makes the entire operation fail and roll back. No partial recovery may commit.

## Atomic state transition

For every eligible row, the transaction assigns exactly these analysis recovery fields:

- `status = 'pending'`;
- `retry_count = 0`;
- `next_attempt_at = transaction time`;
- `lease_token = NULL`;
- `lease_expires_at = NULL`.

It additionally assigns exactly one notification field:

- `notification_state = 'pending'`.

The transaction must require the returned workout and sleep ID sets, their 8/6 counts, and their combined 14-ID set to equal the validated input population. Any mismatch rolls back all updates.

The recovery does not perform model generation or notification delivery. Normal analysis and notification workers may claim the rows only after the transaction commits.

## Preservation contract

Apart from the five analysis assignments and the single notification-state assignment above, every field remains unchanged. In particular, recovery preserves:

- `notification_retry_count`;
- `notification_next_attempt_at`;
- `notification_lease_token`;
- `notification_lease_expires_at`;
- `notification_sent_at`;
- analysis input and context payloads;
- user, source, date, and ownership fields;
- `result` and every other unrelated field.

The recovery does not explicitly assign `updated_at`; normal database behavior, if any, remains unchanged. It does not create a notification attempt itself.

## Failure behavior and idempotence

All validation, locking, eligibility checks, updates, and returned-set checks occur inside the single recovery operation. Any error aborts and rolls back the transaction.

After a successful recovery, the rows no longer meet either `status = 'failed'` or `notification_state = 'failed'`. Re-running the command with the same IDs therefore updates nothing and fails the all-or-nothing eligibility check. This deliberate one-shot behavior prevents replay from disturbing rows already owned or processed by normal workers.

Success and failure output remains a fixed set of `label=integer` lines. It may report requested, matched, eligible, workout-updated, sleep-updated, total-updated, success, and failure counts. It never reports identifiers or row content.

## Testing strategy

### Argument and privacy tests

- Accept exactly 14 unique canonical UUIDs supplied through repeated `--id` flags.
- Reject every other count, duplicates, malformed or noncanonical UUIDs, positional values, and unknown flags before database access.
- Prove there are no committed production IDs, fallback IDs, schema changes, automatic invocation paths, or manual SQL recovery instructions.
- Verify all success and failure output is fixed and count-only.
- Build `dist/recover-proactive-analysis-jobs.cjs` and smoke-test invalid arguments with instrumented `DATABASE_URL` access, requiring exit status 1, no database configuration access, and the exact fixed zero-count failure output.

### Packaging tests

- Require `npm run build:recovery` to produce the dedicated Node.js 22 CommonJS bundle at exactly `dist/recover-proactive-analysis-jobs.cjs`.
- Require the Docker builder to invoke `npm run build:recovery` and the existing runtime `dist` copy to contain the recovery bundle.
- Build the production image and execute the invalid-argument smoke test against the artifact inside that image.
- Prove neither the Docker entrypoint nor `fly.toml` automatically invokes the recovery artifact and no recovery process group is added.

### Eligibility and transaction tests

- Commit a mixed population only when it contains exactly 8 workout and 6 sleep rows matching all 14 supplied IDs.
- Require failed analysis status, null analysis lease token, null result, failed notification state, and null notification sent timestamp at lock and compare-and-set update time.
- Roll back all work when a row is missing, duplicated, ineligible, in the wrong table distribution, concurrently changed, or omitted from returned update IDs.
- Require the returned per-table and combined ID sets to match the supplied population exactly.
- Reject a second invocation after success.

### Mutation and preservation tests

- Verify the five approved analysis fields and only `notification_state` change to their specified values.
- Verify every other notification field remains byte-for-byte or value-for-value unchanged.
- Verify payloads, result, ownership, dates, source identifiers, and unrelated fields remain unchanged.
- Verify recovery itself calls neither model generation nor APNs delivery.

## Rollout

1. Implement and review the correction on a feature branch.
2. Run focused recovery tests, the proactive analysis and notification tests, type checking, lint, worker and recovery bundling, the invalid-argument artifact smoke test, the full test suite, the production build, and a Docker image build/smoke test.
3. Merge and deploy through the normal pull-request and release process; deployment must not invoke recovery automatically.
4. Reconfirm immediately before invocation that the operator-held population is exactly 14 eligible rows with an 8-workout/6-sleep split and zero prior push attempts.
5. Select the existing Fly worker process group and invoke `node dist/recover-proactive-analysis-jobs.cjs` once with the 14 operator-supplied `--id` arguments. Do not use the source-only `tsx` command in production.
6. Require one committed result reporting 14 requested, matched, eligible, and updated rows, split into 8 workout and 6 sleep updates. Treat any other result as a complete rollback and investigate before retrying.
7. Allow normal workers to claim and process the requeued analyses and notifications.

## Post-recovery verification

After the transaction commits, verify without exposing identifiers in logs or committed artifacts:

- all 14 rows left failed analysis state atomically;
- all 14 rows changed from failed to pending notification state in the same transaction;
- the 8-workout/6-sleep population is unchanged;
- notification retry counts, schedules, leases, sent timestamps, payloads, and unrelated fields match their pre-recovery values;
- normal analysis processing reaches its expected ready state or existing bounded retry behavior;
- the notification worker makes push attempts for the recovered rows;
- APNs outcomes follow the existing notification success and retry contracts;
- no additional rows were mutated.

The correction is complete when exactly the 14 operator-selected rows are atomically requeued, their terminal notification state alone is reset to pending, all other notification and payload data is preserved, and normal delivery produces observable push attempts without any embedded IDs, schema change, automatic invocation, or manual SQL.

For a backend-only merge, release verification requires the version job and backend deployment job to succeed. The path-filtered iOS job may correctly report `skipped`; an iOS build is not a prerequisite for this recovery invocation.
