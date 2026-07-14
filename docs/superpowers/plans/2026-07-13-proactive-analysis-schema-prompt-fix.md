# Proactive Analysis Schema Prompt Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task, with a fresh implementation worker and independent review worker. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both proactive-analysis prompts state the exact five-field JSON shape so the live model returns arrays for `observations` and `nextSteps`, without changing validation, grounding, retry, recovery, or notification behavior.

**Architecture:** Strengthen only the two shared prompt strings and their prompt-contract tests. Keep all request guarding and generation control flow intact; prove the wording is digit-free, preserves the closed evidence-token rules, and accurately distinguishes scalar strings from individual array-item strings.

**Tech Stack:** TypeScript, Node.js `node:test`, Anthropic SDK, esbuild, Next.js, Fly.io

## Global Constraints

- Work only on `feat/fix-proactive-schema-prompt`; never push or merge `main`.
- Modify only `lib/proactiveAnalysisGeneration.ts`, `lib/proactiveAnalysisGeneration.test.ts`, and this plan unless an independent reviewer identifies a directly related test-only omission.
- Do not change `CoachAnalysis`, `parseCoachAnalysis`, evidence encoding/grounding/proof ownership, model selection, generation calls, bounded repair, retry timing/counts, recovery, worker claims, notification state, APNs, schema, migrations, dependencies, or deployment configuration.
- Both prompts must remain free of every Unicode numeric code point and must pass the existing outbound raw-number guard.
- Keep the worker paused through review, merge, deployment, and the synthetic live gate. Do not let production jobs consume retries until that gate passes.
- Use synthetic health data only for the live gate. Do not enqueue, claim, update, or notify a user.

## File Map

- Modify `lib/proactiveAnalysisGeneration.test.ts`: exact prompt-shape assertions, corrected token-location assertions, and an explicitly gated synthetic live test.
- Modify `lib/proactiveAnalysisGeneration.ts`: prompt text only.

---

### Task 1: Lock the Exact Prompt Contract With Failing Tests

**Files:**
- Modify: `lib/proactiveAnalysisGeneration.test.ts`

- [ ] **Step 1: Replace the stale prompt-location assertion with exact shape assertions**

For each of `PROACTIVE_ANALYSIS_SYSTEM_PROMPT` and `PROACTIVE_ANALYSIS_REPAIR_PROMPT`, assert all of the following independently:

```ts
assert.doesNotMatch(prompt, /\p{N}/u);
assert.match(prompt, /headline, shortInsight, and narrative must each be a non-empty JSON string/i);
assert.match(prompt, /observations and nextSteps must each be a JSON array of non-empty JSON strings/i);
assert.match(prompt, /no additional keys/i);
assert.match(prompt, /scalar string or (?:an )?individual array-item string/i);
assert.doesNotMatch(prompt, /five schema string locations/i);
```

Retain the existing assertions for JSON-only output, observational/non-diagnostic language, exact token copying, single use, clause/string termination, no raw number or numeric-symbol sequence, qualitative fallback, and the alter/split/concatenate/nest/enumerate/manufacture/unit/sign/symbol restrictions.

- [ ] **Step 2: Add an opt-in synthetic live contract test**

Add a test named exactly `synthetic live proactive analysis returns typed grounded output`, skipped unless `RUN_PROACTIVE_ANALYSIS_LIVE_TEST === 'true'`. It must dynamically create the Anthropic client only when enabled, pass representative synthetic input through `generateGroundedAnalysis`, inspect the sole raw text block as JSON to assert both list fields are arrays of non-empty strings, and then call `consumeGroundedAnalysisProof` with the same source to prove grounding, resolution, and the exact resolved shape. It must use `proactiveAnalysisModel(process.env)` and must not import database, repository, worker-script, recovery, or APNs modules. The ordinary suite must report this test as skipped and make no network call.

- [ ] **Step 3: Confirm RED before production edits**

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts
```

Expected: exit `1`; both prompts fail the new exact scalar/array and token-location assertions because they currently call all five fields “string locations.” Existing generation/repair tests remain otherwise green, and the opt-in live test is skipped without a network call.

- [ ] **Step 4: Commit only after Task 2 is green**

Do not commit a red state. Continue directly to Task 2.

---

### Task 2: Correct Both Prompts With Digit-Free Wording

**Files:**
- Modify: `lib/proactiveAnalysisGeneration.ts`
- Verify: `lib/proactiveAnalysisGeneration.test.ts`

- [ ] **Step 1: Add one shared digit-free schema contract**

Add prompt wording equivalent to the following, with no digits or raw numeric-symbol sequence:

```text
headline, shortInsight, and narrative must each be a non-empty JSON string. observations and nextSteps must each be a JSON array of non-empty JSON strings. No additional keys are allowed.
```

Include the same contract in both initial and repair prompts, preferably through one shared constant so the contracts cannot drift.

- [ ] **Step 2: Correct only the token-location sentence**

Replace “the five schema string locations” with wording that permits a supplied evidence token only inside a scalar string or an individual array-item string. Preserve every other closed-token restriction verbatim unless punctuation must change for grammar.

- [ ] **Step 3: Confirm focused GREEN and outbound guarding**

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisSchema.test.ts
npx tsc --noEmit
```

Expected: exit `0`; both prompts satisfy the exact type/location contract, contain no Unicode numeric code point, guarded initial and repair requests remain accepted, and all schema/grounding/proof behavior stays green.

- [ ] **Step 4: Audit the diff boundary**

```bash
git diff --check
git diff --name-only HEAD -- lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisGeneration.test.ts
git diff --exit-code HEAD -- lib/proactiveAnalysisSchema.ts lib/proactiveAnalysisGrounding.ts lib/proactiveHealthWorker.ts scripts/proactive-health-worker.ts lib/proactiveAnalysisRecovery.ts lib/proactiveAnalysisRecoveryDrizzle.ts scripts/recover-proactive-analysis-jobs.ts db/schema.ts db/migrations .github/workflows fly.toml
```

Expected: no whitespace errors; only the prompt module and prompt test are changed; every validator, grounding, worker, retry, recovery, schema, and release path is byte-unchanged.

- [ ] **Step 5: Commit the prompt fix**

```bash
git add lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisGeneration.test.ts
git commit -m "fix: specify proactive analysis response shape"
```

Expected: one conventional commit containing prompt text and prompt-focused tests only.

---

### Task 3: Full Verification and Independent Review

- [ ] **Step 1: Run the complete local gate at the exact commit**

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisSchema.test.ts lib/proactiveHealthWorker.test.ts lib/proactiveHealthLeaseSemantics.test.ts
rg --files -g '*.test.ts' -0 | xargs -0 npx tsx --test
npx tsc --noEmit
npm run lint
npm run build:worker
DATABASE_URL=postgresql://test:test@localhost:5432/test npm run build
git diff --check
git status --short
```

Expected: focused and full suites pass; typecheck and lint exit `0`; worker and production builds succeed; no whitespace errors; the worktree is clean.

- [ ] **Step 2: Request independent review**

Ask a fresh reviewer to compare the branch with `origin/main` and verify:

- both prompts express the exact three scalar-string and two string-array types;
- the token location is an individual string, never an array value itself;
- digit-free/outbound-guard and all closed-token rules remain intact;
- no validator, grounding, proof, repair, retry, recovery, worker, notification, or deployment behavior changed;
- the tests would fail against the pre-fix prompt.

Expected: reviewer reports no findings. Resolve any valid finding with a failing test first, rerun the full gate, and obtain a clean re-review.

- [ ] **Step 3: Self-review the final commit**

```bash
base="$(git merge-base origin/main HEAD)"
git diff --stat "$base"..HEAD
git diff "$base"..HEAD -- lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisGeneration.test.ts
git diff --exit-code "$base"..HEAD -- lib/proactiveAnalysisSchema.ts lib/proactiveAnalysisGrounding.ts lib/proactiveHealthWorker.ts scripts/proactive-health-worker.ts lib/proactiveAnalysisRecovery.ts lib/proactiveAnalysisRecoveryDrizzle.ts scripts/recover-proactive-analysis-jobs.ts db/schema.ts db/migrations .github/workflows fly.toml
git status --short
```

Expected: the final diff is minimal, prompt/test-only, matches the approved design exactly, and the worktree is clean.

---

### Task 4: Push and Open the PR Without Resuming the Worker

- [ ] **Step 1: Reconfirm the production safety gate**

```bash
worker_id="$(fly machines list -a vital-coach --json | jq -r '.[] | select(.config.metadata.fly_process_group == "worker") | .id' | head -n 1)"
test -n "$worker_id"
fly machine status "$worker_id" -a vital-coach --json | jq -e '.state == "stopped" or .state == "suspended"'
```

Expected: exactly the intended worker machine is identified and remains stopped or suspended. If it is running, stop and investigate before proceeding; do not consume more recovered-job retries.

- [ ] **Step 2: Push and create a ready PR**

```bash
git push -u origin feat/fix-proactive-schema-prompt
gh pr create \
  --base main \
  --head feat/fix-proactive-schema-prompt \
  --title "fix: specify proactive analysis response shape" \
  --body $'## Summary\n- require exact scalar and array JSON types in both proactive prompts\n- correct evidence-token locations to scalar and individual array-item strings\n- preserve validation, grounding, repair, retry, recovery, and notification behavior\n\n## Verification\n- focused and full Node test suites\n- TypeScript and ESLint\n- worker and production builds\n- independent review\n\n## Release gate\nKeep the proactive worker paused until deployment and a synthetic live shape, grounding, and proof-resolution check pass.'
```

Expected: branch push succeeds and a non-draft PR against `main` is opened. Stop without merging; the user reviews and merges.

---

## Post-Merge Release and Live Gate

- [ ] **Step 1: Mother the release while the worker stays paused**

```bash
run_id="$(gh run list --workflow=release.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$run_id"
gh run watch "$run_id" --exit-status --interval 30
gh run view "$run_id" --json status,conclusion,jobs
fly machine status "$worker_id" -a vital-coach --json | jq -e '.state == "stopped" or .state == "suspended"'
```

Expected: the merged commit's version and backend deployment jobs succeed, the worker is still paused, and no recovered job spent another retry during rollout. If release fails, leave the worker paused.

- [ ] **Step 2: Run one synthetic live model check from the deployed commit**

In a clean checkout of the exact deployed SHA, run the explicitly opt-in live test with an operator-provided Anthropic credential:

```bash
test "$(git rev-parse HEAD)" = "$(gh api repos/{owner}/{repo}/commits/main --jq .sha)"
RUN_PROACTIVE_ANALYSIS_LIVE_TEST=true npx tsx --test --test-name-pattern='synthetic live proactive analysis' lib/proactiveAnalysisGeneration.test.ts
```

The gated test must call `generateGroundedAnalysis` with representative synthetic workout/context input, use `proactiveAnalysisModel(process.env)` and the real Anthropic transport, inspect the raw JSON to require `Array.isArray(observations)` and `Array.isArray(nextSteps)`, then consume the returned proof and assert the resolved result has the exact five-field schema and grounded source displays. It must not initialize the database/APNs modules or enqueue, claim, persist, or notify anything.

Expected: one live generation passes shape validation, evidence grounding, proof consumption, and resolved-schema validation. If it fails or repairs into another schema failure, leave the worker paused and investigate the prompt; do not weaken validation or alter retries/recovery.

- [ ] **Step 3: Resume only after every gate passes**

```bash
fly machine start "$worker_id" -a vital-coach
fly machine status "$worker_id" -a vital-coach --json | jq -e '.state == "started"'
```

Expected: the existing worker machine starts only after release and synthetic verification are green.

- [ ] **Step 4: Monitor analysis and notification outcomes**

```bash
fly logs -a vital-coach --no-tail
gh run view "$run_id" --json status,conclusion,jobs
```

Using the existing read-only production query path, verify count-only evidence that the recovered jobs leave analysis retry state, reach ready/sent or an explicit bounded terminal outcome, and create APNs notification-attempt rows. Confirm there is no repeated `schema_failure` for scalar `observations`/`nextSteps` and no worker-stage error loop. Do not expose IDs, health payloads, model output, device tokens, or APNs tokens in logs or PR comments.

Expected: recovered analyses complete, notification attempts are recorded, and successful APNs outcomes reach `sent`; any explicit APNs retry/failure follows the unchanged notification policy.

## Plan Self-Review

- TDD begins with assertions that fail on the approved pre-fix prompt.
- Production scope is prompt wording only; tests cover exact types, corrected token locations, digit-free guarding, and preserved token rules.
- Verification covers focused/full tests, typecheck, lint, production/worker builds, immutable-boundary audits, and independent review.
- The PR stops before merge, and the post-merge runbook keeps the worker paused until release plus synthetic shape/grounding/proof verification succeed.
- No validator, repair, retry, recovery, database, worker, notification, APNs, or deployment change is authorized by this plan.
