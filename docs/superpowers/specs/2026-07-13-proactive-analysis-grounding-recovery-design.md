# Proactive Analysis Evidence-Token Grounding and Recovery Design

**Date:** 2026-07-13
**Status:** Approved for implementation planning

## Summary

Proactive workout and sleep analyses can exhaust their normal retries when model output is malformed, violates the exact `CoachAnalysis` schema, or contains an unsupported numeric claim. The previous design attempted to prove grounding by parsing numeric text and recognizing units after generation. That boundary is inherently ambiguous: ordinary prose can look like a unit, numeric forms can be split, and a growing output-unit vocabulary can still miss a spelling or symbol.

This design removes raw numbers from the model boundary. Before either model call, a deterministic encoder walks the complete request payload—date, job input, and available context—replaces every numeric value or numeric lexeme with a unique opaque alphabetic evidence token, and records a server-only map from each token to the source's exact display text, including its source unit when known. The model sees no raw numbers and may copy evidence tokens only into `CoachAnalysis` string values. After JSON parsing and exact schema validation, the server rejects raw numeric output and invalid token use, resolves trusted tokens from the private map, and produces the same clean `CoachAnalysis` schema stored today.

Exactly one content repair remains available after parse, schema, or token-grounding failure. Privacy-safe diagnostics, leases, compare-and-set persistence, retries, morning-slot ownership, the exact-nine recovery script, notification preservation, and the public analysis schema remain unchanged.

## Goals

- Default proactive generation to `claude-sonnet-4-6` while preserving the `PROACTIVE_ANALYSIS_MODEL` override.
- Make numeric grounding deterministic without parsing model-authored numbers or units.
- Tokenize every numeric value in the complete date/input/context payload before model invocation.
- Preserve the source's exact display text and source unit in a private token map.
- Send no raw numbers to the model in either initial or repair requests.
- Permit the model to copy only known opaque evidence tokens, only into `CoachAnalysis` string values, and at most once per token.
- Reject raw numeric output, unknown tokens, duplicate tokens, malformed token-like text, and token placement outside allowed strings.
- Resolve tokens only after JSON parsing and exact schema validation, then store an unchanged clean `CoachAnalysis`.
- Ensure `runClaimedAnalysis` can persist only a runtime proof minted by the trusted resolver, never a plain result from an untrusted analyzer.
- Preserve one repair attempt, privacy-safe diagnostics, lease ownership, compare-and-set writes, retry/backoff behavior, and terminal failure behavior.
- Safely requeue exactly nine known failed runtime rows while preserving all notification and unrelated fields.

## Non-goals

- Parsing or canonicalizing numeric model output with regular expressions.
- Maintaining an output-side health-unit vocabulary or accepting unit aliases after generation.
- Accepting a raw model number because it resembles, equals, rounds to, converts from, or shares a unit with source evidence.
- Allowing arithmetic, ratios, percentages, differences, averages, trends expressed as new numbers, conversions, rounding, estimation, or extrapolation.
- Persisting evidence tokens, token maps, grounding proofs, prompts, or rejected model text.
- Changing the public `CoachAnalysis` JSON schema, analysis-table schema, APNs behavior, notification preferences, lease duration, queue ordering, or sleep capacity reservation.
- Mutating notification state during one-shot recovery.
- Sweeping all failed analyses or embedding production UUIDs in source, examples, tests, logs, or documentation.

## Current behavior and reason for replacement

The worker parses model JSON, validates the exact `CoachAnalysis` shape, and scans its strings for numeric claims to compare against input and context. `runClaimedAnalysis` renews the analysis lease before work and again before persistence, and `storeReady` uses the existing status-and-lease-token compare-and-set. The catch path retains capped exponential backoff and eventually marks a job failed.

The ownership and retry boundaries are correct. The output scanner is not. Numeric syntax, punctuation, unit spellings, symbols, ordinary following prose, and attached text create an open-ended language-recognition problem. Expanding a unit list moves the ambiguity without eliminating it. Grounding instead needs a closed capability: possession of a server-issued token is the only authority to emit a source number.

## Recommended architecture

### 1. Deterministic evidence-token encoding

The trusted analyzer constructs one canonical payload containing exactly:

- analysis kind and date;
- job input;
- available context.

A deterministic encoder traverses that complete payload before serialization. It handles JSON numbers and numeric lexemes embedded in source strings. No field is exempt merely because it is nested, appears in a date, belongs to a payload object, or is not a currently known metric.

For each source occurrence, the encoder:

1. Determines the complete numeric source lexeme or finite JSON numeric value.
2. Obtains its exact source display text. Path-specific source adapters may add a unit that is defined by that source field; a source string retains the exact numeric text and adjacent source unit already present. If the source provides no unit, the display text remains explicitly unitless.
3. Allocates a unique opaque token using an alphabetic sequence, for example `{{EVIDENCE_ALPHA}}`, `{{EVIDENCE_BETA}}`, and `{{EVIDENCE_GAMMA}}`. Tokens contain no digits and cannot be confused with numeric output.
4. Replaces that occurrence in the model payload with the token.
5. Stores `{ token -> exactSourceDisplayText }` in a request-local private map.

Every source occurrence receives a distinct token, even when two occurrences have identical display text. The map therefore preserves provenance and makes output-token reuse detectable. Token allocation order is deterministic for the canonical traversal order, which keeps tests reproducible, but tokens reveal no metric name, value, unit, user identifier, or database identifier.

Source adapters are typed formatters at the input boundary, not an output scanner. They define how a known field is displayed before the model sees it. Unknown fields are still tokenized; they simply use their exact source lexeme without inventing a unit. The encoder never calculates, normalizes, rounds, converts, or groups a value.

After encoding, an outbound guard inspects all model-visible system and user content and rejects it if any raw numeric code point remains outside the evidence-token protocol. API transport metadata is outside this check because the selected model identifier necessarily contains version digits; it is not health evidence or prompt content. The initial model call cannot occur unless the guard succeeds. Tokens, token maps, and exact source display strings are held only in memory for that attempt; the map is never sent to the model.

### 2. Token-only model contract

The initial and repair prompts retain the JSON-only, observational, and non-diagnostic instructions. They replace all free-form numeric grounding guidance with a token contract:

- Never write a raw number or numeric symbol sequence.
- A source number may be referenced only by copying one supplied evidence token exactly.
- Copy a token only into one of the five `CoachAnalysis` string locations: `headline`, `shortInsight`, `narrative`, an `observations` item, or a `nextSteps` item.
- Use each token at most once.
- Never alter, concatenate, split, nest, enumerate, or manufacture a token.
- If no suitable token is supplied, describe the observation qualitatively.
- Do not create numeric list labels; JSON arrays already provide structure.

The model does not know the raw value behind a token. It cannot calculate with the value, change its unit, or restate a nearby number. Its only numeric capability is copying a closed opaque token supplied by the server.

### 3. Parse, schema, token proof, then resolution

Model output crosses four ordered boundaries:

1. **Parse:** strip an optional JSON code fence and call `JSON.parse`.
2. **Schema:** call the exact existing `parseCoachAnalysis` validator. Extra keys, wrong types, numeric values, nested objects, and tokens in keys or structural positions fail here.
3. **Token proof:** inspect only the validated `CoachAnalysis` string values. Reject any raw numeric code point or numeric lexeme, any unknown token, duplicate use of a token, malformed token-like text, token concatenation, or any known token outside those validated strings. A token must match one private-map key exactly and may occur once.
4. **Resolution:** replace each trusted token with its exact private-map display text. Parse the resolved value through `parseCoachAnalysis` again to preserve all string-length and array limits after expansion.

The output of resolution is an ordinary clean `CoachAnalysis`. It contains source display text, not tokens, and its public shape is unchanged. Resolution performs no numeric parsing and no unit recognition. A source unit cannot be dropped, added, disguised, or converted because the exact value-and-unit display text is substituted atomically by trusted code.

Failures remain classified by boundary rather than by exception text:

- `parse_failure`
- `schema_failure`
- `grounding_failure` for any outbound-number, token-proof, or resolution failure

Only the fixed category participates in diagnostics and repair control flow.

### 4. Runtime proof and branding boundary

A TypeScript type assertion alone is not a security boundary: an untrusted analyzer could cast a numeric `CoachAnalysis` to a branded type. The trusted resolver therefore mints a runtime-verifiable proof object after successful resolution.

The proof API has these properties:

- the proof constructor and minting key are private to the grounding module;
- minted proof objects are registered in module-private runtime state, such as a `WeakSet`;
- the proof contains the resolved clean `CoachAnalysis`, but the marker cannot be recreated by object shape or a public symbol;
- the consume operation verifies runtime membership, consumes the proof once, and returns the clean analysis;
- copying, serializing, spreading, or fabricating a proof does not preserve membership.

`runClaimedAnalysis` changes its analyzer boundary from “return unknown model output” to “return a trusted grounded-analysis proof.” It must call the proof consumer before renewing the lease for persistence. A plain `CoachAnalysis`, including one containing a number, fails before `storeReady` even if an untrusted callback lies about its TypeScript type. Only the token resolver can mint a proof.

The brand is never stored. After successful proof consumption, `runClaimedAnalysis` persists only the clean existing schema. Tests that need a successful analysis exercise the trusted token analyzer or a private test seam in the grounding module; there is no public arbitrary-result minting helper.

Morning briefs use the same trusted analyzer and proof consumer. They cannot bypass token validation through a separate generation path.

### 5. Exactly one content repair

Generation remains bounded:

1. Encode the canonical payload and establish the private token map.
2. Make the initial model call with the tokenized request.
3. Run parse, schema, token proof, and resolution.
4. On success, mint and return the runtime proof without repair.
5. On `parse_failure`, `schema_failure`, or `grounding_failure`, make exactly one repair call with the same tokenized request and fixed category.
6. Run the full boundary again. On success, mint a proof. On failure, report repair exhaustion and let the existing job retry path run. Never make a third call.

The repair request must also satisfy the outbound no-number guard. It must not include the raw rejected response. It may include a deterministic sanitized structural rendering that preserves known evidence tokens while replacing all raw numeric text and malformed token-like fragments with fixed nonnumeric placeholders. Omitting rejected content is preferable when it cannot be sanitized without ambiguity. Raw exception messages are never sent.

Repair performs no database write. A successfully repaired proof still passes through `runClaimedAnalysis`, lease renewal, and the existing `status = 'processing' AND lease_token = ?` compare-and-set. A stale worker cannot store or notify.

### 6. Privacy-safe diagnostics

Model-content diagnostics expose only:

- attempt: `initial` or `repair`;
- category: `parse_failure`, `schema_failure`, or `grounding_failure`;
- outcome: `repair_started`, `repair_succeeded`, or `repair_exhausted`.

Logs must not include raw or tokenized prompts, token values, token maps, source display text, rejected or repaired responses, health evidence, exception messages, stacks, causes, identifiers, UUIDs, model request IDs, database values, or user-linked token counts. These fields remain closed typed allowlists. Existing queue-stage labels and sanitized error handling remain unchanged.

## One-shot recovery script

The recovery mechanism remains separate from token grounding and is unchanged in behavior.

### Invocation contract

The script receives exactly nine unique canonical runtime UUIDs through repeated `--id` flags. It defines no fallback IDs and reads no committed ID list. Argument validation occurs before database import or connection and rejects missing, extra, duplicate, positional, unknown-flag, malformed, uppercase, or noncanonical values. Failure output contains fixed integer counts only and never echoes an argument or prose reason.

### Transaction and compare-and-set recovery

One transaction:

1. Locks matching rows in both `workout_analyses` and `sleep_analyses`.
2. Requires exactly nine distinct supplied rows, all with `status = 'failed'`, `lease_token IS NULL`, and `result IS NULL`.
3. Updates each table using compare-and-set predicates for ID, failed status, null lease, and null result.
4. Assigns exactly `status = 'pending'`, `retry_count = 0`, `next_attempt_at = transaction time`, `lease_token = NULL`, and `lease_expires_at = NULL`.
5. Requires returned workout and sleep ID sets to equal the validated input set. Any mismatch rolls back everything.

The script does not assign `result`, `updated_at`, or any notification column. It preserves `notification_state`, `notification_retry_count`, `notification_next_attempt_at`, `notification_lease_token`, `notification_lease_expires_at`, `notification_sent_at`, payloads, users, dates, source identifiers, and every other field. A second invocation after success updates nothing and rolls back.

Success and failure output remain fixed `label=integer` lines only. UUIDs, user IDs, dates, payloads, results, SQL, database URLs, exceptions, and row objects are never logged. Recovery runs no model or notification work; normal workers claim rows only after commit.

## Alternatives considered

### Recommended: deterministic opaque evidence tokens plus runtime proof

This is a closed protocol. The model never receives a number, cannot transform a hidden value, and cannot authorize output without an exact server-issued token. Atomic trusted resolution preserves the source unit, while the runtime proof prevents an alternate analyzer from bypassing the boundary.

### Numeric and unit scanner after generation

This can accept familiar output, but numeric grammars, punctuation, Unicode, compound units, aliases, and ordinary prose create an unbounded parser. Each vocabulary expansion introduces new ambiguous cases. Rejected.

### Give the model raw evidence and rely on prompt compliance

This is simple but does not enforce grounding. The model can calculate, convert, round, or invent a plausible number, and a prompt cannot establish proof. Rejected.

### Deterministically delete numbers from rejected output

Deletion can damage meaning and produce incoherent or misleading health guidance. It also provides no trusted link between remaining prose and source evidence. Rejected.

### Weaken grounding or accept derived values

Plausible arithmetic still violates the evidence contract and can create unsupported health claims. Rejected.

### Broad or manual recovery

Sweeping all failures or running manual SQL increases blast radius and identifier exposure. The exact-nine transactional script remains the approved approach.

## Testing strategy

### Evidence encoding and outbound tests

- Traverse numeric values at every nesting level across date, input, and context.
- Tokenize JSON numbers and complete numeric lexemes in source strings.
- Produce unique alphabetic opaque tokens in deterministic traversal order.
- Map every token to exact source display text, including the source unit when a typed source formatter knows it.
- Preserve exact source spelling and never round, normalize, calculate, group, or convert.
- Give identical source displays at different locations distinct tokens.
- Assert all model-visible system and user content for initial and repair calls contains no raw numeric code point; transport-only model metadata is excluded.
- Assert token maps and source display text are never included in requests or logs.

### Parse, schema, token, and resolution tests

- A schema-valid token-only response resolves to the unchanged clean `CoachAnalysis` after one model call.
- Malformed JSON is `parse_failure`; invalid shape or token use outside string values is `schema_failure`.
- Reject raw integers, signs, decimals, leading decimals, exponents, grouped numbers, percentages, temperature values, numeric list labels, and Unicode numeric code points in model-authored strings.
- Reject unknown, duplicate, malformed, split, concatenated, nested, or partially copied tokens.
- Reject a known token in a key, array structure, numeric field, extra field, or any location other than validated `CoachAnalysis` strings.
- Resolve only exact private-map tokens and substitute the exact source display atomically.
- Re-run exact schema and length limits after resolution.
- Verify no token or proof remains in the stored/public value.
- Verify source values that happen to be equal cannot authorize token substitution from a different occurrence.

### Proof, ownership, repair, and privacy tests

- `runClaimedAnalysis` rejects a plain or type-cast `CoachAnalysis` from an untrusted analyzer.
- A forged, copied, serialized, spread, or already-consumed proof is rejected before `storeReady`.
- Only a proof minted by successful token resolution can be consumed.
- Initial parse/schema/grounding failure triggers exactly one repair; repair failure never triggers a third call.
- Repair requests pass the same no-number outbound guard and never contain raw rejected text.
- Transport, authentication, timeout, and no-text failures do not enter content repair.
- A successful proof is not stored after lease loss; stale lease tokens cannot win persistence.
- Existing retry counts, exponential backoff, terminal failure, morning-slot ownership, and notification sequencing remain unchanged.
- Failure events contain only fixed allowlisted fields and never serialize evidence, tokens, maps, prompts, rejected output, identifiers, or exceptions.

### Recovery-script tests

- Reject all argument counts other than exactly nine and reject duplicate, malformed, noncanonical, positional, and unknown-flag inputs before database access.
- Prove both table locks, all four compare-and-set conditions, returned IDs, and exactly five assignments without executing production recovery.
- Commit a mixed workout/sleep set only when all nine supplied IDs transition.
- Roll back on absent, duplicate, ineligible, concurrently changed, or compare-and-set-missed rows.
- Preserve all notification and unrelated fields exactly.
- Reject a second invocation after successful recovery.
- Emit count-only output with no identifiers, row content, SQL, connection data, or exception text.

## Verification

The implementation plan must include focused evidence-encoder, output-boundary, proof, repair, lease, transition, and recovery tests; all proactive tests; TypeScript checking; lint; worker bundling; the project test suite; and the production application build.

## Rollout and acceptance criteria

1. Deploy through the normal feature-branch PR and release process.
2. Confirm every initial and repair model request contains only tokenized evidence and no raw numbers.
3. Confirm logs expose only fixed repair categories/outcomes and no private content or token material.
4. Confirm valid token output resolves to the unchanged public `CoachAnalysis` and contains no tokens at persistence or API readback.
5. Confirm raw numeric output and every unknown, duplicate, malformed, misplaced, split, or concatenated token fail before proof minting.
6. Confirm `runClaimedAnalysis` rejects untrusted plain results and accepts only a fresh runtime proof minted by the trusted resolver.
7. Confirm lease renewal and the existing status-and-token compare-and-set remain mandatory before storage and notification.
8. Run the recovery script once with nine operator-supplied UUIDs; require exactly nine committed updates or a complete rollback.
9. Verify all six notification fields and all unrelated fields are identical before and after recovery.
10. Observe requeued jobs follow normal processing, retry, backoff, ready, and notification behavior.

The feature is complete when the model never receives raw numeric evidence, can express a source number only by copying one opaque server-issued token, trusted resolution is the only way to mint the runtime proof consumed by `runClaimedAnalysis`, the stored/public schema remains clean and unchanged, one repair remains bounded and privacy-safe, and the exact nine failed jobs are atomically requeued without changing notification or unrelated state.
