# Simplify workout/sleep analysis notifications + fix analysis content

## Context

The proactive workout/sleep pushes currently use the LLM-generated analysis as the notification itself (`title = headline`, `body = shortInsight`, built in `lib/apnsClient.ts:26`), so users get a 200-char paragraph on their lock screen. Meanwhile the analysis content behind the tap is bloated and metric-free: the system prompt (`lib/proactiveAnalysisGeneration.ts:40`) tells the model to *"use the fewest evidence tokens needed… omit a token when qualitative language is sufficient"*, so real prod analyses contain zero actual workout numbers (a 2.5 km / 31 min / 182 kcal walk produced four filler observations), repeat the same profile fact up to 4×, and pad out 4 observations + 4 nextSteps every time.

Goal (user-confirmed, both parts):
- **A.** Push becomes a simple static line — *"Your running workout has been logged."* — and the user taps to open the analysis popup (deep link `vital://workout-analysis/{id}` already ships and works; Phase C).
- **B.** Rewrite the analysis prompt so the popup content leads with this session's actual metrics, cuts repetition, and is much shorter. Morning-brief pushes keep their current headline/shortInsight body (the notification *is* their content).

## Part A — Static notification (no LLM content in push)

Files: `lib/apnsClient.ts`, `scripts/proactive-health-worker.ts`, `lib/proactiveHealthWorkerSupport.ts` (+ their tests).

1. Change `ApnsClient.send` (`lib/apnsClient.ts:24-26`) to accept a plain alert instead of `CoachAnalysis`: `send(device, alert: { title: string; body: string }, route?)`. Payload line becomes `alert: { title: alert.title, body: alert.body }`.
2. Add a small pure helper in `lib/proactiveHealthWorkerSupport.ts`, e.g. `analysisAlert(kind: AnalysisKind, input: unknown): { title, body }`:
   - workout → title `"Workout logged"`, body `` `Your ${type} workout has been logged.` `` where `type` is `input.type` lower-cased (prod `input_payload.type` is `"Walking"`, `"Running"`, …; fall back to just `"Your workout has been logged."` when missing/non-string).
   - sleep → title `"Sleep logged"`, body `"Last night's sleep has been logged."`
3. Update the three call sites in `scripts/proactive-health-worker.ts`:
   - Lines 44 and 52 (fresh + requeued workout/sleep notifications): closure ignores the LLM `result` and calls `apns.send(device, analysisAlert(job.kind, job.input), route)` — `job.input` is available in both closures.
   - Line 69 (morning brief): keep content-bearing push by mapping `value` → `{ title: value.headline, body: value.shortInsight }`.
   - The `push` callback type threaded through `lib/proactiveHealthWorker.ts` (`(device, analysis: CoachAnalysis) => …`) stays unchanged — the closures adapt at the edge, so `runClaimedAnalysis`/`deliverNotification` don't change.
4. Update `lib/apnsClient.test.ts` and any worker tests asserting the alert payload.

## Part B — Analysis prompt rewrite (metric-led, short)

File: `lib/proactiveAnalysisGeneration.ts` (both `PROACTIVE_ANALYSIS_SYSTEM_PROMPT` and `PROACTIVE_ANALYSIS_REPAIR_PROMPT` share the same fragments — edit the shared constants).

1. **Replace the token-avoidance sentence** in `TOKEN_CONTRACT` (`"Use the fewest evidence tokens needed to answer the request, and omit a token when qualitative language is sufficient."`) with guidance to **cite the session's key metrics**: for a workout — duration, distance, pace, and average heart rate when supplied; for sleep — duration and efficiency. Keep every placement rule after it verbatim (they back the grounding validator in `proactiveAnalysisGrounding.ts` — clause-terminal tokens, no reuse, no raw numbers).
2. **Add a content contract** (new sentence block in the system prompt):
   - headline: names the workout type or sleep, a few words.
   - shortInsight: one sentence containing the single most notable metric.
   - narrative: at most three sentences, about this session only.
   - observations: two or three items, each anchored to a supplied metric.
   - nextSteps: one or two items.
   - Never repeat the same fact or profile detail in more than one field; mention profile/goal context only when it changes what the user should do next.
3. **Gotcha:** `guardedRequest` runs `assertNoRawNumbers` on the *system prompt* (`proactiveAnalysisGeneration.ts:58`), so the new prompt text must contain no digits — write "two or three", never "2-3".
4. Leave `proactiveAnalysisSchema.ts` caps as-is (they're validation ceilings; lowering them risks schema_failure → repair churn). Brevity comes from the prompt.
5. Update `proactiveAnalysisGeneration.test.ts` / grounding tests if they assert prompt text.

## Part C — Switch analysis model to Haiku (user-confirmed)

File: `lib/proactiveAnalysisGeneration.ts:14`.

1. Change `DEFAULT_PROACTIVE_ANALYSIS_MODEL` from `'claude-sonnet-4-6'` to `'claude-haiku-4-5'`. The task (small input, fixed 5-field JSON, observational tone) is Haiku-tier; 3× cheaper ($1/$5 vs $3/$15 per MTok) and faster.
2. The `PROACTIVE_ANALYSIS_MODEL` env var already overrides the default — instant prod rollback to Sonnet via `fly secrets set` if Haiku trips the grounding validator too often. Confirm the var isn't already set on Fly (it would silently shadow the new default).
3. Risk watch: the strict evidence-token placement contract is the one place Haiku could regress. Safety nets already exist — one repair retry per generation, job-level retries with backoff, and `proactive_analysis_failure` telemetry events. After deploy, check worker logs for a spike in `grounding_failure`/`repair_exhausted`.

## Execution

- Per the orchestration rule, delegate the edits to a **Sonnet subagent** (≈5 files + tests, includes prompt engineering); I review the diff.
- New branch off `main` (currently on `feat/ios-calendar-sync`): `feat/simple-analysis-notifications`. Conventional commit, push, `gh pr create` against main, stop for user review. No schema/migration changes involved.

## Verification

1. `npm test` (vitest suite — apnsClient, proactiveHealthWorker, proactiveAnalysisGeneration/grounding tests) and `npx tsc --noEmit`.
2. Unit assertions to add: APNs payload for a workout job equals `{title: "Workout logged", body: "Your walking workout has been logged."}` given `input.type = "Walking"`; morning brief payload still carries headline/shortInsight; system prompt contains no `\p{N}` (guarded already by `assertNoRawNumbers` in existing tests/path).
3. Prompt-quality spot check: run one generation against the real prod input payload sampled above (2.5 km walk) via a small scratchpad script hitting `generateGroundedAnalysis` with the Anthropic key from the dev env, and confirm the output cites distance/duration/pace and stays within the new counts. (If no key locally, rely on tests + review, and verify on the next TestFlight build.)
