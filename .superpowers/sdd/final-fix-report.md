# Final review fixes

## Scope

- Prevent `workerErrorEvent` from reading or emitting `code` on unknown non-`Error` objects, even when the value looks allowlisted.
- Replace the source-name timestamp regression with assertions over the actual Drizzle SQL objects constructed for sleep/workout analysis claims, ready notification candidates, and morning briefs.

## TDD evidence

### RED

Command:

```sh
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts
```

Result: exit 1; 5 passed and 2 failed for the expected reasons. The query regression failed because the production query builders did not exist, and the diagnostic regression showed `ERR_INVALID_ARG_TYPE` was emitted from an unknown plain object.

### Focused GREEN

Command:

```sh
npx tsx --test lib/proactiveHealthWorkerSupport.test.ts
```

Result: exit 0; 7 passed and 0 failed. The unknown-object cases use getter-backed valid string and numeric codes and assert the getters are never read. The query test inspects constructed query chunks, rejects every `Date` parameter, and requires the exact ISO `now` and analysis lease strings.

## Implementation notes

- `workerErrorEvent` now attempts `code` access only after `instanceof Error` succeeds.
- Existing safe code handling for genuine `Error` objects is unchanged.
- Analysis, notification-candidate, and morning-brief raw SQL construction was extracted into small exported builders used directly by the existing repository operations.
- SQL text, table selection, lock behavior, limits, lease duration, execution order, and mapping semantics are unchanged.

## Verification

- `npx tsx --test lib/proactiveHealthWorkerSupport.test.ts lib/proactiveHealthWorker.test.ts lib/proactiveHealthLeaseSemantics.test.ts`: exit 0; 23 passed, 0 failed.
- `npm run build:worker`: exit 0; esbuild produced `dist/proactive-health-worker.cjs`.
- `npx tsc --noEmit`: exit 0.
- `git diff --check`: exit 0.

## Concerns

None identified within this review-fix scope.
