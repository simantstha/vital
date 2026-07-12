# Vital app redesign — "Today Screen v3" implementation plan

**Status: Phases 0–3 done** · Branch: `feat/redesign-v3` (off `main`)
Source of truth for the design: Claude Design project
<https://claude.ai/design/p/67904bc9-0509-4bb9-b4bf-2219bc3478fb?file=Today+Screen+v3.html>
(file `Today Screen v3.html` — a full 5-tab React/Tailwind mock of the app).

This doc is written so anyone (Suman, Simant, or a Claude session) can pick up
any unclaimed phase. **Update the checkboxes and the Status line as you go.**
Per `CLAUDE.md`/`AI_COMMON.md`: orchestrating model delegates code edits to
Haiku/Sonnet subagents; suggested tier is noted per phase.

---

## 1. What the redesign is

The v3 mock keeps the existing 5 tabs (Today / Coach / Trends / Logs / Profile)
but changes two big things:

1. **Visual system** — a warmer, flatter light UI: soft off-white page
   (`#F4F4F6`), near-white cards (`#FDFDFD`) with a single hairline shadow
   (no glass borders), bright lime accent (`#B7E249`), pale-lime fills
   (`#EDF6D6`) with olive text (`#55650F`), very round corners (24px cards,
   full-pill buttons), and a **custom floating pill tab bar** instead of the
   native `TabView` bar.

2. **Today becomes a plan-first screen.** The hero of Today is a **daily plan
   timeline** (meals + movement + sleep + calendar events, each with a time
   and a status: done / now / next / later / skipped) that the user can act
   on (log, complete, skip, remove, add items). Diet budget shrinks to a
   compact "fuel strip" that opens a full **diet logging sheet**. A **voice
   FAB** lets the user talk to the coach straight from Today (edge-glow
   listening state, live caption, transcript lands in the Coach thread).

### Screen-by-screen deltas (mock → current code)

| Screen | Current code | What changes |
|---|---|---|
| Today | `ios/Vital/Sources/Features/Today/TodayView.swift` — greeting, calibration card, chips, coach bubble, 3 metric tiles, big diet-budget card, meal list, "Log it" button | Reorder to: header (date over greeting, streak chip + one-line hint) → **plan timeline** (new) → coach message → vitals row → **fuel strip** (new, compact). Big diet card and "Log it" button move into the diet sheet. Calibration card stays (mock shows it on first-run states). Pending-facts banner stays (not in mock; keep, restyled). Voice FAB (new). |
| Coach | `Features/Coach/CoachView.swift` | Restyle only: limeSoft coach bubbles w/ lime avatar circle, white user bubbles, suggestion chips, pill composer with mic + lime send button. Keep existing streaming/TTS logic untouched. |
| Trends | `Features/Trends/TrendsView.swift` | Restyle + new chart idioms: calibrating info banner; sleep = 7-day bar chart (gray bars for short nights, dashed outline for missing days); HRV & resting HR = line-with-dots (dashed hollow dots for missing days); footnote copy under each card. |
| Logs | `Features/Logs/LogsView.swift` | New layout: day pager (‹ Today › with per-day summary line), per-day **diet budget card** (read-only for past days, tappable today), entries list, dashed "Add to today's log" button. |
| Profile | `Features/Profile/ProfileView.swift` (+ detail work from PR #44) | Mostly restyle to new card idiom. New in mock: "Coach recommends" card on the Goal detail (with "Use this goal"), "What this means" per-goal facts, Devices screen (Apple Watch connected + connect stubs), calibration % banner. Keep existing ViewModels. |

---

## 2. Design tokens (mock → `Theme.swift`)

Mock is light-only. **Decision: keep Vital's adaptive light/dark `Theme`
structure** — apply v3 values as the light palette, keep the existing dark
values (dark canvas `#0B0F14`, lime `#C7F23B`) as the dark counterparts.
`Theme.Colors.accentContent` (olive-on-light / lime-on-dark) already encodes
the mock's `limeText` idea — extend, don't replace.

| Mock token | Value | Theme.swift target |
|---|---|---|
| `--color-page` | `#F4F4F6` | `Colors.canvas` (light) — near-identical already, adjust |
| `--color-card` | `#FDFDFD` | **new** `Colors.card` (light `#FDFDFD` / dark ≈ `#151A21`) |
| card shadow | `0 1px 2px rgba(0,0,0,0.04)` | **new** `Colors.cardShadow` + a `VitalCard` component (replaces `GlassCard` borders in light) |
| `--color-lime` | `#B7E249` | `Colors.accent` (light) — keep dark `#C7F23B` |
| `--color-limeSoft` | `#EDF6D6` | **new** `Colors.accentSoft` (light `#EDF6D6` / dark ≈ lime 15%) |
| `--color-limeText` | `#55650F` | `Colors.accentContent` (light) — currently `#3F6212`, retune |
| `--color-txt` / `txt2` / `txt3` | `#17181A` / `#75767A` / `#A6A7AB` | `textPrimary`, `textSecondary` (light), **new** `textTertiary` |
| `--color-up` / `--color-down` | `#6DA33C` / `#D9483B` | **new** `Colors.positive`; `Colors.alert` (light) retune to `#D9483B` |
| radii | cards `rounded-3xl` (24), icon badges `rounded-2xl` (16), sheets `2.2rem` (~35), pills | `Radius`: add `xl=24` usage for cards, `sheet=35`; pills exist |
| type | SF Pro, tabular nums, bold 30–34 titles, 13–15 body | `Typography`: add `screenTitle` (34 bold tight), keep the rest |

---

## 3. Phases

Rules for every phase:
- One PR per phase (small phases may share). Base each PR on the previous
  phase's branch if not yet merged, otherwise on `main`. The user merges PRs.
- Verify before PR: backend `npm run lint` + `npx tsc --noEmit` + `npm run build`
  (use Node 20: `export PATH="/opt/homebrew/opt/node@20/bin:$PATH"`; set
  `VITAL_DATA_DIR` outside the repo for `dev`); iOS
  `cd ios/Vital && xcodegen generate` then build + test the `Vital` scheme in
  an iPhone simulator.
- No hardcoded hex in views — everything goes through `Theme`.

### Phase 0 — Design tokens + shared primitives ⬅ BLOCKS EVERYTHING
**Owner: DONE (2026-07-12, Sonnet subagent) · iOS only**

- [x] `Theme.swift`: token changes from §2 (`card`, `cardShadow`, `accentSoft`,
      `textTertiary`, `positive`, light-value retunes, `Radius.sheet`,
      `Typography.screenTitle`).
- [x] New `DesignSystem/VitalCard.swift`: white rounded-24 card w/ soft shadow
      (replaces `GlassCard` usage as call sites migrate; do NOT delete
      `GlassCard` yet).
- [x] New `DesignSystem/IconBadge.swift`: 40pt rounded-16 icon square
      (limeSoft / lime / neutral variants — used by plan rows, logs, sheets).
- [x] New `DesignSystem/VitalSheet.swift`: bottom-sheet scaffold — rounded-top
      ~35, grab handle, page background (used by add-item, item-actions, diet
      sheets).
- [x] New `DesignSystem/Toast.swift`: top-center dark pill toast ("Logged —
      nice work"), auto-dismiss ~2.4s, + a view-modifier host.
- [x] `App/RootTabView.swift`: custom floating pill tab bar (5 items, active =
      limeSoft capsule + olive icon/label) using the mock's icon set — Today
      `sun.max`, Coach `message`, Trends `chart.xyaxis.line`, Logs
      `list.clipboard`, Profile `person`. Hide the native tab bar; keep the
      same 5 root views; content must scroll under the bar (bottom padding).
- [x] Existing components restyle pass: `Chip` (limeSoft pill w/ olive text),
      `CoachBubble` (limeSoft rounded-24, lime avatar circle w/ dark icon),
      `MetricTile` (VitalCard style, colored delta with ↗/↘), `SectionHeader`
      (uppercase 13pt tracked label per mock).
- [x] Acceptance: app builds; all 5 tabs render with new tab bar; no visual
      regressions that block reading data; dark mode still legible.

### Phase 1 — Today screen restructure (UI, client-side state)
**Owner: DONE (2026-07-12, Sonnet subagent) · iOS only**

- [x] New `Features/Today/PlanTimelineView.swift` + `PlanItem` model
      (id, time, title, subtitle, icon, status ∈ done/now/next/later/skipped,
      source ∈ coach/user/calendar, optional `action` label).
      Card contains rows: icon badge (lime when `now`, limeSoft otherwise,
      neutral for calendar), title + status word (uppercase 11pt, colored),
      subtitle, right side = Log button (when actionable now) or time; `done`
      rows at 60% opacity with a check, `skipped` struck through.
      Header row: "Today's plan" + "✦ Built for you" + lime ⊕ button.
      Footer caption: "Synced with your calendar · tap any item…".
- [x] New `Features/Today/PlanItemActionsSheet.swift` (VitalSheet): mark done /
      skip today / mark not done / remove — mutates local VM state.
- [x] New `Features/Today/AddPlanItemSheet.swift` (VitalSheet): type picker
      (Meal/Move/Rest/Other), title field, time picker + quick-time pills,
      Cancel/Add.
- [x] `TodayView.swift` reorder per §1 table; header gets date-above-greeting
      and streak chip + hint line; big diet card → new compact
      `FuelStripView` ("N kcal left · Protein x/yg · tap to log a meal")
      which opens the existing `LogMealView` for now (Phase 3 replaces it).
- [x] `TodayViewModel.swift`: derive an initial `[PlanItem]` from the existing
      `/api/today` `plan` (meals get times heuristically: breakfast 8:00,
      lunch 12:45, dinner 19:30) + a "Lights out" row from the sleep goal.
      Status computed from current time (done/now/next/later). Local-only
      mutations this phase; **persistence is Phase 2 — expect statuses to
      reset on relaunch, that's OK here.**
- [x] "Logged" toast on plan-item log; keep pending-facts + calibration cards.
- [x] Acceptance: Today matches mock ordering & interactions with live API
      data; add/complete/skip/remove all work in-session; build + tests green.

### Phase 2 — Plan persistence (backend + wiring)
**Owner: DONE (2026-07-12, Sonnet subagent) · full-stack**

- [x] New table `plan_items` in `db/schema.ts` (drizzle): id, userId, localDay
      (text key, same convention as `lib/localDay.ts`), time (minutes-from-
      midnight int), title, subtitle, kind (meal/move/rest/sleep/other),
      source (coach/user), status (pending/done/skipped), kcal nullable,
      createdAt/updatedAt. Migration via drizzle-kit.
- [x] New route `app/api/plan/route.ts`: `GET ?tz=` (additive seed-on-every-
      read: inserts a "Lights out" row once, plus any cached-brief meal not
      yet present for today, matched by title — never triggers a fresh LLM
      call), `POST` (add item), `PATCH` (status by id), `DELETE ?id=`.
      Auth via `getUserIdFromRequest`, tz handling like `/api/today`.
- [x] iOS `Core/APIClient.swift`: `fetchPlan()`, `addPlanItem(timeMinutes:
      title:subtitle:kind:kcal:)`, `updatePlanItem(id:status:)`,
      `deletePlanItem(id:)` + `PlanItemDTO`/`PlanResponse`.
- [x] `TodayViewModel`: replaced Phase-1 heuristic with `/api/plan` as the
      primary source; `setStatus`/`removeItem`/`addItem` are now optimistic
      server mutations (mutate locally, fire the API call, revert + toast
      "Couldn't save — try again" on failure).
- [ ] Calendar events are **not** stored server-side (privacy): Phase 8 merges
      EventKit client-side. Design the VM merge point now (plan = server
      items ∪ calendar items sorted by time). *(Still open — Phase 8.)*
- [x] Acceptance: statuses survive relaunch (server-tracked); backend
      lint/type/build green; iOS 13/13 tests green. Note for release:
      migration runs automatically in the release workflow (`drizzle-kit
      push`).

### Phase 3 — Diet sheet (log / edit / target)
**Owner: DONE (2026-07-12, Sonnet subagent) · iOS-heavy · needs Phase 0**

- [x] New `Features/Logging/DietSheetView.swift` (presented inside
      `VitalSheet(detents: [.large])`, content scrolls internally): header
      (remaining kcal of editable target — pencil → inline edit, persists via
      existing `updateDietGoal`), meal-slot grid (Breakfast/Lunch/Snacks/
      Dinner w/ per-slot kcal), "Quick log" list per slot, custom name+kcal
      row, "Logged today" grouped list with remove.
- [x] Reuse the existing nutrition plumbing (`logMeal`, `searchFood`) —
      quick-log foods are a static client list matching the mock's `MEALS`
      exactly. **Endpoint decision**: removing an entry needed a real
      `DELETE`, and reading "today's logged meals bucketed by slot" needed a
      new read shape — both landed on **`app/api/meals/log`** (GET + DELETE
      added to the existing POST-only route) rather than extending
      `/api/logs` (that route formats generic title/subtitle strings across
      all event types over a rolling N-day window — not raw per-slot macros
      scoped to "today") or adding a new file (this route already owns
      `meal_logged` writes, so it owns today's read/delete of them too).
- [x] Fuel strip opens this sheet (was `LogMealView()` directly). `LogMealView`
      keeps working standalone: gained a purely-additive
      `init(initialMethod: MealInputMethod = .text)` so the sheet's
      Photo/Barcode/Search buttons can deep-link into it as a nested
      `.sheet`; existing `LogMealView()` call sites are unchanged.
- [x] Acceptance: log → fuel strip + diet numbers update immediately (via
      `onRefreshToday` → `TodayViewModel.loadHealthData()`) and match
      `/api/today` after refresh; target edit persists. Build green, 13/13
      existing tests still pass.

### Phase 4 — Voice FAB on Today
**Owner: unclaimed · Suggested agent: Sonnet · iOS · needs Phase 0**
(There's an abandoned-looking `feat/elevenlabs-voice` branch — it has no
commits beyond main; ElevenLabs TTS already works via `/api/tts`.)

- [ ] Lime mic FAB bottom-right on Today (hidden while any sheet is open),
      pulse ring + full-screen lime edge-glow overlay + live caption while
      listening (reuse `Core/SpeechTranscriber.swift`).
- [ ] On stop: send transcript through the existing coach pipeline
      (`streamCoach`), toast "Sent to your coach", response lands in Coach
      tab thread (and optionally TTS-plays via `CoachSpeaker`).
- [ ] Acceptance: round-trip works on device; FAB never overlaps sheets; mic
      permission denial degrades gracefully.

### Phase 5 — Trends restyle
**Owner: unclaimed · Suggested agent: Haiku/Sonnet · iOS · needs Phase 0**

- [ ] Screen title style, calibrating banner (limeSoft, only while
      `calibration.status == "calibrating"`).
- [ ] `TrendBarChart` (sleep): goal-scaled bars, gray `< threshold` nights,
      dashed placeholders for missing days; footnote ("Under 6h10m on 4 of 7
      nights…") driven by real data.
- [ ] `TrendLineChart` (HRV, RHR): lime polyline + dots, ringed last point,
      dashed hollow dots for missing days.
- [ ] Data from existing `fetchTrends(metric:days:)`. Swift Charts or hand-
      drawn — match the mock's look; hand-drawn is probably closer.

### Phase 6 — Logs day pager
**Owner: unclaimed · Suggested agent: Haiku/Sonnet · iOS · needs Phases 0+3**

- [ ] Day pager header (‹ / › buttons, disabled at ends; label + date +
      summary "3 entries · 640 kcal · 2.4 km").
- [ ] Per-day diet budget card (read-only "Past day" variant) — needs per-day
      diet totals; check `/api/logs` response, extend backend if it lacks
      per-day macro rollups (Haiku backend task).
- [ ] Entries list in new card idiom + dashed add button (today only).

### Phase 7 — Profile & Coach restyle
**Owner: unclaimed · Suggested agent: Haiku · iOS · needs Phase 0**

- [ ] Coach: bubble/composer/chips restyle only (§1 table). Don't touch
      streaming logic.
- [ ] Profile: avatar header card, calibration % banner, settings rows w/
      icon badges + chevrons; Goal detail gets "Coach recommends" limeSoft
      card + "Use this goal" + "What this means" facts (static per-goal copy
      is fine, mirroring mock's `GOAL_DETAILS`); Devices screen (Apple Watch
      "Connected · synced" + Whoop/Oura/Garmin "Connect" stubs, non-functional);
      log-out row in red.

### Phase 8 (stretch) — Calendar merge
**Owner: unclaimed · Suggested agent: Sonnet · iOS · needs Phase 2**

- [ ] EventKit read-only permission (Info.plist string via
      `ios/Vital/project.yml`), fetch today's events, merge into the timeline
      client-side (neutral icon badge + "Calendar" tag, no Log button, not
      persisted server-side).

---

## 4. Decisions & assumptions (challenge in PR review if wrong)

1. **Dark mode kept** — mock is light-only; we map v3 to light and keep tuned
   dark equivalents rather than dropping dark support.
2. **Custom tab bar** replaces native `TabView` chrome (mock is unambiguous).
3. **Mock's fake status bar / iPhone frame** is presentation-only — ignore.
4. **Streak chip moves into the Today header** (mock has it there, plus the
   old chip row is gone).
5. **Plan items persist server-side** (Phase 2) because statuses must survive
   relaunch and inform the coach; **calendar events never leave the device**.
6. **`GlassCard` is deprecated, not deleted** until all call sites migrate.
7. Mock's `FuelStrip` shows protein only in the subline — copy that.

## 5. Progress log (append entries here on handoff)

- 2026-07-12 (Claude session, Suman): Imported design, wrote this plan,
  branch `feat/redesign-v3` created. Starting Phase 0.
- 2026-07-12: Phase 0 done — Theme v3 tokens, VitalCard / IconBadge /
  VitalSheet / `.toast(message:)` primitives, custom floating tab bar in
  RootTabView, restyled Chip/CoachBubble/MetricTile/SectionHeader,
  TrendDirection good-deltas now use `Colors.positive`. Build green,
  13/13 existing tests pass. Component signatures:
  `VitalCard(padding:cornerRadius:content:)`,
  `IconBadge(systemName:style:size:cornerRadius:)` (.accent/.soft/.neutral),
  `VitalSheet(detents:content:)` (use inside .sheet), `.toast(message: Binding<String?>)`.
  Note: RootTabView owns tab selection locally — lift it when the voice FAB
  (Phase 4) needs to switch to Coach programmatically. Starting Phase 1.
- 2026-07-12: Phase 1 done (Sonnet subagent) — new `PlanItem` model,
  `PlanTimelineView`, `PlanItemActionsSheet`, `AddPlanItemSheet`,
  `FuelStripView` under `Features/Today/`; `TodayViewModel` derives
  `[PlanItem]` from `/api/today`'s `plan` (heuristic meal times + a synthetic
  "Lights out" sleep row) and exposes `setStatus`/`removeItem`/`addItem`
  local mutations + `toastMessage`; `TodayView` reordered to header → 
  calibration → pending-facts → plan timeline → coach bubble → vitals →
  fuel strip, with the add-item/actions/meal-detail sheets and `.toast`
  wired up. Deviations: (1) added a "View meal" row in the actions sheet
  (not in the mock) so meal items still open `MealDetailView`'s existing
  suggest/log flow — logging there now also marks the plan item done; (2)
  the row's trailing "MoreVertical" hint icon from the mock was dropped, the
  written scope's trailing-element list didn't call for it; (3) both the
  add-item and item-actions sheets use `.medium` detent (mock is a fixed
  390×844 frame with no real detent equivalent); (4) user-added items are
  re-run through the same time-based status computation on every add/reload
  instead of staying frozen at "later" forever like the static mock — more
  correct for a live app. Build green (`xcodebuild ... build`), 13/13
  existing tests still pass on `Vital-iPhone16`. Notes for Phase 2: swap
  `TodayViewModel.derivePlanItems`/`setStatus`/`removeItem`/`addItem` for
  `/api/plan` calls; the title-keyed "preserve done/skipped across
  re-derivation" merge in `derivePlanItems` and the `computeStatuses`
  ±45min-window heuristic can both be deleted once status is server-tracked;
  calendar-item rendering (`PlanItem.Source.calendar`, the "Calendar" pill,
  `.neutral` badge) is already wired in `PlanTimelineView`/
  `PlanItemActionsSheet` and ready for Phase 8's EventKit merge.
- 2026-07-12: Phase 2 done (Sonnet subagent) — plan persistence, full-stack.
  Backend: `plan_items` table in `db/schema.ts` (id, userId, localDay,
  timeMinutes, title, subtitle, kind, source, status, kcal,
  created/updatedAt; index on (userId, localDay)); migration
  `db/migrations/0005_premium_molecule_man.sql` generated via `npx
  drizzle-kit generate` (no live DB touched — CI applies it via `drizzle-kit
  push` on release, per the release workflow). New `app/api/plan/route.ts`:
  GET (additively seeds a "Lights out" row + any not-yet-present cached-brief
  meal on *every* call — never awaits a fresh Claude call, so the plan
  silently fills in once `/api/today`'s background brief generation lands),
  POST/PATCH/DELETE for user items + status changes, all scoped to
  `x-user-id` and 401/400 as appropriate. iOS: `PlanItem.id` is now a mutable
  `String` (server uuid, swapped in after an optimistic POST resolves);
  `APIClient` gained `fetchPlan()` (sends `?tz=` like `fetchToday()`),
  `addPlanItem`, `updatePlanItem(id:status:)`, `deletePlanItem(id:)`, and
  `PlanItemDTO`/`PlanResponse`. `TodayViewModel.loadHealthData` now fetches
  `/api/today` and `/api/plan` concurrently, then maps `/api/plan` rows →
  `PlanItem` (icon derived client-side from kind/title; meal rows re-matched
  by title against `/api/today`'s `plan` array to keep the `MealRow` for
  `MealDetailView`). `setStatus`/`removeItem`/`addItem` are optimistic:
  mutate `planItems` immediately, fire the matching API call, revert + set
  `toastMessage = "Couldn't save — try again"` on failure. Deviations: (1)
  kept a **Phase 1 fallback** — if `fetchPlan()` throws (old backend without
  `/api/plan`), `TodayViewModel` falls back to the original client-side
  heuristic derivation from `/api/today`'s `plan`, clearly marked "PHASE 2
  FALLBACK" in code comments, so the app keeps working read-only against a
  not-yet-migrated prod backend during rollout; writes in that fallback mode
  still go through the optimistic server path and will revert with a toast
  since the endpoint doesn't exist there — accepted degradation, not a crash;
  (2) deleted the Phase 1 title-keyed done/skipped preservation merge in
  `derivePlanItems` per the brief (server now owns status, so the primary
  path never needs it; the fallback-only survivor rebuilds fresh each
  reload); (3) `AddPlanItemSheet` needed no changes — it already only hands
  the VM a `PlanItem`, and `addItem` now persists that under the hood.
  Verify: backend `npm run lint` / `npx tsc --noEmit` / `npm run build` all
  green (Node 20, `/api/plan` shows in the build's route list); iOS
  `xcodegen generate` + `xcodebuild ... test` on `Vital-iPhone16` → **TEST
  SUCCEEDED**, 13/13 existing tests still pass. Notes for Phase 3: the diet
  sheet is unrelated to plan persistence and can proceed independently;
  Phase 8's calendar merge point is still just a design note (no code) —
  merge calendar items into `planItems` client-side only, sorted by
  `timeMinutes`, never POSTed to `/api/plan`.
- 2026-07-12: Phase 3 done (Sonnet subagent) — diet sheet, full-stack.
  Backend: `app/api/meals/log/route.ts` gained `GET ?tz=` and `DELETE ?id=`
  alongside the existing `POST`; `POST` also accepts an optional
  `slot: 'breakfast'|'lunch'|'snacks'|'dinner'` field (400 if present but
  invalid), stored inside `payload` alongside `name/kcal/c/p/f/source` —
  omitted entirely for older call sites, exactly like the existing
  `imageThumb` conditional spread. GET filters `meal_logged` events to the
  caller's local today (same `pickTimeZone`/`localDayKey` precedence as
  `/api/plan`/`/api/today`: `?tz=` → stored `users.timezone` → UTC) and
  returns `{ items: [{ id, name, kcal, protein, carbs, fat, slot, loggedAt }] }`
  sorted ascending by `loggedAt`. DELETE hard-deletes a single event scoped to
  `(id, user_id, type='meal_logged')` — a narrow, explicitly-commented
  exception to the "events is append-only" rule in `db/schema.ts`, justified
  as a user-initiated correction of a mis-logged meal, not a general delete
  capability. No migration needed (`payload` is jsonb; DELETE uses the
  existing table). Verify: `npm run lint` / `npx tsc --noEmit` / `npm run
  build` all green (Node 20), `/api/meals/log` shows in the build's route
  list. iOS: `Core/APIClient.swift` — `logMeal(...)` gained a trailing
  `slot: String? = nil` param (Swift's synthesized `Encodable` omits it when
  nil, same as `imageThumb`, so the existing `LogMealViewModel` call site
  needed zero changes); added `fetchTodayMealLogs()` (GET, `?tz=` like
  `fetchToday()`/`fetchPlan()`) and `deleteMealLog(id:)` (DELETE, mirrors
  `deletePlanItem(id:)`); new `MealLogEntryDTO`/`MealLogsResponse` DTOs next
  to `PlanResponse`. New `Features/Logging/DietSheetViewModel.swift`: `DietSlot`
  enum (breakfast/lunch/snacks/dinner, `CaseIterable` order = display/grouping
  order), static `quickFoods: [DietSlot: [QuickFood]]` matching the mock's
  `MEALS` exactly, `target`/`remaining` (derived)/`loggedEntries` state,
  `load()` (concurrent `fetchDietGoal()` + `fetchTodayMealLogs()`),
  `logQuickFood`/`logCustom`/`removeEntry`/`updateTarget` all optimistic with
  toast-on-failure + `onRefreshToday()` callback on success (mirrors
  `MealDetailView`'s completion calling `vm.loadHealthData()`), plus
  `subtotalLabel(for:)` and `loggedGroups` (breakfast→lunch→snacks→dinner,
  then a trailing "Other" group for `slot == nil` entries from the
  photo/barcode/search flow, so they don't disappear from "Logged today").
  New `Features/Logging/DietSheetView.swift`: header + editable-target row +
  4-way slot grid + "Quick log" `VitalCard` list + custom entry row + a
  Photo/Barcode/Search row that presents `LogMealView(initialMethod:)` as a
  nested `.sheet` (reloads + calls `onRefreshToday()` on dismiss, whether
  logged or cancelled) + "Logged today" grouped list with per-entry delete.
  `Features/Logging/LogMealView.swift` gained
  `init(initialMethod: MealInputMethod = .text)` — sets
  `vm.selectedMethod` in `.onAppear`; existing `LogMealView()` call sites and
  `LogMealViewModel` are untouched. `TodayView.swift`: the fuel-strip
  `.sheet(isPresented: $showLogSheet)` now presents
  `VitalSheet(detents: [.large]) { DietSheetView(initialTarget:
  vm.diet.kcalTarget, onRefreshToday:) }` instead of `LogMealView()` directly.
  **Endpoint decision** (flagged as open in this doc): GET landed on
  `app/api/meals/log` rather than extending `/api/logs` or adding a new file
  — see the Phase 3 checklist above for the full reasoning. Deviations from
  the brief: none structural; the target `TextField` commits on blur via
  `@FocusState` (`onChange` true→false) since `.numberPad` has no Return key,
  plus `.onSubmit` for parity if a hardware keyboard is attached. Verify:
  backend lint/tsc/build green; iOS `xcodegen generate` +
  `xcodebuild ... build` → **BUILD SUCCEEDED**, `xcodebuild ... test` →
  **TEST SUCCEEDED**, 13/13 existing tests still pass (no new test target
  changes — this phase added UI + a thin ViewModel with no committed test
  coverage, consistent with Phases 1–2). Note for whoever picks up Phase 6
  (Logs day pager): it will want this same `/api/meals/log` GET for past-day
  diet cards, but today's implementation is **today-only** — it always
  resolves "today" from `?tz=`/stored timezone and has no `?date=` param.
  Phase 6 will need to add a `?date=YYYY-MM-DD` (or equivalent local-day key)
  override to `GET /api/meals/log` — or a separate per-day rollup endpoint —
  to read a past day's logged meals read-only; deliberately not added now
  since Phase 3's brief scoped this to today only.