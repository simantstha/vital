# Final-review fix report

## Scope

- Enforce exact numeric value plus the same source unit in `validateGroundedAnalysis`.
- Keep explicit unitless evidence distinct from unitful evidence.
- Reject dropped, added, replaced, unsupported, and separator-disguised units.
- Normalize the existing short/spelled unit aliases consistently, including case variants.
- Put the same-source-unit contract in both initial and repair prompts.
- Add a DB-free structural seam/test for the production recovery Drizzle adapter.
- Preserve analysis leases, privacy-safe events, recovery notification state, and unrelated row fields.

## Root cause

The grounding map keyed only by the textual number and stored zero or more units. A numeric evidence value with an inferred unit created an entry for the number, but a bare output claim checked only that the entry existed. The output regex also made the unit optional and recognized only an allowlist, so an unknown or separator-disguised suffix could be ignored. This collapsed unitless and unitful evidence and violated the exact-value/same-source-unit contract.

The recovery policy tests used only a fake `RecoveryStore`. They proved transactional policy but did not inspect the actual Drizzle adapter's two locks, update predicates, assignments, or returning projection.

## TDD evidence

### Initial RED

Command:

```sh
npx tsx --test lib/proactiveHealthWorker.test.ts lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisRecoveryDrizzle.test.ts
```

Result: exit 1; 22 passed and 3 failed. The prompt test failed because `exact supplied value` wording was absent. The grounding matrix failed while exercising spelled `milliseconds`, showing the old alternation parsed its `mi` prefix as miles. The new adapter test initially touched `@/db` and failed on missing `DATABASE_URL`; the test import was corrected to the schema-only module so it has no database/config access.

Adapter seam sensitivity was then checked with the production seam temporarily absent:

```sh
npx tsx --test lib/proactiveAnalysisRecoveryDrizzle.test.ts
```

Result: exit 1 with `Cannot find module './proactiveAnalysisRecoveryDrizzle'`, proving the structural test depends on the real adapter seam rather than duplicating policy behavior.

### Additional disguise RED

After self-review added underscore and slash separator regressions:

```sh
npx tsx --test --test-name-pattern='same source unit' lib/proactiveHealthWorker.test.ts
```

Result: exit 1 with `Missing expected exception.` The old boundary skipped `45_ms`; the scanner was changed to find the numeric claim and reject `[-_/]unit` disguises.

### Focused GREEN

Command:

```sh
npx tsx --test lib/proactiveHealthWorker.test.ts lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisRecoveryDrizzle.test.ts
```

Result: exit 0; 25 passed and 0 failed.

The regression matrix covers:

- exact `45 ms` and spelled `45 milliseconds`;
- explicit unitless `45` evidence;
- intended `hours`/`hrs` and `kcal`/`calories` variants;
- dropped units and added units on unitless evidence;
- wrong recognized units;
- unsupported words such as `seconds` and `bananas`;
- hyphen, underscore, and slash disguises.

The adapter test uses schema objects plus an in-memory fluent transaction. It does not import `db/index`, open a database, invoke the recovery CLI, or call `recoverProactiveAnalysisJobs`. It proves both table locks, the ID/status/lease/result compare-and-set predicates, ID returning projections, and exactly the five approved assignments.

## Final verification

Command:

```sh
npx tsx --test lib/proactive*.test.ts
npx tsc --noEmit
npm run lint
npm run build:worker
git diff --check
```

Results:

- Proactive tests: exit 0; 79 passed, 0 failed.
- TypeScript: exit 0.
- ESLint: exit 0.
- Worker build: exit 0; `dist/proactive-health-worker.cjs` emitted.
- Whitespace check: exit 0.

## Self-review

- Grounding evidence is now a set of exact `(numeric value, canonical unit-or-unitless)` tuples; a unitful tuple never authorizes a bare claim.
- Unknown output suffixes fail closed and never become unitless evidence.
- Both prompts explicitly state exact supplied value and same source unit and forbid dropping, adding, disguising, or replacing units.
- Analysis failure events and logs were not widened; no evidence, response, ID, exception, or token data was added.
- Recovery still parses IDs before dynamically importing the database.
- The extracted adapter retains one transaction, both `FOR UPDATE` locks, all four CAS conditions, returned IDs, and only `status`, `retry_count`, `next_attempt_at`, `lease_token`, and `lease_expires_at` assignments.
- No notification, result, `updated_at`, privacy, release, schema, or migration behavior changed.

## Concerns

None identified within this final-review scope.
