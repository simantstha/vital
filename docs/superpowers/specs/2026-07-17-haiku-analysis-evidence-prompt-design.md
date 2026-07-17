# Haiku proactive analysis evidence prompt and semantic guard

## Problem

The production proactive-analysis worker uses `claude-haiku-4-5`. Numeric
workout and sleep evidence is intentionally replaced with opaque evidence
tokens before generation, then resolved after the model response passes
grounding. Haiku can interpret those tokens as unresolved template variables
and return a meta-response instead of an analysis.

The current grounding layer validates JSON shape, rejects raw numbers, and
checks every evidence token that is present. It does not require the response
to use session-input evidence and does not reject a token-free refusal. As a
result, the workout response headed "Unable to process workout data" passed
grounding and was stored as ready even though the source contained valid
duration, distance, pace, calorie, and heart-rate values.

## Goals

- Keep `claude-haiku-4-5` as the proactive-analysis model.
- Make the prompt state that evidence tokens are verified recorded values,
  including their display units, rather than placeholders or missing data.
- Prevent a token-free or explicit placeholder/template meta-response from
  becoming a ready analysis when the session input contains numeric evidence.
- Preserve the existing schema, evidence resolution, repair attempt, job retry,
  notification, database, and deployment behavior.

## Non-goals

- Changing the proactive-analysis model or model-selection environment variable.
- Requiring every supplied metric token at the grounding boundary.
- Adding a deterministic analysis fallback.
- Changing database schema, migrations, API response shape, APNs content, or
  retry limits.

## Design

### Prompt contract

Rewrite the shared token contract used by both the initial and repair prompts
to lead with token semantics:

- Every supplied evidence token stands for a verified recorded value and
  already includes its display unit when applicable.
- The model must treat tokens as real measurements and copy selected tokens
  verbatim into user-facing analysis prose.
- The model must never describe the request as containing placeholders,
  template variables, unresolved tokens, missing metric values, or a data
  integrity problem.
- Keep the existing safety constraints: no raw numbers, no manufactured or
  altered tokens, no token reuse, and clause-terminal placement.
- Phrase placement instructions as short imperative sentences suitable for
  Haiku while retaining exact compatibility with the grounding validator.

The content contract continues to request the key available session metrics,
short output, metric-anchored observations, and no repeated facts. The system
and repair prompts must remain free of all Unicode numeric code points because
`guardedRequest` validates them before transport.

### Input-evidence provenance

Extend the private encoding state with the set of tokens allocated while
encoding `source.input`. Tokens allocated from `source.date` or
`source.availableContext` remain valid evidence but do not satisfy the new
session-evidence requirement.

This provenance remains private in the existing `WeakMap`; it is never added to
the serialized model payload or public types.

### Semantic grounding guard

After validating authored strings and collecting used tokens, grounding applies
two additional checks:

1. If `source.input` produced evidence tokens, at least one of those input
   tokens must appear in the response.
2. Authored output must not contain a narrow, case-insensitive set of explicit
   meta-response phrases covering the observed failure: "unable to process",
   "placeholder token", "template variable", "unresolved token", or "data
   integrity".

Failure is classified as the existing `grounding_failure`. The normal bounded
repair path therefore gets one chance to regenerate a compliant response. No
new failure category or retry behavior is introduced.

The guard deliberately requires only one session-input token. Requiring every
key metric at this boundary would make prompt-quality preferences into a hard
availability constraint and could increase Haiku repair exhaustion. The prompt
still asks for all key metrics when supplied.

## Testing

Use test-driven development in the existing proactive analysis tests:

- A source with numeric workout input plus the screenshot-style token-free
  placeholder response fails with `grounding_failure`.
- A neutral token-free response also fails when numeric input evidence exists.
- Context-only or date tokens cannot satisfy the input-evidence requirement.
- A valid Haiku-style response containing a supplied input token still grounds,
  resolves the exact display value, and produces a consumable proof.
- Existing valid sources without numeric input evidence remain supported.
- Both prompt variants describe evidence as verified real values, forbid the
  observed meta-response language, preserve placement rules, and contain no
  Unicode numeric code points.
- The existing repair test proves that the new grounding failure enters the
  bounded repair path without replaying rejected text.

Run focused proactive-analysis tests first, then the full test suite, typecheck,
lint, worker bundle, and production build.

## Rollout and observation

Ship through the normal feature-branch pull request and automatic release after
user merge. After deployment, inspect sanitized Fly worker events for
`grounding_failure` and `repair_exhausted`. Reprocess the affected ready workout
and failed sleep analyses only after the deployed prompt and guard are verified.
