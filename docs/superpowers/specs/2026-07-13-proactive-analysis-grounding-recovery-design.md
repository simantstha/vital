# Proactive Analysis Grounding Recovery Design

**Date:** 2026-07-13
**Status:** Approved for implementation planning

## Summary

Proactive workout and sleep analyses can currently exhaust their normal job retries when the model returns malformed JSON, an invalid analysis shape, or a numeric claim that the strict grounding validator rejects. This design makes those failures recoverable without weakening validation: use `claude-sonnet-4-6` by default, prohibit derived numbers in both model prompts, and allow exactly one focused model repair attempt after a parse, schema, or grounding failure.

A separate one-shot operator script will requeue the nine already-failed analysis rows. The script accepts exactly nine unique runtime UUIDs, validates and reconciles them inside one database transaction, performs compare-and-set updates only from the expected failed state, rolls back unless all nine transition, and emits counts only. Recovery changes analysis queue fields only; every notification field is preserved exactly.

## Goals

- Change the proactive analysis default model from the dated Sonnet identifier to `claude-sonnet-4-6` while preserving the `PROACTIVE_ANALYSIS_MODEL` override.
- Tell the model not to calculate, transform, estimate, average, compare numerically, convert units, or otherwise derive numbers. Any number in the response must appear exactly in the supplied evidence with the same unit.
- Make one repair call after an initial parse, schema, or grounding failure, then run the repaired output through the same strict parsing and grounding boundaries.
- Expose only fixed, privacy-safe failure categories to diagnostics.
- Preserve current lease ownership, compare-and-set writes, retry limits, exponential backoff, and terminal failure behavior.
- Provide a narrow one-shot script to requeue exactly nine known failed runtime records safely.
- Preserve `notification_state`, `notification_retry_count`, `notification_next_attempt_at`, `notification_lease_token`, `notification_lease_expires_at`, and `notification_sent_at` byte-for-byte during recovery.

## Non-goals

- Weakening, bypassing, or adding exceptions to `validateGroundedAnalysis`.
- Automatically deleting unsupported numbers or accepting calculated values.
- Changing the analysis JSON schema, APNs delivery, notification preferences, notification retry behavior, lease duration, queue ordering, or sleep capacity reservation.
- Resetting, repairing, clearing, or otherwise mutating notification state as part of the one-shot analysis recovery.
- Adding a database migration or changing the analysis-table schema.
- Sweeping all failed analyses or turning the recovery script into a recurring worker.
- Embedding the nine production UUIDs in source control, command history examples, tests, logs, or the design document.
- Reprocessing analyses that are ready, pending, processing, deleted, or already recovered.

## Current behavior and failure boundary

The worker currently asks the model for JSON, parses it, validates the exact `CoachAnalysis` shape, and then validates every numeric claim against the supplied input and context. `runClaimedAnalysis` renews the analysis lease before work, renews it again before persistence, and stores the result with a status-and-lease-token compare-and-set. Its catch path uses the existing capped exponential backoff and eventually marks a job failed.

Those ownership and retry boundaries are correct. The problem is that a repairable model-format or grounding mistake consumes a full queue attempt. The change therefore belongs within model response generation, before `runClaimedAnalysis` receives a candidate result. No persistence rule needs to change.

## Recommended architecture

### 1. A pure analysis-output boundary

Introduce a small, testable boundary that turns model text into a grounded `CoachAnalysis` in three explicit steps:

1. **Parse:** strip an optional JSON code fence and call `JSON.parse`.
2. **Schema:** call the existing `parseCoachAnalysis` exact-shape validator.
3. **Grounding:** call the existing `validateGroundedAnalysis` with `{ input: job.input, context }`.

The boundary classifies failures by where they occur rather than by inspecting arbitrary error messages:

- `parse_failure`
- `schema_failure`
- `grounding_failure`

The category is a closed union. It contains no model text, prompt content, health data, user ID, job ID, UUID, stack, SQL, token, or arbitrary exception message. Internal exceptions may retain their cause for control flow, but diagnostic serialization must emit only the fixed category through the existing sanitized worker event mechanism.

Transport failures, authentication failures, timeouts, and a response with no text remain ordinary model-call failures. They do not trigger the content-repair call because there is no rejected content to repair; they flow to the existing queue retry and backoff path.

### 2. Initial prompt and default model

The model selection expression becomes:

```text
PROACTIVE_ANALYSIS_MODEL ?? "claude-sonnet-4-6"
```

The existing JSON-only, observational, non-diagnostic instructions remain. Add an explicit no-derived-number contract:

- Do not perform arithmetic, ratios, percentages, differences, trends expressed as new numbers, unit conversion, rounding, estimation, or extrapolation.
- A numeric token may appear only when the exact numeric value is present in the supplied input or context.
- Keep the source unit unchanged; if a number or its unit cannot be copied exactly, describe the observation qualitatively without a number.
- Never manufacture numeric list labels or numbered prose; the JSON arrays already provide structure.

This prompt reduces avoidable failures but is not trusted as enforcement. The existing grounding validator remains authoritative.

### 3. Exactly one content repair attempt

The analyzer performs this bounded sequence:

1. Make the initial model call.
2. Evaluate its text at the parse, schema, and grounding boundary.
3. If it succeeds, return immediately without a repair call.
4. If it fails with `parse_failure`, `schema_failure`, or `grounding_failure`, make one repair call using the same selected model.
5. Evaluate the repair response through the complete parse, schema, and strict grounding boundary again.
6. Return the repaired analysis on success. On any repair failure, throw a typed terminal-for-this-attempt error and let the existing job backoff path run. Never make a third model call.

The repair request includes the original job evidence and the rejected model response because the model needs both to correct structure or remove unsupported claims. It also includes only the fixed failure category, never a raw exception message. Its instruction is to produce a full replacement JSON object, not a patch, and repeats the no-derived-number contract.

The repair call does not write database state. After a successful repair, `runClaimedAnalysis` still renews the lease and must win the existing `status = 'processing' AND lease_token = ?` compare-and-set before `storeReady`. If model latency causes ownership to expire or another worker reclaims the row, the stale worker exits without storing or notifying.

Morning briefs use the same analyzer and output boundary, so they receive the same default model, prompt constraints, one-repair limit, and grounding enforcement. Their existing morning-slot ownership and retry transition remain unchanged.

### 4. Privacy-safe diagnostics

Model-content failures expose only these fixed values:

- attempt: `initial` or `repair`
- category: `parse_failure`, `schema_failure`, or `grounding_failure`
- outcome: `repair_started`, `repair_succeeded`, or `repair_exhausted`

If these are added to structured worker events, they must be allowlisted typed fields rather than copied from an exception. Logs must not include the rejected or repaired response, evidence, prompts, exception message, stack, cause, identifiers, UUIDs, model request IDs, or token counts tied to user content. Existing stage labels remain unchanged.

The queue transition after an exhausted repair is deliberately unchanged: the current `retry_count`, maximum retries, `nextRetryAt` calculation, `markRetry` compare-and-set, and `markFailed` compare-and-set remain the source of truth.

## One-shot recovery script

### Invocation contract

Add a separately invoked script, not imported by the long-running worker. It must receive exactly nine UUID arguments at runtime, for example through nine repeated `--id` flags. The implementation must not define fallback IDs or read an ID list committed to the repository.

Before connecting to the database, argument validation must require:

- exactly nine values;
- every value is a canonical UUID accepted by the project UUID parser;
- all nine values are unique;
- no positional extras or unknown flags.

Validation failures exit nonzero before any database mutation and print only fixed count labels with integer values. They never echo arguments or print a prose reason; the exit code is the failure signal.

### Transaction and compare-and-set recovery

All discovery and mutation run in one database transaction:

1. Query both `workout_analyses` and `sleep_analyses` for the supplied IDs while holding the rows needed for the update.
2. Verify that the union contains exactly nine rows, each supplied UUID appears exactly once, and every row is eligible for recovery: `status = 'failed'`, `lease_token IS NULL`, and `result IS NULL`.
3. Update each table with a compare-and-set predicate that repeats the expected failed-state conditions and restricts the update to the supplied UUID set.
4. Requeue eligible rows by updating only these analysis queue fields: set `status` to `pending`, set `retry_count` to `0`, set `next_attempt_at` to the transaction time, and clear `lease_token` and `lease_expires_at`. `result` is an eligibility condition and remains `NULL`; the update does not assign it.
5. Require the workout plus sleep affected-row counts to equal nine and require the affected UUID set to equal the validated input set. Any mismatch throws and rolls back the entire transaction.

The update must not assign any notification column. In particular, `notification_state`, `notification_retry_count`, `notification_next_attempt_at`, `notification_lease_token`, `notification_lease_expires_at`, and `notification_sent_at` must retain their exact pre-transaction values. Input payloads, `updated_at`, user IDs, dates, source identifiers, and every other non-listed column are also untouched.

The compare-and-set makes the script safe against a concurrent change after the initial read. It is intentionally one-shot but also safe to rerun: after a successful run, the rows are no longer `failed`, so a second invocation updates zero rows, rolls back, and exits nonzero rather than resetting active work.

No model or notification work occurs inside the transaction. The normal worker claims the requeued analysis jobs after commit and applies standard analysis leases, validation, and backoff. Recovery does not attempt to make notification state claimable or otherwise alter later notification behavior.

### Count-only operator output

The script emits fixed labels whose values are integer counts only, such as:

- requested count;
- matched count;
- eligible count;
- workout updated count;
- sleep updated count;
- total updated count;
- success count (`1` after commit, otherwise absent);
- failure count (`1` on a handled failure, otherwise absent).

No log value may be free-form text. The script must never print UUIDs, user IDs, dates, input payloads, results, SQL, database URLs, exception messages, failure reasons, or row objects. Unexpected exceptions emit only a fixed failure label with integer value `1` and return a nonzero exit code.

## Alternatives considered

### Recommended: one in-attempt repair plus exact-ID transactional recovery

This addresses future model mistakes at the narrowest boundary and repairs the known backlog without broadening production selection. It adds one model call only when content validation fails, retains deterministic validation, and gives operators all-or-nothing recovery evidence.

### Rely only on normal queue retries

This is simpler, but identical prompts can repeat the same unsupported numeric claim until the job becomes terminal. It also does not safely recover the nine rows already in `failed`. Rejected.

### Deterministically remove every number from rejected output

This avoids a second model call but risks corrupting prose, missing semantic dependencies, or turning an invalid answer into a misleading one. It also obscures whether the remaining analysis is coherent. Rejected; the full replacement must pass the strict validator.

### Weaken grounding or allow derived metrics

Allowing plausible calculations would reduce failures but erodes the core evidence contract and could produce unsupported health claims. Rejected.

### Automatically sweep all failed rows

A global recovery command is operationally convenient but can revive unrelated permanent failures and makes the blast radius difficult to review. Rejected in favor of exactly nine runtime UUIDs.

### Manual production SQL

Manual updates are hard to test, easy to partially apply across two tables, and likely to expose identifiers in shell history or output. Rejected in favor of a reviewed script with validation, a single transaction, compare-and-set predicates, and count-only logs.

## Testing strategy

### Model configuration and prompt tests

- With no override, the request uses exactly `claude-sonnet-4-6`.
- `PROACTIVE_ANALYSIS_MODEL` still overrides the default.
- Initial and repair system prompts contain the no-derived-number contract.
- Prompt tests assert arithmetic, unit conversion, estimation, rounding, and invented numeric labels are prohibited.

### Output and repair tests

- A valid grounded initial response returns after one model call.
- Malformed JSON triggers exactly one repair call.
- Valid JSON with an invalid schema triggers exactly one repair call.
- A schema-valid response with an unsupported number or mismatched unit triggers exactly one repair call.
- A valid grounded repair response succeeds.
- A failed repair never triggers a third call and flows to the existing queue retry transition.
- Transport, authentication, timeout, and no-text failures do not trigger content repair.
- Both initial and repaired responses pass the same exact-schema and strict-grounding functions.
- Morning briefs and workout/sleep analyses share the same repair behavior.
- Failure events contain only allowlisted categories and never serialize rejected output, health evidence, prompts, exception messages, IDs, or tokens.

### Ownership and retry regression tests

- A successful repair is not stored when lease renewal fails.
- A stale lease token cannot store a repaired result.
- Existing retry counts, exponential backoff timestamps, maximum retry behavior, and terminal `failed` transition are unchanged.
- A repaired result becomes `ready` only through the existing compare-and-set, and notification delivery starts only after that succeeds.

### Recovery-script tests

- Reject zero, fewer than nine, more than nine, duplicate, malformed, noncanonical, positional, and unknown-flag inputs before opening a transaction.
- Accept exactly nine unique canonical runtime UUIDs.
- Recover a mixed set across workout and sleep tables and commit only when the combined affected count is nine.
- Roll back when any UUID is absent, duplicated across unexpected data, ineligible, concurrently changed, or fails the compare-and-set update.
- Verify the update changes exactly `status`, `retry_count`, `next_attempt_at`, `lease_token`, and `lease_expires_at`; `result` is confirmed `NULL` before the compare-and-set and remains `NULL` afterward.
- Seed distinct values for `notification_state`, `notification_retry_count`, `notification_next_attempt_at`, `notification_lease_token`, `notification_lease_expires_at`, and `notification_sent_at`, then assert every value is identical before and after a successful recovery.
- Verify payload, `updated_at`, user, date, source data, and every other non-listed field are unchanged.
- Verify a second invocation after success updates nothing, rolls back, and exits nonzero.
- Capture stdout and stderr and assert they contain fixed labels with integer counts only, with none of the supplied UUIDs or row content.
- Verify the transaction commits once on success and rolls back atomically on every failure path.

### Verification commands

The implementation plan must include focused unit tests for the analysis boundary and recovery script, existing proactive worker lease/transition tests, TypeScript checking, `npm run build:worker`, the project test suite, and `npm run build`.

## Rollout and acceptance criteria

1. Deploy the worker change through the normal PR and release process.
2. Confirm sanitized logs identify repair outcomes only by fixed categories and contain no private content.
3. Run the recovery script once with the nine operator-supplied UUIDs.
4. Require a committed total of nine updates; any other total is a failed recovery and must leave all rows unchanged.
5. Verify before and after snapshots show exact preservation of all six notification fields for all nine rows.
6. Observe the normal worker claim the rows and confirm they advance through `processing` to `ready` or follow the unchanged retry/backoff path.
7. Confirm no stale worker can persist after losing its lease and strict grounding rejects unsupported numeric claims after both initial and repair responses.

The feature is complete when new parse/schema/grounding failures receive no more than one strict repair attempt, successful repaired analyses retain all current ownership guarantees, and the exact nine known failed jobs are atomically requeued by changing analysis queue fields only. All notification fields must remain exactly unchanged, and no identifiers or health content may appear in logs.
