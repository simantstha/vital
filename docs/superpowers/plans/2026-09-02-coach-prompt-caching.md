# Coach prompt caching

**Date:** 2026-09-02
**Branch:** `perf/coach-prompt-caching` (off `main` @ `a9ad9d7`)

## Problem

`grep -rn cache_control lib app scripts` returns **nothing**. No prompt caching anywhere.

`lib/brain/coach.ts` runs a tool loop up to `MAX_ROUNDS = 10` (`:63`). Every round issues a fresh
`client.messages.stream({ system, tools, messages })` with the **same** system prompt and the
**same** tool schemas — `lib/brain/tools.ts` is 1665 lines of definitions. All of it is billed at
full input price on every round, then again on every turn.

Render order is `tools` -> `system` -> `messages`, so a single breakpoint on the last system block
covers both tools and system.

## What is and isn't stable (verified, not assumed)

- `lib/brain/persona.ts` contains **no** `Date` / `now()` / `random` / `uuid` — no per-request
  invalidator. Good.
- `baseTools` is `BRAIN_TOOLS`, a module constant (`coach.ts:233`); order is deterministic. Good.
- **But** `assemblePersona(ctx.hardConstraints, undefined, isOnboarding, ctx.calibration,
  ctx.unitSystem)` (`coach.ts:226`) embeds `hardConstraints` and `calibration` in the system
  prompt. Calibration drifts as health data lands, so the prefix is stable *within* a turn and
  usually across nearby turns, but not indefinitely.
- The specialist prompt (`buildSpecialistPrompt`, `coach.ts:236-248`) additionally embeds
  `relevantMessages`, so it changes every turn. Intra-turn caching still applies.
- Volatile per-request content (`ctx.promptText`, the user message) is already in the **user**
  message (`coach.ts:224-243`), i.e. after where the breakpoint goes. No move needed.

The guaranteed win is therefore the within-turn re-send across rounds. Cross-turn hits are a
bonus that depends on calibration churn.

## Changes

1. **`system` becomes a content-block array.** `CoachConfiguration.system` is currently `string`
   (`lib/specialists/coachIntegration.ts:26`) and passed as `system: configuration.system`
   (`coach.ts:263`). Change it to `Anthropic.TextBlockParam[]` (a single text block is fine) and
   put `cache_control: { type: 'ephemeral' }` on the **last** block. This caches tools + system
   together. Apply to both the coach and specialist configurations in
   `selectCoachConfiguration`.

2. **Roll a breakpoint over the growing message history.** Inside the round loop, put
   `cache_control: { type: 'ephemeral' }` on the **last content block of the most recently
   appended turn** — in practice the final `tool_result` block pushed at `coach.ts:~372` — and
   remove it from the previous round's block before adding the new one. Each round then reuses
   the whole prior conversation prefix instead of reprocessing it.

   **Cap: 4 breakpoints per request.** With one on system, keep at most 3 rolling ones — simplest
   correct approach is to keep only the single most recent message breakpoint (system + 1).

3. **Do not add `cache_control` to the one-shot routes** (`app/api/meals/*`,
   `app/api/nutrition/photo`, `app/api/coach/opener`). They are single `messages.create` calls on
   `claude-haiku-4-5`, whose minimum cacheable prefix is **4096 tokens** — below that, caching
   silently does nothing (`cache_creation_input_tokens: 0`, no error). Out of scope.

## Constraints

- Model is `claude-sonnet-4-6`; minimum cacheable prefix **2048 tokens**. System + 1665 lines of
  tool schemas is comfortably over, but confirm empirically (below) rather than assuming.
- Cache writes cost ~1.25x, reads ~0.1x. Break-even is 2 requests, so a multi-round turn is
  clearly profitable; a 1-round turn roughly breaks even.
- Changing the model or the tool set invalidates the cache — do not combine this with the
  `claude-sonnet-5` migration. Separate PR, deliberately.

## Verification — this is the part that matters

A green test suite does **not** prove caching works; a misplaced breakpoint silently produces
zero hits with no error. Prove it with the usage fields:

- Assert in a test that on a multi-round turn, round 2+ reports non-zero
  `usage.cache_read_input_tokens`, and that `input_tokens` (the uncached remainder) drops sharply
  versus round 1.
- Log `cache_creation_input_tokens` / `cache_read_input_tokens` per turn so the effect is
  observable in production, not just in tests. `lib/specialists/coachRuntime.ts` already has
  `logModelUsage` and `accumulateModelUsage` (`:24-35`) — extend that shape rather than inventing
  a parallel logger.
- Report the measured before/after for one representative multi-round turn in the PR.

If `cache_read_input_tokens` is zero across rounds, a silent invalidator is at work — diff the
rendered prefix bytes between rounds before changing anything else.

## Out of scope

Splitting `assemblePersona` into a static block + a volatile per-user block (`hardConstraints` +
`calibration`) for cross-user cache sharing. That is a real refactor of `persona.ts` and should be
decided on measured hit rates from this PR, not speculation. The `claude-sonnet-5` +
`output_config.effort` migration is also separate.
