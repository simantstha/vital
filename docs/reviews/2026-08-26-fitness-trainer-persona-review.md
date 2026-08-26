# Expert Persona Review — Seasoned Fitness Trainer & Sports Nutritionist

**Date:** 2026-08-26
**Persona:** "Coach Dana" — 20+ years coaching. CSCS strength coach, marathon coach, sports nutritionist (RD-level). Evaluates against established practice: Mifflin-St Jeor with real client inputs, evidence-based protein dosing (1.6–2.2 g/kg), sane deficit sizing, HRV-guided readiness, sleep hygiene, injury screening, and scope-of-practice safety norms.
**Method:** Grounded walkthrough of the shipped implementation — every screen, prompt, formula, and default cited below was located and read in source. No speculation; every P0/P1 finding carries a `file:line` reference verified during this review.

---

## Executive summary

Vital's *coaching philosophy* is genuinely better than most commercial fitness apps I've evaluated: observation over prescription, hard safety constraints that shadow everything else, a refusal to fabricate data, and math done in code rather than by the LLM. That architecture is the work of people who understood what goes wrong in AI coaching.

The problem is that **the nutrition engine's foundation is wrong for most of the user base**. The app runs a careful intake — sex, height, date of birth — and then throws those answers away: every user's calorie budget is computed as if they were a 175 cm, 30-year-old male. For the users most likely to install a fat-loss app (smaller, older, female), the error is large enough to erase their entire prescribed deficit. As a coach, this is the first thing I would refuse to sign off on: the app's single most-load-bearing number is wrong, precisely for the people relying on it most.

The second structural gap: **the feedback loops a real coach lives by are missing.** There is no way to log a weigh-in (despite a weekly reminder telling users to step on the scale), no manual workout logging, and no mechanism that adapts the calorie budget to observed weight change. The app prescribes but never re-calibrates — coaching without the follow-up appointment.

### Top 5 fixes

| # | Fix | Where |
|---|-----|-------|
| 1 | Use the user's real sex/height/age in Mifflin-St Jeor | `lib/brain/tools.ts:430-433` |
| 2 | Close the weigh-in loop: weight-logging UI + budget adaptation from weight trend | iOS (no UI exists; `/api/weight-log` is live) |
| 3 | Scale the activity multiplier off the training frequency collected at onboarding | `lib/brain/tools.ts:433` |
| 4 | Add manual workout logging (strength work especially) | iOS Logs/Today |
| 5 | Raise the calorie floor with a safety intervention, not just a clamp (800 kcal is presentable today) | `lib/brain/dietBudget.ts` |

---

## What works well

Credit where due — these are decisions a domain expert would defend in front of a review board:

- **Safety constraint architecture.** Hard constraints (allergies, conditions, injuries, medications) are injected *last* into the coach prompt so they shadow everything (`lib/brain/persona.ts`), the daily brief carries a hard "meals MUST NOT contain restricted foods" rule (`lib/claude.ts:265-309`), the trainer lens says "if an Injury node exists, never recommend loading that pattern," and unconfirmed facts are annotated "(unconfirmed — exercise caution)." Facts are confirmation-gated (`pending_facts`) and retracted rather than deleted. This is a real informed-consent posture.
- **Calibration gating.** No readiness verdicts, recovery scores, or intensity prescriptions until each metric has 14 days of baseline (`lib/brain/baselines.ts`, `ESTABLISHED_MIN_DAYS = 14`; calibrating lens in `persona.ts`). Most apps fabricate a "recovery score" on day one. Vital waits. Correct.
- **No-fabrication data discipline.** The recovery score never imputes a missing component (`lib/brain/recovery.ts:134-137` — "never imputed with a default value"), and the file header documents four defects of the previous formula it replaced, including "manufacturing a ~97% recovery day out of nothing." The Trends verdict engine returns "no data yet" rather than inventing direction. The brief prompt: "do NOT invent a value."
- **Math in code, not in the model.** `calculate_macros`, `estimateTDEE`, baselines, and the recovery score are all deterministic; the LLM is told "never compute from memory." This eliminates the single biggest failure mode of LLM nutrition coaching (confidently wrong arithmetic).
- **Sound micro-decisions that show domain literacy:**
  - WHOOP `whoop_sleep_min` is treated as *in-bed* time and asleep minutes derived from awake time (`lib/brain/recovery.ts` HRV/sleep source handling) — most integrations get this wrong.
  - Protein "g/kg" is protected from imperial unit conversion because it's a dosing ratio, not a display unit (`lib/brain/persona.ts:162`).
  - Body-weight trend polarity is deliberately **neutral** (not "lower is better") — the right call for eating-disorder sensitivity.
  - No oversleep credit in the sleep-duration curve; sleep *duration* and *efficiency* scored separately.
  - HRV traffic light (green ≥ baseline / amber 85–99% / red < 85%, `persona.ts:79-81`) matches how practitioners actually use HRV.
  - Pre/post-workout nutrient timing in the nutritionist lens (carbs 60–90 min pre for >60 min sessions; protein within 30 min post) is textbook sports nutrition.
- **The macro split table is defensible** (`lib/brain/dietBudget.ts:58-91`): 2.2 g/kg protein on a cut, 2.0 g/kg for muscle gain, 1.6 g/kg endurance, fat 22–27% — all inside evidence-based ranges. I'd sign off on this table as-is.
- **Multi-modal food logging** (text search, photo, barcode, voice, chat) with editable portions and a "search by name instead" fallback on barcode misses lowers the logging friction that kills most nutrition clients' adherence.
- **Well-covered empty/error states**, optimistic UI with revert-on-failure, and a documented retry-vs-dismiss rule that prevents double-writing chat messages.

---

## Findings by journey

Severity scale: **P0** = wrong numbers or a safety issue; **P1** = core coaching loop broken or missing; **P2** = coaching-quality defect; **P3** = polish/consistency.

### 1. Onboarding & intake

The 7-step flow (`ios/Vital/Sources/Features/Onboarding/OnboardingFlowView.swift`, `OnboardingViewModel.swift`) collects name, DOB, sex, height, weight, goal + target date, training days/types/experience, injuries/conditions/medications, sleep schedule, stress, and diet notes, with HealthKit prefill. As an intake form, the *coverage* is close to what I'd run in a first client session. But:

- **P0 — The intake answers don't reach the math.** Sex, height, and age are collected, stored, and editable in Personal Details — and then ignored by the calorie engine (see §2). Collecting a client's stats and not using them is worse than not asking: it creates the impression of personalization that doesn't exist.
- **P1 — No activity-level / occupation question.** Training days (0–7, default 3) are asked, but the TDEE multiplier never reads them (see §2). Nothing captures NEAT context (desk job vs. on-your-feet work) — the largest inter-individual TDEE variable after body size.
- **P2 — DOB defaults to exactly today − 25 years.** Users who skim will keep it, and nothing flags an unedited default. (Today this is masked by the age never being used; once fix #1 lands, a silent default DOB becomes a silent calorie error.)
- **P2 — The "Meet your coach" chat step has no completion criterion** — Continue is always enabled, so the one relationship-building step can be skipped in zero seconds. Gate it lightly (one exchange) or make skipping explicit.
- **P3 — Health & safety step is fully skippable free text.** Acceptable for scope, but a single structured prompt ("Any of these apply? heart condition / pregnancy / diabetes / recent surgery") would catch the red flags a PAR-Q catches, at minimal friction.

### 2. Nutrition engine — the core audit

**P0 — BMR is computed for a fictional user.** `lib/brain/tools.ts:430-433`:

```ts
// Mifflin-St Jeor for 175 cm, 30-year-old male (profile defaults)
const bmr = 10 * weightKg + 6.25 * 175 - 5 * 30 + 5;
let tdee = bmr * 1.3; // lightly-active base
```

Only weight varies. Worked example: a 60 kg, 160 cm, 55-year-old woman.

- Her real Mifflin-St Jeor BMR: 10·60 + 6.25·160 − 5·55 − 161 = **1,164 kcal**
- Vital's BMR for her: 10·60 + 6.25·175 − 5·30 + 5 = **1,549 kcal**
- After the 1.3 multiplier the TDEE error is **≈ +500 kcal/day**. Her "Lose fat" budget (TDEE − 400, `tools.ts:474`) lands *above* her true maintenance. She will follow the app faithfully and gain weight. The inverse case (tall young male) gets under-budgeted and unnecessarily hungry.

This is the highest-impact fix in the codebase, and the inputs already exist in the profile/memory layer. Everything downstream — the fuel strip, "N kcal left," the coach's meal plans, the brief — inherits this error.

**P1 — Activity multiplier is a constant 1.3** (`tools.ts:433`) regardless of the "How do you train?" answer. The structure (light-activity base + explicit workout calories added on top) is legitimate and avoids double-counting, but the base should move with training frequency and NEAT context (~1.2 sedentary desk → ~1.5 active job). Related, **P2**: the per-workout fallback burns are crude — strength at `durMin * 4` (240 kcal/h) is low for hard training, running `weightKg × km × 1.0` ignores pace entirely (`tools.ts:444-459`). Actual HealthKit calories are used when present, which mitigates this for Watch users.

**P1 — Fixed calorie adjustments don't scale with the person.** −400 kcal for weight loss (`tools.ts:474`) is ~15% of a small woman's true TDEE (aggressive) and ~11% of a large man's (fine). Percent-of-TDEE deficits (10–20%, goal-dependent) are the standard.

**P1 — No safety floor behavior.** `KCAL_MIN = 800` (`lib/brain/dietBudget.ts`) is a clamp, not a policy. A custom 800 kcal budget renders like any other target. A coach would refuse: below ~1,200 (women)/1,500 (men), the app should warn, require confirmation, and have the coach address it — this is also where RED-S/low-energy-availability risk lives for the endurance users this product courts.

**P2 — `DEFAULT_WEIGHT_KG = 75` fallback is silent.** With no weight on file, every g/kg-derived number is fiction; the UI should say "add your weight to get real targets," not present confident grams.

**P2 — Meal-slot and icon inference are English keyword + clock heuristics** (`TodayViewModel.swift:542-594`, duplicated in `MealDetailView.swift:529-537`; time-of-day slot guessing in the reminder logic). "Oat|egg → breakfast" fails for non-Western diets and shift workers; a chat-logged meal still triggers a redundant "log lunch" reminder (documented in-file). The slot should travel with the log.

**Fixed but doc is stale (P3):** `docs/problems/problem-01-diet-budget-daily-reset.md` still says the UTC-day reset bug is "Diagnosed, not fixed," but `users.timezone` + `lib/localDay.ts` now exist and every relevant route (`app/api/today/route.ts:125-127`, `app/api/meals/log/route.ts:216-230`, plan, profile, streak, brief) buckets on the user's local day. Update or archive the doc.

### 3. Training & recovery guidance

**What's right:** the recovery model (`lib/brain/recovery.ts`) — HRV 60 / sleep duration 30 / sleep efficiency 10 weighting, clamped sub-scores, present-components-only scoring, confidence downgraded to "provisional" without a full component set — is more honest than any consumer wearable score I've seen. The deterministic Coach Workspace ladder (`lib/coachWorkspace.ts:143-206`: calibration gate → confirmed-constraint gate → HRV ratio < 0.85 or resting-HR ratio ≥ 1.1 → rest; sleep ratio < 0.8 → wind-down; else 45 min easy) is conservative in exactly the way a good coach is conservative, with freshness and plausibility gates on its inputs.

- **P1 — There is no training progression engine.** The product's own spec targets the Twin Cities Marathon (Oct 4, 2026 — five weeks from this review), yet nothing builds toward a race: no plan generation, no weekly load progression, no long-run scheduling, no taper. The daily ladder can only ever say "rest," "sleep," or "45 min easy at 17:00." The Running Coach specialist exists (`lib/specialists/registry.ts`) but is flag-gated off (`SPECIALISTS_ENABLED`). For the marathon use case, this is the product's biggest functional hole.
- **P1 — No manual workout logging.** Workouts arrive only via HealthKit (`ios` Logs are read-only for workouts). A client who lifts without a Watch, does a spin class, or forgets their watch simply has training days that never happened — corrupting training load, TDEE workout add-ons, and streaks. The "Move" plan item is a titled row, not a log.
- **P2 — Readiness reads a single day's HRV ratio.** Day-to-day HRV coefficient of variation is commonly ~10%; one poor night can trip the < 0.85 rest gate. Compare a short rolling average (3–7 day) to baseline instead — the data is already in `baselines.stats`.
- **P2 — "45 min easy at 17:00" is the only training prescription shape.** No variation by experience level or training-type preferences collected at onboarding.

### 4. Sleep

- **P1 — Sleep goal options are only 7.5 / 8 / 8.5 h** (`SleepGoalView.swift:17`). Adult guidance is 7–9 h; a 7 h or 9 h sleeper can't set their true goal, which then skews the short-night threshold (75% of goal), the recovery score's duration factor, *and* the sleep ratio in the Coach Workspace ladder. Widen to at least 6.5–9.5 in half-hour steps.
- **P3 — Sensible pieces otherwise:** short-night threshold snapped to half hours with honest copy, the 22:30 lights-out default, and wind-down recommendations at 21:30 are all reasonable defaults.

### 5. Coach AI quality & safety

Mostly covered under "What works well" — the persona architecture (`lib/brain/persona.ts`), grounding guardrails ("never tell the user something was saved unless the tool ran"), scope-of-practice text, specialist prompt-injection defense (`## UNTRUSTED USER CONTEXT`, `lib/specialists/orchestration.ts:264`), and the no-restating-numbers contract for proactive analyses are excellent.

- **P2 — The nutritionist/trainer lens thresholds live only in prose prompts.** "Amber HRV 85–99%" in `persona.ts` and `hrvRatio < 0.85` in `coachWorkspace.ts` agree today, but nothing keeps them in sync; the deterministic engine and the LLM's stated policy will drift. Extract shared constants.
- **P2 — Diet-budget consent flow is prompt-enforced only.** "Propose the change, get explicit agreement, THEN call `update_diet_budget`" is the right rule, but there's no server-side check that an update was preceded by user confirmation. A tool-level confirmation token (like `pending_facts` already does for memory) would make the guarantee structural.
- **P3 — Two coaching voices, two number policies.** The chat coach is tool-first and number-fluent; the proactive analyses are forbidden from writing any numeral. Intentional, but the user experiences one coach — the brief saying "shorter than usual" while chat says "6 h 12 m" reads as evasive. Worth a copy pass, not a rearchitecture.

### 6. Trends & data presentation

Strong overall: ±1σ "your normal" bands gated behind 14 days, sparse states instead of fake sparklines, "WEEKLY AVERAGE" stamping on downsampled windows, multiplicative-only unit conversions (documented std-dev rationale, `lib/metricCatalog.ts`), WHOOP fenced in its own section with source chips.

- **P2 — Imperial users get metric leftovers.** Only body mass and distance convert; skin temperature stays °C for a US user (`MetricCatalog.swift` mapping). HRV in ms and sleep in hours are correct as-is; °C is not.
- **P3 — Verdict copy ("above normal · today") is well-judged** — no σ/z jargon. Keep it.

### 7. Engagement mechanics

- **P1 — The weigh-in loop is broken end-to-end.** Saturday reminder: "Weekly weigh-in day — step on the scale before breakfast" (`ReminderScheduler.swift:176`) — but there is no weight-logging screen, no `APIClient` method for the live `/api/weight-log` endpoint (verified: zero references in `ios/`), and no logic anywhere that adapts the calorie budget to observed weight trend. For a nutrition coach, the weekly weight trend *is* the steering wheel: it's how you detect that a budget is mis-set (which, per §2, it currently is). Ship the logging UI, then a fortnightly "trend vs. expected" budget adjustment.
- **P2 — Streaks measure chatting, not adherence.** Any user chat message qualifies a day (`lib/streak.ts:24-26`). "Hi" at 11:58 pm keeps a streak alive with zero health behavior. If the streak is meant to signal engagement, fine — but don't present it adjacent to health data as if it reflects consistency. Restrict to meal/workout/plan-done days, or rename it.
- **P2 — Local reminders die silently after ~7 days unopened** (`ReminderScheduler.swift` documented trade-off) — precisely when a lapsing client most needs the nudge. The APNs infrastructure already exists for analyses; move meal/weigh-in nudges server-side or top up on background delivery wakes.

### 8. Consistency & polish (P3 unless noted)

- **Goal vocabulary mismatch:** onboarding speaks `lose_fat / build_muscle / improve_endurance / general_health`; the diet system speaks `weight_loss / muscle / endurance / general` with different display labels ("Lose fat" vs "Lose weight"). Unify — clients notice when their goal is renamed between screens.
- **iOS legacy 30/40/30 fallback split** (`TodayViewModel.swift:406-408`) disagrees with the server's per-goal table; a user who hits that path sees different macro targets than the coach reasons over.
- **Oura/Garmin "Coming soon" stubs** in Devices; fine, but they've been static long enough to consider hiding.
- **Dead code/schema:** `pending_nudges` table has zero readers/writers; Phase-2 fallback block in `TodayViewModel.swift:529-650` self-describes as dead weight; `mealIcon(for:)` and a progress bar are copy-pasted in two files each.
- **Unshipped v1-scope features** from the architecture doc: lab PDF interpretation (`LabMarker` exists only as enum values), pantry/grocery tiering (`PantryItem` likewise). Either schedule or descope in the doc.
- **Today greeting is still name-free** ("Good morning") though Sign in with Apple ships and Profile knows the name — the in-code comment (`TodayViewModel.swift:791-792`) is stale.

---

## Prioritized backlog

| Pri | Finding | Evidence | Recommendation |
|-----|---------|----------|----------------|
| P0 | BMR hardcodes 175 cm / 30 y / male; real intake data unused | `lib/brain/tools.ts:430-433` | Thread sex/height/DOB from profile into Mifflin-St Jeor; recompute budgets on profile edit |
| P1 | Weigh-in loop broken: reminder exists, no logging UI, no budget adaptation | `ReminderScheduler.swift:176`; no `/api/weight-log` caller in `ios/` | Weight-log sheet + trend-vs-expected budget adjustment |
| P1 | Activity multiplier fixed at 1.3, ignores stated training frequency | `lib/brain/tools.ts:433` | Scale base multiplier from onboarding training days + a NEAT question |
| P1 | Fixed −400/+200/+100 kcal adjustments don't scale with body size | `lib/brain/tools.ts:472-484` | Percent-of-TDEE adjustments (e.g. −15% cut, +8% gain) |
| P1 | 800 kcal floor presentable without warning; no low-energy-availability guard | `lib/brain/dietBudget.ts` (`KCAL_MIN`) | Warn + confirm below ~1200/1500 kcal; surface to coach |
| P1 | No manual workout logging | iOS Logs/Today (HealthKit-only) | Minimal manual workout entry posting a `workout_completed` event |
| P1 | No training progression toward the product's own marathon target | `lib/coachWorkspace.ts:143-206`; `SPECIALISTS_ENABLED` off | Enable Running Coach specialist; add weekly-load progression |
| P1 | Sleep goal limited to 7.5/8/8.5 h | `SleepGoalView.swift:17` | 6.5–9.5 h in half-hour steps |
| P2 | Readiness gates on single-day HRV ratio (noise-sensitive) | `lib/coachWorkspace.ts:173` | Rolling 3–7 day HRV vs baseline |
| P2 | Streak qualifies on any chat message | `lib/streak.ts:24-26` | Restrict to logged behaviors, or relabel as engagement |
| P2 | Silent 75 kg default weight in macro math | `lib/brain/dietBudget.ts` (`DEFAULT_WEIGHT_KG`) | Prompt for weight instead of presenting confident targets |
| P2 | English-keyword meal-slot/icon heuristics; redundant reminders | `TodayViewModel.swift:542-594` | Carry slot on the log; suppress reminders on any logged meal |
| P2 | HRV thresholds duplicated in prompt prose and code | `persona.ts:79-81` vs `coachWorkspace.ts:173` | Shared constants module |
| P2 | Diet-budget consent enforced only by prompt | `persona.ts` discipline rules | Server-side confirmation token on `update_diet_budget` |
| P2 | Reminders stop after ~7 days unopened | `ReminderScheduler.swift` | Server-side nudges via existing APNs path |
| P2 | Skin temp shown in °C to imperial users | `MetricCatalog.swift` | Add °F conversion (multiplicative-only rule needs an offset exception or display-layer conversion) |
| P2 | Crude workout-kcal fallbacks (strength 4 kcal/min) | `lib/brain/tools.ts:444-459` | MET-based estimates using body weight |
| P3 | Goal vocabulary mismatch across app | onboarding vs `dietBudget.ts` labels | One canonical goal enum + labels |
| P3 | Stale problem-01 doc (UTC bug is fixed in code) | `docs/problems/problem-01-*` | Mark fixed/archive |
| P3 | iOS 30/40/30 fallback split diverges from server table | `TodayViewModel.swift:406-408` | Fetch or mirror the per-goal table |
| P3 | Dead `pending_nudges` table; duplicated helpers; stale comments | `db/schema.ts`; `TodayViewModel.swift` | Cleanup pass |
| P3 | DOB defaults to today − 25 y unflagged | `OnboardingViewModel.swift` | Require explicit DOB confirmation once age drives math |

---

## Closing note from the persona

If a junior coach brought me this app, I'd tell them: your instincts are excellent — you refuse to guess, you respect injuries and allergies, you wait for baselines, you don't let the AI do arithmetic. Those habits are hard to teach and you already have them. But you weighed your client, measured them, asked their age — and then wrote a meal plan for someone else. Fix the foundation number, give clients a scale and a logbook, and let the budget learn from the scale. Then this becomes one of the most trustworthy coaching products I've seen.
