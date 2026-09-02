# Specialist handoff: continue straight into the specialist's turn

**Date:** 2026-09-01
**Branch:** `feat/specialist-personas`
**Shape:** one PR, backend + iOS together (event contract is additive-safe in both directions)

## Problem

Accepting a handoff dead-ends. `runSpecialistAction` (`lib/brain/coach.ts:97-112`) applies the
DB transition, yields exactly two events, and closes the stream:

```ts
yield result.events[0];   // handoff_card (dismissed)
yield result.events[1];   // persona_changed
yield { type: 'done', messageId: input.actionId };
```

No model call. The user taps "Bring in the Running Coach", the persona chip flips, and the
specialist says nothing. They must retype their question to trigger a fresh `runCoach` that
finally builds the specialist configuration. Four beats for what should be one:

    ask -> card -> tap accept -> (silence) -> ask again

The iOS side compounds it: `CoachViewModel.performSpecialistAction` (`:716-745`) only handles
`.handoffCard` and `.personaChanged`. Even if the backend streamed text today, the client
would discard it.

There is also a second, divergent accept path: `parseSpecialistConfirmation`
(`lib/specialists/orchestration.ts:119-124`) matches only exact strings
(`yes|yep|yeah|accept|bring them in`). "yes please", "sure", "ok", "yeah bring her in" all miss,
so the message goes to Vital Coach as an ordinary turn while a `proposed` session sits pending
on a 15-minute TTL. The card stays on screen; the user believes they accepted; nothing switched.

## Outcome

Tapping accept streams the specialist's opening turn in the same SSE response: it acknowledges
the handed-over context in a line, then addresses the objective directly. Same for accepting a
return card (Vital Coach picks back up with what the specialist concluded).

## Design

**No new SSE event types.** The accept path begins emitting `text` / `tool_call` / `tool_data` /
`done` — events the client already parses on the `send` path. That is what makes the two sides
independently shippable.

### Backend

1. **Extract the turn body from `runCoach`.** Steps 2-6 of `runCoach` (assemble context ->
   resolve session/configuration -> build initial content -> streaming tool loop -> persist
   assistant message -> `done`) become an internal generator, e.g.

   ```ts
   async function* streamCoachTurn(userId: string, seed: TurnSeed): AsyncGenerator<CoachEvent>
   ```

   `TurnSeed` is a discriminated union:
   - `{ kind: 'user', text: string, imageBase64?: string, mode?: 'onboarding' }` — today's behavior.
   - `{ kind: 'handoff_opening', session: SpecialistSession }` — the new path.

   `runCoach` keeps step 1 (persist the user message) and delegates the rest. This is a pure
   refactor; existing behavior must not change.

2. **Seed the opening turn.** For `kind: 'handoff_opening'` there is no user message to persist
   and none to echo. Build the initial user-role content from the session's own data —
   `session.objective` and `session.inboundHandoff` (`{ summary, relevantFacts }`, populated at
   `coachRuntime.ts:143-146`) — as an explicit internal instruction telling the specialist to
   open by briefly confirming the context it was given and then addressing the objective. Do
   **not** replay the user's previous raw message. Keep the existing untrusted-data framing used
   at `coach.ts:227-229`; the handoff summary is model-authored and must not be treated as
   instructions.

   The specialist prompt already receives `inboundHandoff` (`coach.ts:197`), so this seed is a
   kickoff instruction, not a second copy of the context.

3. **Gate the continuation on a fresh transition — critical.** `apply` is idempotent by
   `actionId`: a replay returns early at `if (claim.result) return claim.result`
   (`orchestration.ts:194`) with identical events, and callers currently cannot distinguish a
   replay from a first application. Continuing on `action === 'accept_handoff'` alone would
   re-run and re-bill the model turn and persist a duplicate assistant message on any client
   retry.

   Add a `replayed: boolean` (or equivalent) to `SpecialistActionResult`, set `false` on the
   path that actually transitions and `true` on the memoized early return. `runSpecialistAction`
   continues into `streamCoachTurn` only when `replayed === false` **and** the action is
   `accept_handoff` or `accept_return`.

4. **Terminating event.** Today the action path ends with `done { messageId: input.actionId }`.
   When it continues, the turn's own `done` (carrying the persisted DB message id) is the single
   terminator — do not emit two `done` events. On the decline paths and on replays, keep the
   current `done { messageId: input.actionId }` exactly as-is.

5. **Persistence.** The specialist's opening turn persists through the existing step-6 write
   with `attribution` set (`coach.ts:377-402`), so it carries `speaker`,
   `specialist_session_id`, and `specialist_metadata` and shows up correctly in the GET
   restoration transcript.

6. **Delete the natural-language accept path.** Remove `parseSpecialistConfirmation` and its
   branch at `coach.ts:155-...`; the card is the only way to accept or decline. Keep
   `parseActiveSpecialistReturn` (`orchestration.ts:126-129`) — that is a different affordance
   (leaving an *active* consultation), not a pending-card confirmation. Update
   `orchestration.test.ts` accordingly.

7. **Failure behavior.** If the specialist model call fails during the opening turn, the
   existing handler at `coach.ts:284-297` already transitions the session to `failed` and yields
   `persona_changed` back to Vital. Confirm that still holds when the turn is reached via the
   action path — the transition to `active` has already committed, so a failure must not leave
   the user stranded on a silent specialist persona.

### iOS

8. **Make the accept path a real streaming turn.** `performSpecialistAction`
   (`CoachViewModel.swift:716-745`) currently switches on only `.handoffCard` and
   `.personaChanged`. It needs to consume the full event stream the way `send` does
   (`:537-576`): create an assistant turn, append text deltas, apply `tool_call` / `tool_data`,
   honor a mid-stream `.personaChanged` for turn attribution, and finish on `done`.

   Prefer factoring the shared drain loop out of `send` rather than duplicating it — the two
   paths must not diverge again.

9. **Turn attribution ordering.** `persona_changed` arrives *before* the specialist's first text
   delta, so the assistant turn must be created with the post-change persona (the
   `revealTargetPersona` / `updateTurnPersona` machinery at `:264-268`, `:567` already models
   this). The specialist's opening must render under the specialist's name and accent, never
   under Vital Coach.

10. **Spinner lifetime.** `isPerformingSpecialistAction` (`:725-730`) currently clears as soon as
    the two events land. It must stay set until the streamed turn actually begins producing
    output, or the UI will flash idle mid-handoff.

11. **Decline unchanged.** Declines and replays still terminate on the two events plus `done`;
    that path must keep working exactly as it does now.

## Tests

- `lib/specialists/orchestration.test.ts` — `apply` reports `replayed: false` on first
  application and `true` on a repeated `actionId`; confirmation-parser tests removed.
- `lib/brain/coach.test.ts` (or nearest) — accepting a handoff yields
  `handoff_card` -> `persona_changed` -> `text`* -> exactly one `done`; a replayed `actionId`
  yields the two events plus `done` and makes **no** model call; declines are unchanged.
- Regression: `runCoach` on a plain user message behaves identically after the extraction.
- iOS `CoachSpecialistStateTests` / `CoachSpecialistViewTests` — accept renders a streamed
  assistant turn attributed to the specialist; decline unchanged.

## RESUME HERE — state as of 2026-09-01 ~19:45 CDT

Both implementation agents were killed mid-flight by a session limit (resets 21:30 CDT). Nothing
is committed; the working tree is half-finished. Do **not** commit or open a PR until the two
items below are closed.

**Verified working:**
- `npx tsc --noEmit` reports 4 errors, all pre-existing and unrelated to this change
  (`lib/streakRepository.test.ts`, `lib/whoop/mapping.test.ts`, `lib/whoop/sync.test.ts` — none
  of those files are modified; confirm with `git status`).
- The continuation is genuinely wired. The failing test's stack proves the path:
  `runSpecialistAction (coach.ts:124)` -> `streamCoachTurn (coach.ts:238)` ->
  `buildSpecialistPrompt (orchestration.ts:282)`.
- `lib/brain/anthropicClient.ts` is a new 12-line extraction the backend agent added (not in the
  original spec) so `mock.module()` can intercept a relative specifier; a bare package specifier
  does not reliably intercept a nested static import under this repo's
  `--experimental-test-module-mocks` invocation. Keep it.

**Remaining item 1 — backend test mock (small).**
`npm test` -> 581 pass / 2 fail. Both failures are the new tests in `lib/brain/coach.test.ts`:
`accepting a handoff continues straight into the specialist's streamed opening turn` and
`replaying an already-applied accept_handoff makes no model call and keeps the legacy done`.
Both fail with `(0 , import_persona.unitsInstructionBlock) is not a function`. This is an
incomplete module mock, **not** a logic defect — the persona-module double omits the
`unitsInstructionBlock` export that `buildSpecialistPrompt` calls at `orchestration.ts:282`. Add
the missing export to the mock and re-run.

**Remaining item 2 — iOS view layer (small, and currently a regression).**
`CoachViewModel.isBusy` exists at `:216` and now guards five entry points (`send` `:539`, the
voice toggle `:391`, `startNewChat` `:737`, and two more). **`CoachView.swift` was never touched
— `grep isBusy CoachView.swift` returns nothing.** Every corresponding affordance still gates on
`vm.isStreaming`, which is false during an action-path stream, so the send button, mic, and
new-chat button all render enabled and silently no-op. This is strictly worse than the
pre-change behavior and must not ship.

Wire the view to `vm.isBusy`: `canSend` (~:447), the send button's `.disabled(...)` (~:388), and
the other `.disabled(vm.isStreaming)` sites (~:131, ~:436, ~:497) where starting the control
mid-handoff would race the streamed turn. Keep the stop-button affordance (~:370) tied to
`isStreaming` alone — a specialist action is not user-cancellable the way a send is, so it should
render as a disabled arrow, not a stop button. Add a test asserting the composer reports itself
unavailable while a specialist action streams.

**Known-flaky, do not fix here:** `testInterruptedSpecialistReplyRetainsAuthoritativePersona` and
`testActionFailureReconcilesAuthoritativeStateWithoutReplacingTranscript` fail intermittently via
the shared `waitUntil` helper's bare `Task.yield()` loop. Pre-existing harness flakiness,
unrelated to this change. Any "tests pass" claim on this PR must carry that caveat.

## Out of scope

Prompt caching (`cache_control` appears nowhere in the repo — separate PR), the model-ID
migration to `claude-sonnet-5` + `effort`, and the `finalMessage()` remainder reconciliation at
`coach.ts:299-313`.
