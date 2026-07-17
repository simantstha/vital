# Haiku Analysis Evidence Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Haiku for proactive analysis while preventing token-free or placeholder-style meta-responses from being stored as ready workout or sleep analyses.

**Architecture:** Preserve the existing opaque-token transport and proof boundary. Add private provenance for tokens allocated from `source.input`, require at least one such token when input numeric evidence exists, reject a narrow set of observed meta-response phrases, and rewrite the shared prompt contract so Haiku treats tokens as verified measurements.

**Tech Stack:** TypeScript, Node test runner, Anthropic SDK, existing proactive-analysis grounding and generation modules.

## Global Constraints

- Keep `claude-haiku-4-5` as `DEFAULT_PROACTIVE_ANALYSIS_MODEL`.
- Do not change database schema, migrations, API response shape, APNs behavior, retry counts, notification behavior, dependencies, or deployment configuration.
- Keep token provenance private in the existing `WeakMap`; never serialize it into the model payload or expose it through a public type.
- Require at least one `source.input` evidence token only when `source.input` produced numeric evidence tokens; do not require every supplied metric.
- Reject the explicit meta-response phrases `unable to process`, `placeholder token`, `template variable`, `unresolved token`, and `data integrity`, case-insensitively with singular/plural support where applicable.
- Classify all new semantic rejections as the existing `grounding_failure` so the current one-repair and job-retry behavior remains unchanged.
- Keep both prompt variants free of every Unicode numeric code point.
- Preserve the existing exact-token, no-reuse, no-raw-number, and clause-terminal placement rules.
- Follow test-driven development: add each regression assertion and observe the expected failure before editing production code.

---

### Task 1: Require real session-input evidence and reject meta-responses

**Files:**
- Modify: `lib/proactiveAnalysisGrounding.test.ts:259-379`
- Modify: `lib/proactiveAnalysisGrounding.ts:13-180,247-362`
- Modify: `lib/proactiveAnalysisGeneration.test.ts:44-67,174-260`

**Interfaces:**
- Consumes: `EncodedProactiveAnalysisRequest`, `groundAnalysisText`, `modelPayload`, and `AnalysisContentError('grounding_failure')`.
- Produces: private `PrivateEncodingState.inputTokens: ReadonlySet<string>` and grounding behavior that requires one used input token when that set is non-empty.

- [ ] **Step 1: Add failing grounding regressions**

Add these tests after `accepts one optional complete JSON code fence` in `lib/proactiveAnalysisGrounding.test.ts`:

```ts
test('requires session-input evidence when numeric input tokens are available', () => {
  const request: ProactiveAnalysisSource = {
    kind: 'workout',
    date: '2026-07-17',
    input: { durationMin: 60 },
    availableContext: { metrics: [{ metric: 'hrv_sdnn', value: 45 }] },
  };
  const encoded = encodeProactiveAnalysisRequest(request);
  const payload = modelPayload(encoded) as {
    input: { durationMin: string };
    availableContext: { metrics: Array<{ value: string }> };
  };

  assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify(validAnalysis), encoded));
  assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({
    ...validAnalysis,
    narrative: `Context HRV was ${payload.availableContext.metrics[0].value}.`,
  }), encoded));

  const proof = groundAnalysisText(JSON.stringify({
    ...validAnalysis,
    narrative: `Workout duration was ${payload.input.durationMin}.`,
  }), encoded);
  assert.match(consumeGroundedAnalysisProof(proof, request).narrative, /60 minutes/);
});

test('rejects placeholder-style meta-responses even when they copy input evidence', () => {
  const request: ProactiveAnalysisSource = {
    kind: 'workout', date: 'date', input: { durationMin: 60 }, availableContext: {},
  };

  for (const phrase of [
    'Unable to process workout data',
    'The record contains placeholder tokens',
    'The record contains a template variable',
    'The record contains unresolved tokens',
    'Data integrity must be restored',
  ]) {
    const encoded = encodeProactiveAnalysisRequest(request);
    const payload = modelPayload(encoded) as { input: { durationMin: string } };
    assertCategory('grounding_failure', () => groundAnalysisText(JSON.stringify({
      ...validAnalysis,
      narrative: `${phrase}. Recorded duration was ${payload.input.durationMin}.`,
    }), encoded));
  }
});
```

- [ ] **Step 2: Run the focused grounding tests and verify RED**

Run:

```bash
node --import tsx --experimental-test-module-mocks --test lib/proactiveAnalysisGrounding.test.ts
```

Expected: the new token-free and context-only assertions fail because `groundAnalysisText` currently accepts them; the placeholder-style assertions also fail because those phrases are not currently rejected.

- [ ] **Step 3: Add private input-token provenance and semantic checks**

In `lib/proactiveAnalysisGrounding.ts`, extend the private state and add the narrow meta-response matcher:

```ts
interface PrivateEncodingState {
  payload: unknown;
  displays: ReadonlyMap<string, string>;
  inputTokens: ReadonlySet<string>;
  binding: string;
}

const META_RESPONSE = /\b(?:unable to process|placeholder tokens?|template variables?|unresolved tokens?|data integrity)\b/iu;
```

In `groundAnalysisText`, validate authored strings once, reject meta language, then enforce the input-token intersection before resolution:

```ts
const strings = authoredStrings(validated);
const used = new Set<string>();
for (const value of strings) {
  if (META_RESPONSE.test(value)) throw new AnalysisContentError('grounding_failure');
  validateTokenUse(value, state.displays, used);
}
if (state.inputTokens.size > 0 && ![...state.inputTokens].some((token) => used.has(token))) {
  throw new AnalysisContentError('grounding_failure');
}
```

In `encodeProactiveAnalysisRequest`, collect tokens only while encoding `source.input`:

```ts
const inputTokens = new Set<string>();
let collectingInputTokens = false;

const allocate = (display: string): string => {
  const token = `{{EVIDENCE_${alphabeticName(nextToken++)}}}`;
  if (!TOKEN.test(token)) throw new Error('Invalid evidence token.');
  displays.set(token, display);
  if (collectingInputTokens) inputTokens.add(token);
  return token;
};
```

Replace direct construction of the encoded members with a bounded collection
section that preserves the existing kind, date, input, then context allocation
order:

```ts
const encodedKind = encodeValue(source.kind, 'kind');
const encodedDate = encodeValue(source.date, 'date');
let encodedInput: unknown;
collectingInputTokens = true;
try {
  encodedInput = encodeValue(source.input, 'input');
} finally {
  collectingInputTokens = false;
}
const encodedAvailableContext = encodeValue(source.availableContext, 'availableContext');

const semanticallyOrdered = {
  kind: encodedKind,
  date: encodedDate,
  input: encodedInput,
  availableContext: encodedAvailableContext,
};
```

Store the private set with the existing state:

```ts
encodings.set(encoded as object, { payload, displays, inputTokens, binding });
```

Keep `requestBinding` unchanged because the serialized payload already binds every token to its source location, while `inputTokens` is deterministically derived from that payload.

- [ ] **Step 4: Update generation-test helpers to use input evidence**

In `lib/proactiveAnalysisGeneration.test.ts`, replace `hrvToken` with:

```ts
function durationToken(request: AnalysisGenerationRequest): string {
  const payload = request.attempt === 'initial' ? payloadOf(request) : payloadOf(request).request;
  assertRecord(payload);
  const input = payload.input;
  assertRecord(input);
  const duration = input.durationMin;
  assert.ok(typeof duration === 'string');
  return duration;
}

function tokenResponse(request: AnalysisGenerationRequest): string {
  return JSON.stringify({ ...valid, narrative: `Workout duration was ${durationToken(request)}.` });
}
```

Change non-live assertions that inspect `tokenResponse` results from `/45 ms/` to `/38 minutes/`. Do not change the opt-in live test's HRV-specific assertions; its `liveSource.input` contains no numeric evidence, so context HRV remains supported.

- [ ] **Step 5: Run focused grounding and generation tests and verify GREEN**

Run:

```bash
node --import tsx --experimental-test-module-mocks --test lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisGeneration.test.ts
```

Expected: all focused tests pass, with the synthetic live test reported as skipped unless explicitly enabled.

- [ ] **Step 6: Commit the semantic guard**

```bash
git add lib/proactiveAnalysisGrounding.ts lib/proactiveAnalysisGrounding.test.ts lib/proactiveAnalysisGeneration.test.ts
git commit -m "fix: require session evidence in proactive analysis"
```

---

### Task 2: Clarify the Haiku evidence-token prompt

**Files:**
- Modify: `lib/proactiveAnalysisGeneration.test.ts:78-120`
- Modify: `lib/proactiveAnalysisGeneration.ts:37-43`

**Interfaces:**
- Consumes: the existing digit-free `SCHEMA_CONTRACT`, `TOKEN_CONTRACT`, and `CONTENT_CONTRACT` composition.
- Produces: both exported prompt variants with explicit verified-value semantics and unchanged schema/content contracts.

- [ ] **Step 1: Add failing prompt-contract assertions**

Inside `prompt expresses the closed token contract without numeric code points`, add:

```ts
assert.match(prompt, /verified recorded value/i);
assert.match(prompt, /already includes its display unit/i);
assert.match(prompt, /treat evidence tokens as real measurements/i);
assert.match(prompt, /not placeholders or missing data/i);
assert.match(prompt, /never describe the request as containing placeholders/i);
assert.match(prompt, /template variables/i);
assert.match(prompt, /unresolved tokens/i);
assert.match(prompt, /data integrity problem/i);
```

- [ ] **Step 2: Run the focused generation test and verify RED**

Run:

```bash
node --import tsx --experimental-test-module-mocks --test lib/proactiveAnalysisGeneration.test.ts
```

Expected: both system and repair prompt-contract tests fail on the new verified-value and forbidden-meta-language assertions.

- [ ] **Step 3: Rewrite the shared token contract**

Replace only `TOKEN_CONTRACT` in `lib/proactiveAnalysisGeneration.ts` with this digit-free text:

```ts
const TOKEN_CONTRACT = `Every supplied evidence token stands for a verified recorded value and already includes its display unit when applicable. Treat evidence tokens as real measurements, not placeholders or missing data. Never describe the request as containing placeholders, template variables, unresolved tokens, missing metric values, or a data integrity problem. Copy only supplied evidence tokens exactly into natural user-facing prose. Cite the session's key metrics: for a workout, cite duration, distance, pace, and average heart rate when supplied; for sleep, cite duration and efficiency. Copy a token only into a scalar string or an individual array-item string. Never repeat an evidence token anywhere in the response. A copied token must be the final content of its clause or string. When punctuation is used, place the token immediately before a terminal punctuation mark. Place no content after the token in that clause. Never place a unit, qualifier, parenthetical, symbol, or other prose after the token. Never place a sign before a token. Never alter, split, concatenate, nest, enumerate, or manufacture a token. Never write a raw number or numeric symbol sequence.`;
```

Do not change `DEFAULT_PROACTIVE_ANALYSIS_MODEL`, `SCHEMA_CONTRACT`, `CONTENT_CONTRACT`, repair flow, or generation behavior.

- [ ] **Step 4: Run focused proactive-analysis tests and verify GREEN**

Run:

```bash
node --import tsx --experimental-test-module-mocks --test lib/proactiveAnalysisGeneration.test.ts lib/proactiveAnalysisGrounding.test.ts
```

Expected: all focused tests pass and the live test remains skipped by default.

- [ ] **Step 5: Commit the prompt clarification**

```bash
git add lib/proactiveAnalysisGeneration.ts lib/proactiveAnalysisGeneration.test.ts
git commit -m "fix: clarify Haiku evidence token semantics"
```

---

### Task 3: Verify the complete branch and prepare the pull request

**Files:**
- Verify only: `lib/proactiveAnalysisGrounding.ts`
- Verify only: `lib/proactiveAnalysisGrounding.test.ts`
- Verify only: `lib/proactiveAnalysisGeneration.ts`
- Verify only: `lib/proactiveAnalysisGeneration.test.ts`
- Verify only: `docs/superpowers/specs/2026-07-17-haiku-analysis-evidence-prompt-design.md`
- Verify only: `docs/superpowers/plans/2026-07-17-haiku-analysis-evidence-prompt.md`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: verified feature branch and pull request against `main`; no merge.

- [ ] **Step 1: Run the full verification suite**

Run each command separately and require exit code zero:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build:worker
npm run build
git diff --check origin/main...HEAD
```

Expected: all tests pass with only the existing opt-in live test skipped; TypeScript, ESLint, worker bundle, Next production build, and whitespace check all succeed.

- [ ] **Step 2: Audit scope and protected paths**

Run:

```bash
git status --short
git diff --name-only origin/main...HEAD
git diff --exit-code origin/main...HEAD -- db/schema.ts db/migrations package.json package-lock.json .github/workflows fly.toml scripts/proactive-health-worker.ts lib/proactiveHealthWorker.ts
git grep -n "DEFAULT_PROACTIVE_ANALYSIS_MODEL" HEAD -- lib/proactiveAnalysisGeneration.ts
```

Expected: the branch diff contains only the approved design/plan and four proactive-analysis implementation/test files; protected runtime, schema, migration, dependency, workflow, worker, and Fly files are unchanged; the default model remains `claude-haiku-4-5`. Ignore the pre-existing untracked `docs/superpowers/plans/2026-07-11-accurate-meal-logging.md` and do not stage or modify it.

- [ ] **Step 3: Push the feature branch and open the pull request**

```bash
git push -u origin feat/fix-haiku-analysis-prompt
gh pr create --base main --head feat/fix-haiku-analysis-prompt --title "fix: harden Haiku workout analysis grounding" --body $'## Summary\n- clarify that proactive evidence tokens are verified recorded measurements\n- require real session-input evidence before an analysis can become ready\n- reject placeholder-style meta-responses and cover the production regression\n\n## Verification\n- focused and full Node test suites\n- TypeScript and ESLint\n- worker bundle and production build\n- protected-path and model-default audits'
```

Expected: branch push succeeds and GitHub returns a pull-request URL. Stop without merging; the user reviews and merges the PR.
