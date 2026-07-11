# Coach concise replies — design

**Date:** 2026-07-11
**Status:** Approved (brainstormed in session, user picked "texting a coach" feel, chat replies only)

## Problem

Coach chat replies are too long — every question gets a detailed, multi-paragraph answer.
Cause is prompt-induced, not sampling: no temperature is set, and the base voice in
`lib/brain/persona.ts` explicitly says *"Engage naturally, at whatever length the moment
needs"* with zero length guidance anywhere in the prompt. The nutritionist/trainer lenses
also push detail into every answer ("Connect every meal recommendation to today's
training load and recovery data"). `max_tokens: 2500` stays untouched — it is headroom,
not a lever; lowering it would truncate mid-sentence.

## Decision

Prompt-only fix in `lib/brain/persona.ts`. No other runtime code changes. Scope is the
main coach chat loop only — the opener route and daily brief keep their current style.

### Changes

1. **Base voice** — remove the "at whatever length the moment needs" license from
   `baseCoachVoice()` (the sentence ends after "Engage naturally").
2. **New `voiceAndLengthBlock()`** appended in `assemblePersona()` *after* the lens
   blocks and *before* the onboarding/calibration/hard-constraint blocks, so it shadows
   lens verbosity (same ordering trick the file already uses for hard constraints):
   - Mobile chat: write like a coach texting a client, not writing a report.
   - Default 1–3 short sentences, plain conversational text — no headers, bullet
     lists, or bold.
   - Expand only when the user explicitly asks for a plan, breakdown, or detailed
     explanation — and keep even that scannable.
   - Answer the question asked; no bolted-on recaps, caveats, or "let me know if…"
     closers.
   - At most one follow-up question per message.
3. **Soften lens bullets** that force detail into every reply:
   - Nutritionist: "Connect every meal recommendation…" → "When making a meal
     recommendation, tie it to today's training load and recovery data where relevant."
   - Nutritionist: the proactive Diet Budget flag keeps its behavior but adds
     "briefly" so the flag doesn't become a paragraph.

### Rider (unrelated security fix)

Add `.codex/` to `.gitignore` — `.codex/config.toml` holds a Supabase access token,
is currently untracked but not ignored. (Token rotation is a user-side action in the
Supabase dashboard.)

## Rejected alternatives

- **Few-shot examples in the prompt** — stronger steering but +200–400 tokens per call;
  escalation path only if the prompt rules don't stick.
- **Post-generation compression pass** — doubles latency/cost, risks mangling
  streaming and tool-call output.
- **Lowering `max_tokens`** — truncates mid-sentence; explicitly ruled out by user.

## Verification

- `npx tsc --noEmit` passes.
- Manual sim QA: casual questions ("how'd I sleep?", "is creatine safe?") get 1–3
  sentence replies; an explicit plan request ("build me a meal plan for tomorrow")
  still gets a fuller, structured answer.
