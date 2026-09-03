# Migrate the coach to Claude Sonnet 5

**Date:** 2026-09-02
**Branch:** `feat/sonnet-5-migration` (off `main`, after the caching PR #141)

## Scope

Only **two** production call sites pin `claude-sonnet-4-6`:

- `lib/claude.ts:320` (`max_tokens: 1500`)
- `lib/brain/coach.ts:66` — `MODEL`, used with `MAX_TOKENS = 2500` (`:67`)

The Haiku routes (`app/api/meals/*`, `app/api/nutrition/photo`, `app/api/coach/opener`) stay on
`claude-haiku-4-5`, which is still current — **do not touch them**. The proactive worker resolves
its model from `PROACTIVE_ANALYSIS_MODEL` at runtime and is out of scope.

## This is not a string swap — three real hazards

**1. Adaptive thinking is ON by default when `thinking` is omitted.** Sonnet 4.6 ran *without*
thinking when the field was absent; Sonnet 5 runs adaptive. Every call in this repo omits it
(`grep 'thinking:'` returns nothing). Consequences if we swap the string alone:

- Thinking tokens count against `max_tokens`, which is only **2500** on the coach path and
  **1500** in `claude.ts`. Responses could be mostly thinking and then truncate mid-sentence with
  `stop_reason: "max_tokens"` — no exception, no failing test.
- The coach's stream loop only yields on `text_delta` (`coach.ts:344-345`). Thinking produces
  `thinking_delta`, which is ignored — so thinking would render as a **silent pause** before any
  text appears in a live chat UI.

**2. New tokenizer, ~30% more tokens for the same text.** `max_tokens` is an output cap, so a
2500 budget on Sonnet 5 holds meaningfully *less* prose than 2500 did on Sonnet 4.6. Left
unchanged, replies get shorter and are likelier to truncate.

**3. The prompt cache minimum may differ.** PR #141's test hardcodes Sonnet 4.6's 2048-token
minimum cacheable prefix (`coach.caching.test.ts:32`). Sonnet 5's minimum is not documented in the
same table. The measured prefix is ~8,269 tokens, which clears even the highest known tier (4096),
so caching should survive — but the constant and its comment must be updated to say which model
they describe and why 8k clears it, or the next reader will trust a stale number.

Not a hazard, verified: no `temperature` / `top_p` / `top_k` is set anywhere, so the
non-default-sampling 400 on Sonnet 5 cannot bite us.

## Decisions

**Make this migration behavior-preserving.** Changing the model, enabling thinking, and changing
the token budget at once makes any regression unattributable. So:

1. **Set `thinking: { type: 'disabled' }` explicitly** on both sites. This preserves exactly
   today's behavior (Sonnet 4.6 with `thinking` omitted = no thinking) rather than silently
   enabling a new mode in a latency-sensitive streaming chat with a 2500-token budget. Being
   explicit also documents the choice instead of depending on a per-model default.
2. **Set `output_config: { effort: 'medium' }`** on the coach path. Nothing sets `effort` today;
   Sonnet 5 defaults to `high`. `medium` is roughly comparable to Sonnet 4.6 at `high` per the
   migration guidance, which is the closest thing to the current behavior. `claude.ts` (a single
   non-agentic call) gets `low`.
3. **Raise the output budgets ~40%** to absorb the tokenizer change: coach `MAX_TOKENS`
   2500 → 3500, `claude.ts` 1500 → 2100. This keeps equivalent *prose* length rather than
   equivalent token count.

Thinking and effort are the two knobs most worth tuning later against real traffic. Tune them in a
follow-up with production numbers — not here, blind.

## Verification

- `npm test` and `npx tsc --noEmit`. Expect the same 4 pre-existing errors in
  `lib/streakRepository.test.ts` and `lib/whoop/{mapping,sync}.test.ts`; leave them.
- The caching tests from PR #141 **must still pass** — they are the regression net proving the
  model change didn't break the cache. If the minimum-prefix constant changes, update it *and* its
  comment to name the model it applies to.
- Update the `claude-sonnet-4-6` literals in `coachIntegration.test.ts` (5 occurrences) — those are
  fixtures asserting the configured model is threaded through, so they should track the new value.
- Add an explicit assertion that requests carry `thinking: {type:'disabled'}`, so a future
  refactor that drops the field silently re-enables thinking and fails loudly instead.

## Out of scope

Tuning `effort`/thinking against production traffic (needs the `coach_model_usage` numbers from
PR #141 first), the Haiku routes, and the proactive worker's env-driven model.
