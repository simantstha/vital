# Proactive Token Placement Prompt Fix Design

**Date:** 2026-07-13
**Status:** Approved for implementation

## Problem

The deployed synthetic live gate confirmed that the model now returns the correct five-field response schema and does not emit raw digits. Grounding still rejected the response because evidence-token use violated the closed token contract: token `{{EVIDENCE_D}}` appeared more than once, and all five token placements failed the production clause-terminal rule.

This is a generation-instruction defect, not a validator, encoder, retry, or data defect. The prompts contain the required restrictions, but they do not make the preferred output strategy concrete enough. The model attempted to use evidence tokens broadly and composed prose after or around them instead of using only the minimum evidence needed and ending the relevant clause at the token.

## Change

Change only the shared evidence-token wording used by `PROACTIVE_ANALYSIS_SYSTEM_PROMPT` and `PROACTIVE_ANALYSIS_REPAIR_PROMPT`. The revised wording must instruct the model to:

- use the fewest evidence tokens needed to answer the request;
- omit a token when qualitative language is sufficient;
- never repeat an evidence token anywhere in the response;
- place a copied token as the final content of its clause or string;
- when punctuation is used, place the token immediately before a terminal punctuation mark, with no unit, qualifier, parenthetical, symbol, or other prose between the token and that punctuation;
- place no content after the token in that clause.

The wording must remain deterministic and digit-free so both guarded generation attempts continue to pass the raw-number guard. It must preserve the exact five-field JSON schema instructions and all existing prohibitions on altering, splitting, concatenating, nesting, enumerating, or manufacturing tokens; raw numbers and numeric symbol sequences; signs before tokens; and units, percentages, degrees, or other numeric symbols after tokens.

The initial and repair prompts must express the same placement and minimal-use contract. Repair remains a full replacement generated from the failure category and the same encoded request; rejected model prose is not added to the repair request.

## Scope Boundaries

This patch changes generation prompt wording and prompt/live-gate tests only. It does not change:

- evidence encoding, token allocation, trusted displays, or request binding;
- schema parsing, grounding validation, clause-terminal validation, token resolution, or proof ownership;
- source payloads, encoded context, or any data-selection path;
- initial-attempt or bounded-repair control flow, failure categories, reporting, retry counts, or retry timing;
- worker claim behavior, notification state, APNs delivery, recovery behavior, database schema, or production rows.

No validator exception, normalization step, response rewrite, token deduplication, or post-generation filtering is introduced.

## Testing Strategy

### Deterministic prompt-contract tests

Focused non-network tests must verify both the initial and repair prompts:

- require the exact scalar-string and array-of-string response shape with no additional keys;
- explicitly direct minimal evidence-token use and permit qualitative language when a token is unnecessary;
- explicitly prohibit every token from appearing more than once in the entire response;
- require each token to be the final content of its clause or string;
- require optional terminal punctuation to follow the token immediately;
- prohibit a unit, qualifier, parenthetical, symbol, or prose after a token in its clause;
- preserve the existing closed-token restrictions and remain free of digit code points.

Existing schema, grounding, generation, worker, and notification tests remain unchanged except where prompt assertions must reflect the clarified wording. Run focused proactive-analysis tests, the full test suite, typecheck, lint, the worker bundle, and the production build.

### Opt-in synthetic live gate

After deployment, run the existing synthetic live generation gate against the deployed prompt and model. It must use synthetic encoded evidence and must not enqueue or deliver a user notification. The gate must verify:

- the exact five-field response shape;
- no raw digits or malformed token fragments;
- only supplied evidence tokens are used;
- no evidence token is duplicated;
- every token placement satisfies the production clause-terminal rule;
- grounding and proof consumption succeed.

Failure diagnostics must remain sanitized. They may report attempt, field types, opaque token identifiers and counts, duplicate or unknown token identifiers, raw-digit and malformed-fragment booleans, per-placement clause-terminal booleans, the first violated invariant, and collected privacy-safe failure events. They must never print model-authored prose.

## Alternatives Rejected

### Relax the grounding validator

Allowing repeated or non-terminal tokens would weaken the evidence-token protocol and permit numeric evidence to be composed with model-authored units, qualifiers, operators, or other meaning-changing text. The live result demonstrated the behavior the validator is designed to reject. The validator remains the enforcement boundary and must not be loosened to accommodate one model response.

### Filter the encoded context

Removing evidence tokens or context fields before generation could reduce opportunities for misuse, but it would discard source-backed evidence, change the established encoding and data path, and conceal the prompt defect. The request should retain its complete approved encoded context while the model is instructed to use only the minimum relevant tokens.

## Rollout

Keep the proactive worker paused while the prompt correction is implemented, reviewed, merged, and deployed. Deployment itself must not resume the worker or run the synthetic gate automatically.

After the backend deployment succeeds, run the opt-in synthetic live gate once. Resume the worker only if the live response passes schema validation, token diagnostics, production grounding, and proof consumption. If the gate fails, leave the worker paused and use only sanitized diagnostics to determine the next correction. Once the gate passes and the worker resumes, monitor the preserved retries through analysis completion and observable notification attempts under the existing delivery contract.
