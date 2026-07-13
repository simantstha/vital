# Proactive Token Placement Prompt Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make initial and repair generations use the fewest supplied evidence tokens, never repeat one, and place every used token at the terminal boundary accepted by production grounding.

**Architecture:** Change only the shared `TOKEN_CONTRACT` wording and its deterministic prompt/live-gate tests. Keep the exact schema, encoder, validator, proof, repair, retry, worker, notification, recovery, database, and deployment behavior unchanged; production rollout remains an operator-controlled deploy, synthetic gate, and worker-resume sequence.

**Tech Stack:** TypeScript, Node.js `node:test`, Anthropic SDK, esbuild, Next.js, Fly.io, GitHub Actions

## Global Constraints

- Work only on `feat/fix-proactive-token-placement-prompt`; never push or merge `main`.
- Modify only `lib/proactiveAnalysisGeneration.ts` and `lib/proactiveAnalysisGeneration.test.ts`; this plan is documentation only.
- Keep both prompts deterministic and free of every Unicode numeric code point.
- Preserve the exact five-field JSON schema and every existing closed-token prohibition.
- Do not change validation, encoding, proof ownership, repair flow, retries, workers, notifications, recovery, schema, migrations, dependencies, rows, or deployment configuration.
- Keep the proactive worker paused through implementation, review, merge, deployment, and the opt-in synthetic gate.
- Use synthetic evidence only; never enqueue, mutate, or notify a user from the gate.

## File Map

- Modify `lib/proactiveAnalysisGeneration.test.ts`: deterministic prompt-contract regression and existing opt-in synthetic gate assertions.
- Modify `lib/proactiveAnalysisGeneration.ts`: the shared `TOKEN_CONTRACT` wording only.

---

### Task 1: Tighten Token Placement, Verify, and Roll Out Safely

**Files:**
- Modify: `lib/proactiveAnalysisGeneration.test.ts:73-140`
- Modify: `lib/proactiveAnalysisGeneration.ts:37-42`

**Interfaces:**
- Consumes: `PROACTIVE_ANALYSIS_SYSTEM_PROMPT`, `PROACTIVE_ANALYSIS_REPAIR_PROMPT`, `generateGroundedAnalysis`, and `consumeGroundedAnalysisProof`
- Produces: identical initial/repair minimal-use and clause-terminal instructions; no runtime API or type change

- [ ] **Step 1: Add deterministic failing assertions for both prompts**

Inside the existing system/repair prompt loop, retain all schema and closed-token assertions and add:

```ts
assert.match(prompt, /fewest evidence tokens needed/i);
assert.match(prompt, /omit (?:an evidence )?token when qualitative language is sufficient/i);
assert.match(prompt, /never repeat an evidence token anywhere in the response/i);
assert.match(prompt, /final content of (?:its|the) clause or string/i);
assert.match(prompt, /immediately before (?:a )?terminal punctuation mark/i);
for (const prohibitedAfterToken of ['unit', 'qualifier', 'parenthetical', 'symbol', 'prose']) {
  assert.match(prompt, new RegExp(prohibitedAfterToken, 'i'));
}
assert.match(prompt, /no content after the token in that clause/i);
assert.doesNotMatch(prompt, /\p{N}/u);
```

Keep assertions for exact scalar/array types, no additional keys, exact copying, scalar or array-item placement, alter/split/concatenate/nest/enumerate/manufacture prohibitions, raw numbers, numeric-symbol sequences, signs before tokens, and units/percentages/degrees/symbols after tokens.

- [ ] **Step 2: Run the deterministic test and confirm RED**

```bash
npx tsx --test --test-name-pattern='prompt expresses the closed token contract' lib/proactiveAnalysisGeneration.test.ts
```

Expected: exit `1` because both current prompts lack the explicit fewest-token, qualitative omission, global no-repeat, immediate-punctuation, and no-content-after-token wording. The opt-in network test does not run.

- [ ] **Step 3: Make the smallest digit-free prompt change**

Replace only `TOKEN_CONTRACT` with this shared wording, preserving both prompt templates unchanged:

```ts
const TOKEN_CONTRACT = `Copy only supplied evidence tokens exactly. Use the fewest evidence tokens needed to answer the request, and omit a token when qualitative language is sufficient. Copy a token only into a scalar string or an individual array-item string. Never repeat an evidence token anywhere in the response. A copied token must be the final content of its clause or string. When punctuation is used, place the token immediately before a terminal punctuation mark, with no unit, qualifier, parenthetical, symbol, or other prose between the token and that punctuation. Place no content after the token in that clause. Never place a sign before a token or a unit, percent, degree, or other numeric symbol after it. Never alter, split, concatenate, nest, enumerate, or manufacture a token. Never write a raw number or numeric symbol sequence.`;
```

Expected: initial and repair prompts inherit exactly the same minimal-use and terminal-placement contract, with no raw digit code point.

- [ ] **Step 4: Confirm focused GREEN and preserve the synthetic gate**

```bash
npx tsx --test lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisSchema.test.ts lib/proactiveHealthWorker.test.ts lib/proactiveNotificationState.test.ts
npx tsc --noEmit
```

Expected: all focused tests pass; the ordinary run skips `synthetic live proactive analysis returns typed grounded output` and performs no network call. Keep that opt-in test synthetic and ensure its production grounding path rejects unknown, duplicated, malformed, raw-digit, or non-terminal tokens, consumes the proof, and reports only sanitized identifiers/counts/booleans—never model prose.

- [ ] **Step 5: Run the full local verification gate**

```bash
rg --files -g '*.test.ts' -0 | xargs -0 npx tsx --test
npx tsc --noEmit
npm run lint
npm run build:worker
DATABASE_URL=postgresql://test:test@localhost:5432/test npm run build
git diff --check
git diff --exit-code HEAD -- lib/proactiveAnalysisSchema.ts lib/proactiveAnalysisGrounding.ts lib/proactiveHealthWorker.ts scripts/proactive-health-worker.ts lib/proactiveAnalysisRecovery.ts lib/proactiveAnalysisRecoveryDrizzle.ts scripts/recover-proactive-analysis-jobs.ts db/schema.ts db/migrations package.json package-lock.json .github/workflows fly.toml
```

Expected: tests, typecheck, lint, worker bundle, and production build succeed; only the prompt module and test differ; no protected runtime, data, dependency, or deployment path changes.

- [ ] **Step 6: Commit, push, and open the PR**

```bash
git add lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisGeneration.test.ts
git commit -m "fix: clarify proactive evidence token placement"
git push -u origin feat/fix-proactive-token-placement-prompt
gh pr create --base main --head feat/fix-proactive-token-placement-prompt --title "fix: clarify proactive evidence token placement" --body $'## Summary\n- require minimal, non-repeated evidence-token use\n- make every token terminal within its clause or string\n- preserve schema, grounding, repair, retry, and notification behavior\n\n## Verification\n- focused and full Node tests\n- typecheck and lint\n- worker and production builds\n\n## Release gate\nKeep the proactive worker paused until deployment and the opt-in synthetic live gate pass.'
```

Expected: one conventional prompt/test commit is pushed and a PR against `main` is opened. Stop; the user reviews and merges.

- [ ] **Step 7: After user merge, verify deploy while the worker stays paused**

```bash
worker_id="$(fly machines list -a vital-coach --json | jq -r '.[] | select(.config.metadata.fly_process_group == "worker") | .id' | head -n 1)"
test -n "$worker_id"
fly machine status "$worker_id" -a vital-coach --json | jq -e '.state == "stopped" or .state == "suspended"'
run_id="$(gh run list --workflow=release.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status --interval 30
gh run view "$run_id" --json status,conclusion,jobs
```

Expected: the merged release and backend deploy succeed while the worker remains stopped or suspended. Deployment does not automatically run the gate or resume the worker.

- [ ] **Step 8: Run the deployed opt-in synthetic gate once**

From a clean checkout of the exact deployed `main` SHA with an operator-provided Anthropic credential:

```bash
test "$(git rev-parse HEAD)" = "$(gh api repos/simantstha/vital/commits/main --jq .sha)"
RUN_PROACTIVE_ANALYSIS_LIVE_TEST=true npx tsx --test --test-name-pattern='synthetic live proactive analysis' lib/proactiveAnalysisGeneration.test.ts
```

Expected: exact five-field shape, no raw digits/malformed fragments, supplied tokens only, no duplicates, terminal placement for every token, production grounding, and proof consumption all pass. On failure, leave the worker paused and use only sanitized diagnostics.

- [ ] **Step 9: Resume only after the gate, then monitor notifications**

```bash
fly machine start "$worker_id" -a vital-coach
fly machine status "$worker_id" -a vital-coach --json | jq -e '.state == "started"'
fly logs -a vital-coach --no-tail
gh run view "$run_id" --json status,conclusion,jobs
```

Expected: preserved retries progress through analysis completion and observable notification attempts under the existing delivery contract. Confirm only privacy-safe status/count evidence; never expose IDs, health payloads, model prose, device tokens, or APNs tokens.

## Plan Self-Review

- The pre-change prompt fails deterministically before production wording changes.
- One shared digit-free constant keeps initial and repair instructions identical.
- Local gates cover prompt, schema, grounding, worker, notification, full tests, types, lint, worker bundle, and production build.
- The PR stops before merge; post-merge deployment, live gate, worker resume, and notification monitoring remain operator-controlled.
