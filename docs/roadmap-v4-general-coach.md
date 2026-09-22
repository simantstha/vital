# Vital v4 roadmap — from marathon app to a general AI fitness coach

**Status: APPROVED direction — Phase 0 in progress.** Owner decisions (2026-09-22):
D1 PR CI + screenshot branch · D2 orchestrator merges its own PRs once CI +
screenshot review are green · D3 voice pain = hands-free conversation, wait after
speaking, mic reachability (2.1, 2.3, 3.1 are the voice priorities) · D4 one coach
voice, specialists invisible behind it · D5 still open (ask with screenshots).
Date: 2026-09-22 · Author: orchestrating Claude session (planning only — no code changed)

Direction from the owner: Vital is no longer a marathon app. It is a general
fitness coach — fat loss, muscle gain, maintenance, endurance — that knows the
user deeply, talks to them proactively, and helps them improve day in, day out.
One head coach orchestrates a nutritionist and a trainer. It must feel swift
and effortless (inspiration: Cal AI's one-tap logging, MyFitnessPal's diary,
Whoop's readiness home).

This plan comes from three parallel read-only reviews (product/new-customer,
trainer + dietitian, senior iOS interaction engineer). The orchestrator
spot-checked the load-bearing claims in code; one reviewer claim (tiles
rendering `HRV 0`) was stale and is excluded — fixed by PR #143.

Per `AI_COMMON.md`: the orchestrator writes specs and reviews; code edits are
delegated (tier noted per item). Update checkboxes and the Status line as you go.

---

## 1. Diagnosis — why the owner doesn't use his own app

The 2026-08-31 audit's P0s (empty brief, fabricated zeros, raw errors,
HealthKit dead end) are **fixed**. What's left is not reliability, it's fit:

1. **The product still thinks every user is a runner.** The daily-brief prompt
   is built from `Weekly Distance` / `Last Run` / `run|gym|walk`
   (`lib/claude.ts:20-37,274-294`, `lib/brain/brief.ts:391-479`); the coach's
   starter chip is "Plan tomorrow's run" (`CoachView.swift:432`); the specialist
   decline button says "Stay with Running Coach" even for the nutritionist
   (`CoachView.swift:307,919`).
2. **The goal the user picks at onboarding is thrown away.** `app/api/onboarding/route.ts:144`
   writes it only into the free-text profile; `users.goal` is never set, so the
   diet budget treats a "Lose fat" user as `general` (maintenance calories).
   *Confirmed bug.* Also two vocabularies: onboarding `lose_fat|build_muscle|improve_endurance|general_health`
   vs. budget `weight_loss|muscle|endurance|general` (`lib/brain/dietBudget.ts:31`).
3. **The two core loops of a non-runner can't be completed.**
   - Weigh-in: `/api/weight-log` exists, zero iOS callers, no coach tool.
   - Strength training: no sets/reps/load anywhere in the schema; the strength
     specialist's own prompt admits it is blind (`lib/specialists/registry.ts:134-138`).
     The coach has 16 tools (`lib/brain/tools.ts`) — `log_meal`, but no
     `log_weight`, no `log_workout`.
4. **Voice feels like work because it *is* serial.** Tap → speak → wait 1.8 s
   silence → upload the whole clip to `/api/stt` and **await** it
   (`CoachViewModel.swift:415`) → only then does the coach start. No barge-in
   (can't interrupt the coach by talking), no continuous conversation, zero
   haptics in the voice loop, and two duplicate voice pipelines (Coach tab +
   Today FAB, `VoiceFABView.swift:17-22`).
5. **The coach can't be proactive about anything but recovery.** The insight
   engine's metrics (`lib/insights/detectors.ts:216-225`) have no weight, no
   workout volume, no strength — it can never say "your deficit slipped 4 days
   running" or "your bench hasn't moved in 3 weeks".
6. **Safety gap (must fix before coaching weight loss).** The only escalation
   rule (`TRUSTED_SPECIALIST_SAFETY`, `lib/brain/coach.ts:87`) is wired into the
   *disabled* specialist prompts. The live coach has no guidance on disordered
   eating, self-harm, or injury/medical red flags.
7. **Nothing verifies iOS before it ships.** No `pull_request` workflow exists;
   Swift is first compiled in the release job *after* merge to `main`, which
   uploads straight to TestFlight, and no iOS test ever runs in CI
   (`.github/workflows/release.yml`). The last commit on `main` is literally
   labelled `[NOT BUILT]`.

---

## 2. Product principles (the bar every change is judged against)

1. **Every daily action ≤ 2 taps, or zero with voice.** Log a meal, a weigh-in,
   a workout, ask the coach.
2. **Anything you can tap, you can say.** Every logging surface has a coach tool
   behind it, so "I had eggs and toast" / "182 this morning" / "3×5 squat at 225"
   just works.
3. **One coach, many specialists behind it.** The user talks to Vital; the
   nutritionist and trainer are expertise Vital consults, not a phone tree.
4. **Goal-shaped, not runner-shaped.** Today's hero, the brief, nudges, and
   targets all derive from the user's goal.
5. **Never show a number you don't have** (carried from the audit).
6. **Motion confirms, never decorates.** Every committed action gets a
   transition + haptic; respect Reduce Motion (already well plumbed in `Theme`).
7. **Nothing ships unbuilt.** Every iOS PR is compiled, tested, and screenshotted
   in CI before merge.

---

## 3. Phases

Sizing: S ≈ ½ day, M ≈ 1–2 days, L ≈ 3–5 days (agent time, incl. review).

### Phase 0 — Foundations (blocks everything) 

- [ ] **0.1 iOS PR CI** · Sonnet · M — new `.github/workflows/pr-ios.yml`:
      `pull_request`, path-filtered to `ios/**`, `macos-latest`, `xcodegen generate`,
      `xcodebuild build test -scheme Vital` on an iPhone simulator. Backend PR job
      too (`npm test`, `tsc`, `lint`) since those also only run post-merge today.
- [ ] **0.2 Screenshot harness** · Sonnet · M — add a `VitalUITests` target
      (`bundle.ui-testing` in `ios/Vital/project.yml`) that launches the app in a
      fixture mode (stubbed `APIClient`, seeded data per goal type) and captures
      each key screen (light + dark). CI pushes PNGs to a `ci-screenshots/pr-<n>`
      branch so a cloud Claude session can `git fetch` and visually review them.
      *This is how "test before push" works without a local simulator.*
- [ ] **0.3 Base-coach safety block** · Sonnet · S — add escalation rules to the
      live persona (`lib/brain/persona.ts`): disordered-eating language, self-harm,
      chest pain / injury red flags, "see a clinician" triggers; never push
      calories below the existing LEA floor. Add cases to the prompt evals
      (`docs/prompt-evals.md`).
- [ ] **0.4 Goal plumbing fix** · Sonnet · S — onboarding writes `users.goal`
      using one canonical enum; map old onboarding IDs; additive migration to
      backfill existing users from `core_profile_md` "- Primary:" line
      (per `AI_COMMON.md` migration rules — generate, never `push`).

### Phase 1 — Goal-general coaching core

- [ ] **1.1 De-marathon the copy** · Haiku · S — starter chips by goal, generic
      specialist return copy, onboarding copy audit.
- [ ] **1.2 Weigh-in loop** · Sonnet · M — `log_weight` coach tool; 1-tap weigh-in
      on Today (pre-filled with last value, stepper, haptic confirm); weight trend
      (smoothed, like Happy Scale / MacroFactor) on Today for weight-goal users.
- [ ] **1.3 Workout logging** · Sonnet · L — new `workout_sets` table (exercise,
      sets, reps, load, RPE; additive migration); `log_workout` tool so it can be
      logged by voice; minimal iOS logger with "repeat last session" (1 tap) as
      the default path; HealthKit workouts still auto-import.
- [ ] **1.4 Goal-shaped daily brief** · Sonnet · M — replace running-only brief
      inputs with a goal-keyed context: deficit/surplus adherence + weight trend
      (fat loss), training volume + protein (muscle), activity consistency
      (maintenance), mileage/load (endurance, any sport, not just runs).
- [ ] **1.5 Goal-shaped Today hero** · Sonnet · M — fat loss: calories left +
      weight trend; muscle: today's session + protein; endurance: readiness +
      today's session; maintenance: consistency ring. Recovery tiles stay, demoted.

### Phase 2 — Voice & feel (make it effortless)

- [ ] **2.1 Speculative voice send** · Sonnet · M — when silence ends a turn, send
      the on-device transcript immediately; use cloud STT only as a correction
      when it differs materially. Removes the blocking round trip (cheapest big
      latency win; do this *before* considering streaming STT, and measure).
- [ ] **2.2 One shared voice controller** · Sonnet · M — extract a
      `CoachVoiceController` used by both the Coach tab and the Today FAB
      (kills the duplicate pipeline, makes voice unit-testable).
- [ ] **2.3 Conversation mode + barge-in** · Sonnet · M — tap once, talk back and
      forth; mic re-arms after the coach finishes speaking; speaking over the
      coach stops TTS and listens; tap the orb to end. Clear visual state
      (listening / thinking / speaking) with haptics at each transition.
- [ ] **2.4 Haptics + motion pass** · Haiku · S — `Theme.Haptics` on send, mic
      start/stop, reply complete, log confirm; animate plan-item status changes
      (`TodayViewModel.setStatus`, `PlanTimelineView`).
- [ ] **2.5 Streaming smoothness** · Sonnet · S — memoize `MarkdownText` parsing
      (re-parsed every 16 ms tick today); replace blanket `objectWillChange`
      forwarding from transcriber/speaker (`CoachViewModel.swift:349-355`).
- [ ] **2.6 (conditional) Streaming STT** · Sonnet · L — only if 2.1 measurements
      still show perceptible lag.

### Phase 3 — Information architecture (needs owner sign-off + screenshots)

- [ ] **3.1** Today · History (Trends + Logs merged, MFP-style diary + charts) ·
      Profile, **native `TabView`** (the custom pill bar was reverted 2026-07-13 for
      covering the composer — don't repeat that), with the coach reachable from
      every screen as a persistent voice/chat entry instead of a peer tab.
      Prototype in the screenshot harness first; ship only after owner review.

### Phase 4 — A proactive coach for every goal

- [ ] **4.1** Extend insight metrics with weight trend, workout volume/frequency,
      protein adherence (`lib/insights/detectors.ts`).
- [ ] **4.2** Goal-specific triggers: weight plateau / off-pace, stalled lifts,
      low-protein streak, inactivity streak, missed key session.
- [ ] **4.3** Adaptive TDEE: reconcile intake vs. smoothed weight trend weekly and
      propose target changes through the coach (needs 1.2 data for ~2–3 weeks).

### Phase 5 — The coaching team

- [ ] **5.1** Enable specialists for the owner only (per-user flag; set
      `SPECIALIST_MODEL` with it — the flag alone crashes the coach, see audit).
      Use them for a week; write down what's good and bad.
- [ ] **5.2** Shared case file: one per-user plan object (targets, current
      program, constraints) both specialists read/write, so nutrition and
      training advice can't contradict each other.
- [ ] **5.3** Handoff UX redesign per decision D4 below.

### Deferred (tracked, not now)
Account deletion + privacy policy (hard App Store blocker, audit #14) — schedule
before any public release. Dynamic Type across the app. Offline mode. Splitting
`APIClient.swift` (1857 lines).

---

## 4. Verification protocol (every PR)

1. Backend: `npm test`, `npx tsc --noEmit`, `npm run lint` — locally *and* in PR CI.
2. iOS: PR CI build + unit tests green; screenshot branch reviewed by the
   orchestrator against the fixture scenarios (per goal type, light + dark,
   empty / loading / error / loaded).
3. Coach/prompt changes: prompt evals run against the real model.
4. Orchestrator re-reads the diff adversarially before requesting merge.
5. Anything not verifiable in CI (real voice audio, HealthKit on device,
   push delivery) is called out explicitly in the PR for owner TestFlight check.

---

## 5. What I'm deliberately *not* recommending

- **Building more specialist personas.** Three exist and none has ever been
  used by a person. Evaluate first (5.1).
- **A new visual redesign.** v3 is recent and decent; the problem is flow and
  fit, not paint.
- **Streaming STT first.** It's the "impressive" fix; speculative send (2.1) is
  probably 80% of the win for 20% of the work. Measure, then decide.

---

## 6. Open decisions for the owner

- **D1 — Testing:** PR CI + screenshot branch (works from cloud sessions), or
  interactive sessions on your Mac with the iOS simulator MCP, or both?
- **D2 — Merging:** you merge each PR, or the orchestrator merges its own PRs
  once CI + screenshots pass? (Each merge = a TestFlight build.)
- **D3 — Voice:** which hurts most — wanting hands-free back-and-forth, the
  wait after speaking, being cut off mid-thought, or reaching the mic at all?
- **D4 — Specialists visible or invisible?** Today a handoff is a card you must
  accept, and then you're talking to "the Nutritionist". Recommendation: keep
  one voice (Vital) and show specialist input as a subtle "checked with your
  nutritionist" attribution — accepting a handoff card is exactly the kind of
  friction you're trying to remove.
- **D5 — Tabs:** OK to prototype the 3-tab + ambient-coach layout (Phase 3)?
