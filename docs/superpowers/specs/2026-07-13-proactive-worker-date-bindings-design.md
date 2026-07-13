# Proactive Worker Date Bindings Design

## Problem

The proactive health worker claims workout and sleep work with raw Drizzle SQL. Those templates currently bind JavaScript `Date` objects directly. With the deployed `drizzle-orm`/`postgres` combination, the raw path does not apply a timestamp-column encoder, so the driver rejects the value before PostgreSQL receives the query. The top-level worker loop catches and discards that exception, leaving due jobs pending without a useful production signal.

This failure is independent of APNs credentials and provisioning. Push delivery cannot begin until the worker can claim and process its queued analyses.

## Goals

- Bind ISO-8601 strings, never `Date` objects, at every raw-SQL timestamp boundary in the proactive worker repository.
- Preserve `Date` values for typed Drizzle inserts, updates, and in-memory transition logic, where column encoders already apply.
- Emit a sanitized error event identifying the worker stage and safe error metadata when a stage fails.
- Cover serialization and diagnostic redaction with regression tests.
- Restore queued workout and sleep processing without a schema or migration change.

## Non-goals

- Changing job eligibility, lease duration, retry policy, notification ordering, or morning-slot ownership.
- Changing APNs keys, device registration, notification preferences, analysis prompts, or provisioning profiles.
- Refactoring the repository from raw SQL to Drizzle's query builder.
- Adding database columns, indexes, or migrations.

## Design

### Raw timestamp serialization

Add one pure helper that accepts a valid `Date` and returns `date.toISOString()`. Each repository method computes serialized values once, close to its raw query, and uses those strings only in `sql` template interpolations.

Apply the boundary consistently to:

- `claimAnalysisJobs`: `now` and the analysis lease expiry in both sleep and workout claim/update statements.
- `suppressNotification` and `claimNotification`: timestamps interpolated into raw eligibility and expired-lease predicates.
- `listReadyNotificationCandidates`: due-time and expired-notification-lease predicates in both union branches.
- `claimDueMorningBriefs`: every `now at time zone ...` expression.
- Morning-slot recovery predicates in `claimNotification` and `claimDueMorningBriefs`.

Typed `.set(...)`, `.values(...)`, and transition calls continue receiving `Date` objects. This keeps the change limited to the untyped raw-SQL binding path and avoids changing domain interfaces.

The helper must reject invalid dates before executing SQL, rather than producing an invalid timestamp string. Its thrown error contains only a fixed diagnostic message and no user, device, analysis, or health data.

### Sanitized worker diagnostics

Track a fixed stage identifier while a tick progresses. The allowed stage values are:

- `ensure-default-preferences`
- `claim-analysis-jobs`
- `process-analysis-job`
- `list-notification-candidates`
- `deliver-notification`
- `claim-morning-briefs`
- `process-morning-brief`

Replace silent catches with a single structured error event containing only:

- `event: "proactive_worker_error"`
- the allowlisted `stage`
- the error's class/name
- a string or numeric error `code`, when present

Do not log the arbitrary error message, stack, cause, SQL text, query parameters, analysis result, user ID, job ID, device token, APNs token, or environment values. Unknown thrown values are reported as `errorName: "UnknownError"`. A morning-brief failure is logged before the existing retry transition runs; the outer loop still waits and continues after failures so the worker remains available.

## Testing

Add pure unit coverage that does not require a live database or secrets:

1. A known UTC `Date` serializes to the exact ISO-8601 string expected by the raw SQL driver.
2. An invalid `Date` is rejected before query construction/execution.
3. The raw-query construction boundary exposes string timestamp parameters and no `Date` instances for analysis claims, notification candidate listing, and morning-brief selection.
4. Diagnostic events contain the fixed event name, allowlisted stage, error name, and safe code.
5. Diagnostic events omit messages, stacks, causes, SQL, IDs, device tokens, and arbitrary properties from thrown errors.
6. An unknown thrown value produces the fixed `UnknownError` representation.

Run the focused Node tests, the complete project test suite, `npm run build:worker`, and `npm run build`. Existing lease, retry, and notification-transition tests must remain unchanged and green.

## Rollout and verification

This change requires no migration and follows the normal release workflow after the PR is merged by the user. After Fly deploys the worker:

1. Confirm the worker machine remains running and no repeated `proactive_worker_error` appears for `claim-analysis-jobs`.
2. Confirm previously due workout and sleep rows move from `pending` through `processing` to `ready`.
3. Confirm notification state advances from `pending` to `sent` (or records an explicit APNs retry/failure) and that push-attempt rows are created.
4. Confirm Fly logs contain stage/error metadata only and no health content, identifiers, device tokens, SQL, or secrets.
5. Trigger or ingest one new workout and one new sleep record and verify each is analyzed on the next eligible poll and produces the expected notification behavior.

If claiming still fails, use the sanitized stage and code to isolate the boundary; do not bypass leases, manually mark queued records, or weaken the catch-and-continue behavior.
