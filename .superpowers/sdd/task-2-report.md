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
