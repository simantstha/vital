# Task 2 Report — Coach orchestration, API, SSE, and restoration

## Delivered

- Added a feature-gated Running Coach orchestration path to the existing coach loop while preserving the legacy model, prompt, tools, request body, and SSE shapes when disabled.
- Added durable, user-scoped, idempotent specialist actions and wired `GET/POST /api/coach` to restoration, action, and message handlers.
- Added strict text confirmation, deterministic card-before-persona action events, trusted specialist prompt composition, premium-model routing, structured return proposals, and persistent specialist message attribution.
- Added restoration of the latest 50 messages, authoritative active persona, and pending handoff/return cards.
- Scoped premium-model rollback to provider streaming/finalization only. Tool, persistence, and orchestration errors are not classified as model outages.
- Preserved active sessions for DOM and Anthropic SDK aborts, aggregated input/cache/output token usage across premium rounds, and kept lifecycle logs free of handoff content.

## TDD Evidence

### Inherited work

The resumed worktree intentionally contained tests and implementations from prior RED/GREEN cycles for action persistence, API parsing, prompt safety, session actions, runtime tools/failures, HTTP contracts, restoration, and coach configuration. Raw prior RED terminal output was not present in the handoff, so it is not reconstructed here. On resumption, the inherited suite established its GREEN baseline:

```text
./node_modules/.bin/tsx --test lib/specialists/*.test.ts
36 tests, 36 passed, 0 failed
```

### New RED/GREEN cycles

1. Premium token aggregation and SDK interruption semantics:

```text
RED: ./node_modules/.bin/tsx --test lib/specialists/coachRuntime.test.ts
5 tests: 3 passed, 2 failed
- isModelStreamInterruption is not a function
- accumulateModelUsage is not a function

GREEN: same command
5 tests, 5 passed, 0 failed
```

2. Feature-off restoration route:

```text
RED: ./node_modules/.bin/tsx --test lib/specialists/httpHandlers.test.ts
4 tests: 3 passed, 1 failed
- expected feature-off GET 404, received 500 after restore was called

GREEN: same command
4 tests, 4 passed, 0 failed
```

3. Exact feature-off legacy POST behavior:

```text
RED: ./node_modules/.bin/tsx --test lib/specialists/httpHandlers.test.ts
5 tests: 4 passed, 1 failed
- legacy message with specialist-looking extra field received 400 instead of 200

GREEN: focused runtime/HTTP suite plus typecheck
10 tests, 10 passed, 0 failed; TypeScript clean
```

## Verification

- Full Node test suite: `tsx --test` over all 13 test files.
- Typecheck: `npx tsc --noEmit`.
- Lint: `npm run lint`.
- Production build: `PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH" npm run build` (the default Node 18 binary is below Next.js 16's required Node 20.9).
- Migration/schema integrity: Drizzle-generated `0007_simple_darkstar.sql` and snapshot include the specialist action idempotency ledger.

## Notes

- `SPECIALISTS_ENABLED` remains disabled unless its literal value is `true`.
- `SPECIALIST_MODEL` is only required when a specialist manifest is loaded.
- The specialist generator and specialist-to-specialist consultation remain deferred.

## Review-fix pass

### Changes

- Proposal and return tool calls now persist only the tool name; objective, handoff, and return-summary inputs are omitted from `messages.tool_calls`.
- Specialist actions use a durable claim/replay protocol. The action row is claimed before transition, request identity is validated on every replay, session transitions remain compare-and-swap, and a retry reconstructs/completes the deterministic result if completion storage failed after the transition. Concurrent duplicates replay one result.
- Objective, inbound handoff, and recent user content were removed from the trusted system prompt. They are sent in a separately labeled `UNTRUSTED USER CONTEXT` user block; trusted safety rules, hard constraints, calibration, and vetted prompt modules remain authoritative system content.
- Strict whole-message return requests complete an active consultation immediately, persist a compact `user_requested_return` record, emit Vital persona state, and do not require a model-created return proposal or another confirmation.
- Valid legacy messages take precedence over action-like fields even when specialists are enabled.
- Latest-50 restoration queries now order by descending timestamp and descending message ID before reversing for deterministic chronological display.

### Additional RED/GREEN evidence

4. Review privacy, prompt-boundary, concurrency, return, compatibility, and ordering cases:

```text
RED: tsx --test orchestration/coachRuntime/coachIntegration/httpHandlers/restoration tests
28 tests: 20 passed, 8 failed
- lifecycle tool inputs were not redacted
- explicit-return parser/runtime were absent
- concurrent duplicate transition threw a CAS error and action-key reuse replayed incorrectly
- objective/handoff/recent content remained in the system prompt
- enabled legacy message with action-like metadata returned 400
- equal-timestamp restoration had no ID tiebreaker

GREEN: same focused suite after implementation
28 tests, 28 passed, 0 failed
```

5. Durable claim persistence and broader explicit-return wording:

```text
RED: active-return focused test
1 failed: "return to Vital Coach" was not recognized

GREEN: active-return focused test
1 passed, 0 failed (8 unrelated tests skipped by name filter)

GREEN: action repository + full focused review suite
30 tests, 30 passed, 0 failed
```

### Final review-fix verification

```text
Full Node suite: 55 passed, 0 failed
npx tsc --noEmit: exit 0
npm run lint: exit 0
Node 22 npm run build: compiled, typechecked, and generated successfully
```

The build continues to report only the repository's pre-existing Next.js middleware deprecation warning.
