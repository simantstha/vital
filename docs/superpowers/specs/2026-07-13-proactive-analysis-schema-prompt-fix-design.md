# Proactive Analysis Schema Prompt Fix Design

## Problem

The production model returned JSON with the correct five keys, but returned `observations` and `nextSteps` as scalar strings. `parseCoachAnalysis` correctly requires arrays of strings, so every initial response and bounded repair failed with `schema_failure`; the recovered jobs remained in retry instead of reaching notification delivery.

This is a prompt-contract defect, not a validator defect. The prompts name the fields but do not state their exact JSON types, and the token contract incorrectly describes `observations` and `nextSteps` themselves as string locations.

## Change

Update both `PROACTIVE_ANALYSIS_SYSTEM_PROMPT` and `PROACTIVE_ANALYSIS_REPAIR_PROMPT` to state the complete output contract in digit-free wording:

- `headline`, `shortInsight`, and `narrative` must each be a non-empty JSON string.
- `observations` and `nextSteps` must each be a JSON array of non-empty JSON strings.
- No additional keys are allowed.

Correct the shared token-location language so an evidence token may appear in a scalar string or in an individual array-item string. The existing constraints on exact copying, single use, clause termination, punctuation, signs, units, and raw numeric sequences remain unchanged.

The wording itself must remain free of digits and raw numeric symbol sequences so `guardedRequest` continues to accept both prompts.

## Scope Boundaries

This patch changes prompt text and prompt-focused tests only. It does not change:

- `CoachAnalysis` or `parseCoachAnalysis`
- evidence encoding, grounding, proof ownership, or token resolution
- initial-attempt or bounded-repair control flow
- retry counts, retry timing, worker claim behavior, or notification state transitions
- recovery selection or production data

## Verification

Automated tests must prove that both initial and repair prompts:

- explicitly require strings for the three scalar fields;
- explicitly require arrays of non-empty strings for both list fields;
- describe tokens as belonging inside scalar strings or individual array-item strings;
- remain digit-free and pass the existing raw-number guard;
- preserve the existing token-contract restrictions.

Run the focused proactive-analysis tests, full test suite, typecheck, lint, production build, and worker bundle.

After release, run one live synthetic generation using a representative encoded request. Verify that the deployed model returns both list fields as arrays, and that the result passes schema validation, grounding, and proof resolution. This check must use synthetic input and must not enqueue a user notification.

## Rollout

Keep the proactive worker paused while the patch is reviewed, merged, and deployed so the recovered jobs do not spend further retries on the known prompt defect. After the deployment and live synthetic verification pass, resume the worker. Monitor the recovered jobs through successful analysis and confirm notification attempts are recorded. If the synthetic check fails, leave the worker paused and investigate without changing validator or retry behavior.
