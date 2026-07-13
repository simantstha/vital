# Vital app redesign — "Today Screen v3" implementation plan

**Status: Phases 0–8 done (redesign complete)** · Branch: `feat/redesign-v3` (off `main`)
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
- [x] Calendar events are **not** stored server-side (privacy): Phase 8 merges
      EventKit client-side. Design the VM merge point now (plan = server
      items ∪ calendar items sorted by time). *(Done — Phase 8.)*
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
**Owner: DONE (2026-07-12, Sonnet subagent) · iOS · needs Phase 0**
(There's an abandoned-looking `feat/elevenlabs-voice` branch — it has no
commits beyond main; ElevenLabs TTS already works via `/api/tts`.)

- [x] Lime mic FAB bottom-right on Today (hidden while any sheet is open),
      pulse ring + full-screen lime edge-glow overlay + live caption while
      listening (reuse `Core/SpeechTranscriber.swift`).
- [x] On stop: send transcript through the existing coach pipeline
      (`streamCoach`), toast "Sent to your coach", response lands in Coach
      tab thread (and optionally TTS-plays via `CoachSpeaker`).
- [x] Acceptance: round-trip works on device; FAB never overlaps sheets; mic
      permission denial degrades gracefully.

### Phase 5 — Trends restyle
**Owner: DONE (2026-07-12, Sonnet subagent) · iOS + tiny backend**

- [x] Screen title style, calibrating banner (limeSoft, only while
      `calibration.status == "calibrating"`).
- [x] `TrendBarChart` (sleep): goal-scaled bars, gray `< threshold` nights,
      dashed placeholders for missing days; footnote ("Under 6h on 4 of 7
      nights…") driven by real data.
- [x] `TrendLineChart` (HRV, RHR): lime polyline + dots, ringed last point,
      dashed hollow dots for missing days.
- [x] Data from existing `fetchTrends(metric:days:)`. Hand-drawn SwiftUI
      (not Swift Charts) — matches the mock's look. Backend gained an `rhr`
      metric + `calibration` in the `/api/trends` response (see changelog).

### Phase 6 — Logs day pager
**Owner: DONE (2026-07-12, Sonnet subagent) · iOS + small backend · needed Phases 0+3**

- [x] Day pager header (‹ / › buttons, disabled at ends; label + date +
      summary "3 entries · 640 kcal · 2.4 km").
- [x] Per-day diet budget card (read-only "Past day" variant) — per-day meal
      entries via new `?date=YYYY-MM-DD` on `GET /api/meals/log`; summary
      needed structured fields, so `/api/logs` items gained optional
      `kcal`/`km`/`sleepMs` (see changelog).
- [x] Entries list in new card idiom + dashed add button (today only).

### Phase 7 — Profile & Coach restyle
**Owner: DONE (2026-07-13, Sonnet subagent) · iOS only**

- [x] Coach: bubble/composer/chips restyle only (§1 table). Don't touch
      streaming logic.
- [x] Profile: avatar header card, calibration % banner, settings rows w/
      icon badges + chevrons; Goal detail gets "Coach recommends" limeSoft
      card + "Use this goal" + "What this means" facts (static per-goal copy
      is fine, mirroring mock's `GOAL_DETAILS`); Devices screen (Apple Watch
      "Connected · synced" + Whoop/Oura/Garmin "Connect" stubs, non-functional);
      log-out row in red.

### Phase 8 (stretch) — Calendar merge
**Owner: DONE (2026-07-13, Sonnet subagent) · iOS · needs Phase 2**

- [x] EventKit read-only permission (Info.plist string via
      `ios/Vital/project.yml`), fetch today's events, merge into the timeline
      client-side (neutral icon badge + "Calendar" tag, no Log button, not
      persisted server-side).

---

## 4. Decisions & assumptions (challenge in PR review if wrong)

1. **Dark mode kept** — mock is light-only; we map v3 to light and keep tuned
   dark equivalents rather than dropping dark support.
2. ~~**Custom tab bar** replaces native `TabView` chrome (mock is unambiguous).~~ **Reverted 2026-07-13 by user preference**: native glassy `TabView` bar restored — the custom pill covered the Coach composer and the user prefers the native finish.
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
- 2026-07-12: Phase 4 done (Sonnet subagent) — voice FAB on Today, iOS only,
  no backend changes (STT/TTS/coach endpoints already existed and are
  untouched). **Key architectural decision** (this is the mechanism the
  Phase 0 and Phase 1 changelog entries flagged as needed): lifted
  `CoachViewModel` out of `CoachView` and up to `App/RootTabView.swift`,
  which now owns a single `@StateObject private var coachVM =
  CoachViewModel()` for the app's lifetime and passes it to both
  `CoachView(vm: coachVM)` (new init, `_vm = StateObject(wrappedValue: vm)` —
  valid because the same instance is passed on every `RootTabView`
  re-render) and the new `TodayView(coachVM:switchToCoachTab:)`. `RootTabView`
  also now exposes a `switchToCoachTab` closure (`{ selected = .coach }`) so
  a voice turn started on Today can hand off to the Coach tab. The old
  `CoachView(mode:)` init (used unchanged by `OnboardingFlowView`'s
  `CoachView(mode: "onboarding")`) still creates its own private
  `CoachViewModel` — onboarding's coach conversation stays independent, not
  merged into the shared instance. New `Features/Coach/CoachViewModel.swift`
  method `sendExternalVoiceTranscript(_ text:)` (additive, ~10 lines, doesn't
  touch `send()`/`toggleVoiceRecording()`/`finishVoiceInput()`): sets
  `input`, flags `pendingSentByVoice = true`, calls the existing `send()` —
  so a Today-originated transcript runs through the identical
  send/stream/speak pipeline as a Coach-tab voice turn (same thread, same
  voice-in-implies-voice-out TTS rule, no new setting invented). New
  `Features/Today/VoiceFABView.swift`: lime circular mic FAB, bottom-trailing
  on Today, owns its **own** `SpeechTranscriber` instance (deliberately not
  `coachVM.transcriber`) so a Today voice turn can never contend with or be
  silently cancelled by a recording started from the Coach tab's own mic
  button, or vice versa — both instances funnel into the same `coachVM`
  regardless. Tap to start: pulse ring (`PulseRing`, a stroked circle that
  scales/fades on a `repeatForever` loop, re-triggered every turn via
  `.onAppear` since the caller only mounts it while `isRecording`) + a
  full-screen blurred lime border (`edgeGlow`, `.ignoresSafeArea()`) + a live
  caption pill near the bottom showing `transcriber.transcribedText` (Apple's
  on-device live preview, same source `CoachView`'s input-field mirroring
  uses). Tap to stop (or a `SpeechTranscriber` watchdog auto-stop, detected
  via `.onChange(of: transcriber.isRecording)`): mirrors
  `CoachViewModel.finishVoiceInput`'s upload-then-fallback rule locally
  (`APIClient.shared.uploadSTTAudio`, Apple transcript as fallback) then
  calls `coachVM.sendExternalVoiceTranscript` and fires `onSent()`.
  `TodayView` wires `onSent` to set `vm.toastMessage = "Sent to your coach"`
  (existing `.toast(message:)` host, existing `TodayViewModel.toastMessage`)
  and, after a 0.6s delay so the toast is visible before the tab changes,
  calls `switchToCoachTab()` — so the user watches the reply stream in (and
  hears it via `CoachSpeaker`, since `sendExternalVoiceTranscript` sets
  `pendingSentByVoice = true` exactly like a Coach-tab voice turn) rather
  than the exchange landing invisibly in a background tab. The FAB is hidden
  whenever any Today sheet is open (`TodayView.isAnySheetOpen` — diet sheet,
  add-item, item-actions, or meal-detail — `if !isAnySheetOpen { VoiceFABView(...) }`
  in the body's `ZStack`), so it can never overlap a sheet. Permission
  handling: authorized → toggle recording; not-determined → request, then
  alert if still not granted; denied → alert immediately, offering a
  "Settings" button (`UIApplication.openSettingsURLString`) — the FAB itself
  is never disabled by a denial, so tapping it always re-offers the alert
  (satisfies "stays usable to retry"); also refreshes
  `transcriber.permissionState` on `UIApplication.didBecomeActiveNotification`
  so a grant made in Settings takes effect without an app relaunch.
  Deviations: (1) the brief didn't specify whether the FAB should
  auto-navigate to the Coach tab or stay fire-and-forget on Today — went with
  auto-navigate (after a short toast delay) since it's the only way to make
  "round-trip works on device" and "response lands in Coach tab thread"
  directly observable, and it's what the Phase 0/1 notes' emphasis on
  lifting tab-selection state implied; (2) used a toast + delayed
  `switchToCoachTab()` rather than threading a second explicit "toast host"
  through `RootTabView` — `TodayViewModel.toastMessage`/`TodayView`'s
  existing `.toast()` already covered it with zero new plumbing since the
  toast is shown *before* the tab switches away from Today; (3) the
  full-screen edge glow is a blurred `strokeBorder` on a `RoundedRectangle`
  rather than a shader/gradient — simpler and matches the mock's intent
  (soft lime glow at the screen edges) closely enough at this fidelity.
  Verify: `cd ios/Vital && /opt/homebrew/bin/xcodegen generate` (project.yml
  globs `Sources/`, so the two new files needed no manual project edits);
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild
  -project Vital.xcodeproj -scheme Vital -destination 'platform=iOS
  Simulator,name=Vital-iPhone16' build` → **BUILD SUCCEEDED**; same
  `... test` → **TEST SUCCEEDED**, 13/13 existing tests still pass (no new
  test target coverage added — this phase is UI + thin view-local upload
  orchestration with no committed test target precedent, consistent with
  Phases 1/3). Note: this environment's default shell had `xcodebuild`
  pointed at the CommandLineTools developer directory (no `xcodebuild`
  support there) and `xcodegen` not on `PATH` — used absolute paths /
  `DEVELOPER_DIR` inline rather than changing global `xcode-select` state.
  Notes for later phases: Phase 7 (Coach restyle) should keep
  `CoachView(vm:)` in mind — the shared `coachVM` instance means any new
  Coach-tab-only UI state must live in `CoachView` itself (or a new
  `@State` there), not assume it can freely reset `CoachViewModel`; Phase 8
  (calendar merge) is unrelated and can proceed independently.
- 2026-07-12: Phase 5 done (Sonnet subagent) — Trends restyle, branch
  `feat/redesign-v3-trends` off main (not stacked on PR #55's Phase 4 branch:
  zero file overlap, and the #51/#52 stacking mess argued against). Backend
  (small, additive): `app/api/trends/route.ts` gained metric `rhr` →
  `daily_metrics.resting_hr` (rounded bpm; the metric already existed — the
  coach tools query it) and now returns `calibration` (same
  `getCalibration()` shape as `/api/today`, run via `Promise.all` — one cheap
  GROUP BY per call) so Trends can show the calibrating banner without
  touching the heavier `/api/today`. iOS: screen restyled to the mock's
  "Last 7 days" summary — header (`.screenTitleStyle()` + "Last 7 days"),
  limeSoft calibrating banner (only while `status == "calibrating"`, hidden
  when calibration is nil i.e. old backend), then three `VitalCard`s: Sleep
  (new hand-drawn `TrendBarChart`: goal-scaled bars capped at 8h, short
  nights < 6h in a new adaptive `Theme.Colors.chartMuted` token
  (#E4E5E0 / #2A3038), dashed outlines for missing days), HRV and Resting HR
  (new hand-drawn `TrendLineChart`: accent polyline bridging gaps, 9pt dots,
  ringed 11pt last point, dashed hollow dots for missing days). All summary
  logic is in a pure `TrendsSummary` enum (`weekWindow` date-keyed 7-slot
  mapping, `sleepAverageText`, data-driven footnotes with the mock's bold
  span, `vitalsNote` "syncing"/"7-day", `latestAvailable`) — covered by 18
  new unit tests in `ios/Vital/Tests/TrendsSummaryTests.swift` (first test
  coverage added by any redesign phase; the logic was finally pure enough to
  be worth it). Decisions: (1) the mock drops weight/steps/VO₂/distance and
  range selection entirely — kept them as an "Explore" section below the
  summary cards (existing metric menu + range pills + Swift Charts explorer,
  restyled `GlassCard`→`VitalCard`, active range pill = accentSoft capsule +
  accentContent text, Resting HR added to the menu) since manual weight
  logging (`/api/weight-log`) would otherwise lose its only trend UI; (2)
  short-night threshold = 6h (75% of the app-wide 8h goal) — the mock's
  6h10m was sample-data-specific; (3) footnote copy is data-driven
  ("No sleep synced yet." / "Every night near your 8h goal this week." /
  "Under 6h on N of 7 nights…"; lines: "No readings yet." / "Only N
  reading(s) this week — dashed dots haven't synced." / "Steady this week."
  / "Drifting up (+x%)" / "Trending down (−x%)" with a ±2% steady band);
  (4) weekday letters pinned to en_US for deterministic "F S S M T W T".
  Verify: backend lint/tsc/build green (Node 20, `/api/trends` in route
  list); iOS xcodegen + build + test on `Vital-iPhone16` → **TEST
  SUCCEEDED**, 58/58 (40 pre-existing incl. PR #54's specialist tests + 18
  new). Notes: PR #54 (running-coach specialist) landed on main mid-phase —
  no Trends overlap, but test count is 40 now, not 13; Phase 7's
  `GlassCard`→`VitalCard` migration can copy this phase's explorer pattern
  (same padding/radius args, only the surface type swaps).
- 2026-07-12: Phase 6 done (Sonnet subagent) — Logs day pager, branch
  `feat/redesign-v3-logs-pager` **stacked on `feat/redesign-v3-trends`**
  (PR bases on the Phase 5 branch, so its diff stays clean; GitHub
  auto-retargets to main when Phase 5's PR merges — merge order is
  #60 → this one). Backend (both additive): `GET /api/meals/log` gained
  `?date=YYYY-MM-DD` (regex-validated, 400 on malformed, exactly the
  override the Phase 3 entry anticipated; omitted → identical to before);
  `/api/logs` items gained conditional `kcal` (meal_logged only — food
  eaten, never workout burn), `km` (workout_completed; events `distance_m`,
  HK `queryWorkouts` rows via the same `distance_m`-wins-over-`distanceKm`
  fallback `lib/brain/dietBudget.ts` uses), and `sleepMs` (sleep_session) —
  so the pager's per-day summary line never parses formatted title strings.
  iOS: `LogsViewModel` rewritten around a fixed 7-slot `LogDay` pager model
  (index 0 = today; empty days render with an empty-state row) + pure
  `LogsPagerSummary` helpers (bucketing, "Today"/"Yesterday"/weekday labels,
  meta rule: sleep/HRV → "auto", else "7:41 PM"-style absolute time,
  summary line "N entries[ · N kcal][ · N.N km][ · Hh Mm sleep]" — the
  sleep part only on days with neither kcal nor km, per the mock; diet
  rollup vs `fetchDietGoal().current` targets with `remaining` clamped ≥ 0)
  — same testable-pure-enum convention as Phase 5's `TrendsSummary`, covered
  by 15 new tests in `LogsPagerTests.swift`. `LogsView` rewritten: screen
  title + "Everything you and your devices record", ‹/› pager row (40pt
  circular buttons, card-fill + shadow enabled / glassFill + tertiary
  disabled at ends), new `DietBudgetCardView` (mock's DietBudget: "Log
  food ›" tappable today → opens the same Phase 3 `DietSheetView` the
  Today tab uses, "Past day" read-only otherwise; 48pt remaining, 3pt
  progress capsules, 3-column macro grid reusing `MacroProgress` from
  `TodayViewModel`), hairline-separated entries in one `VitalCard` with
  `IconBadge(.soft)` (photo thumbnails kept; per-type tint colors dropped —
  mock is uniform limeSoft), dashed "Add to today's log" button (today
  only → diet sheet). `APIClient`: `fetchMealLogs(date:)` generalizes
  `fetchTodayMealLogs()` (kept as a forwarder); `LogItem` gained optional
  `kcal`/`km`/`sleepMs`. Caching: diet goal fetched once; meal logs cached
  per dayKey, today's invalidated when the diet sheet closes. Deviations:
  `selectDay` is non-async (spawns its own Task) for button ergonomics;
  spinner only when `days.isEmpty` so pull-to-refresh doesn't blank the
  pager. Verify: backend lint/tsc/build green; iOS xcodegen + build + test
  on `Vital-iPhone16` → **TEST SUCCEEDED, 73/73** (58 + 15 new). Note for
  Phase 7/8: the `enum <Feature>Summary` pure-helper pattern is now house
  convention (TrendsSummary, LogsPagerSummary); `DietBudgetCardView`'s
  tappable-vs-readonly split may be reusable; no skeleton state while a
  day's diet data loads — the card simply appears when the fetch resolves.
- 2026-07-13: Phase 7 done (Sonnet subagent) — Profile & Coach restyle,
  branch `feat/redesign-v3-profile-coach`, presentation-only, iOS only (no
  backend changes, no `CoachViewModel.swift`/`Theme.swift` changes).
  **Coach** (`Features/Coach/CoachView.swift` only): the default "vital"
  persona's `bubbleSurface` case now fills `Theme.Colors.accentSoft` at
  `Theme.Radius.xl`; user bubbles moved off lime onto
  `Theme.Colors.card` + `cardShadow` (radius 1, y 1) at the same `xl` radius,
  with `foregroundStyle` unified to `textPrimary` for both roles (was
  `onAccent` for user); specialist bubbles are untouched (still `.lg` radius,
  glass+tint, unchanged branch). New private `CoachAvatarBadge` (30pt lime
  circle, `onAccent` `message.fill`) renders leading every assistant bubble
  whose `resolvedPresentation.bubbleLabel == nil` (i.e. vital, not a
  specialist) — `MessageBubbleView`'s outer `HStack` gained
  `alignment: .top` so the avatar sits top-aligned against multi-line
  bubbles; this one component change covers both plain `ChatMessage` rows and
  streaming `AssistantTurnView` bubbles since both route through
  `MessageBubbleView`. Composer: the bare `HStack` + `Divider` became one
  `Capsule().fill(Theme.Colors.card)` + `glassBorder` hairline + `cardShadow`
  wrapping the text field/mic/send row (mic and send buttons, their
  three-state logic, and `stopSpeakingRow`/`micPermissionHint` are otherwise
  untouched — their backgrounds were left as-is, judged not "trivial enough"
  to restyle without risking the denial-hint/speaking-row layout). New
  suggestion-chips row (reuses `Chip(isAccent: true)`) sits directly above
  the composer, gated on `showSuggestionChips`: `!vm.rows.contains` a
  `.message` row with `role == .user` — the cheapest correct read of
  "hasn't sent anything yet this session" since `rows` is already the
  transcript's source of truth; tapping a chip sets `vm.input` and calls
  `vm.send()` exactly like manual entry, disabled while `vm.isStreaming`.
  Typing indicator's `glassEffect` became a flat `accentSoft` rounded-24 fill
  to match the new vital bubble. **Profile**: `ProfileView` now wraps its
  `ScrollView` in a `NavigationStack` with `.toolbar(.hidden, for:
  .navigationBar)` (needed for the new Devices push) and a leading
  `screenTitleStyle()` "Profile" header, matching Trends'/Logs' idiom.
  Avatar header moved into a `VitalCard` with a flat `Theme.Colors.accent`
  circle (dropped the old gradient + glow — v3 is flat per spec); the
  overflow `Menu` stays anchored top-trailing via the same `ZStack(alignment:
  .topTrailing)` shape, just nudged in slightly so it doesn't crowd the
  card's rounded corner. Calibration banner copies `TrendsView`'s
  `calibratingBanner` shape/colors with Profile-specific copy
  ("Calibrating — N% · Vital is learning your baselines."), shown only when
  `vm.calibration?.status == "calibrating"`. `ProfileViewModel` gained
  `calibration: CalibrationStatus?` (loaded non-fatally in a new
  `loadCalibration()`, called from `load()` alongside the existing
  `loadBudget()`) and `calibrationPercent: Int`
  (`min(1, minDataDays(hrv_sdnn, resting_hr, sleep_minutes) / 14)`, same rule
  as `TodayViewModel.applyTodayResponse`). **Decision, per the spec's
  explicit instruction**: calibration is fetched via
  `apiClient.fetchTrends(metric: "rhr", days: 7)` (mirroring
  `TrendsViewModel.loadSummary()`) rather than decoding the `calibration`
  field the backend's `/api/profile` route already returns in its JSON body
  — `ProfileResponse` doesn't decode that field today, and the brief called
  out the Trends-mirroring approach by name, so `APIClient.swift` needed zero
  changes. Settings rows (Daily Budget, Reminders) and the two stat grids
  (Profile Details, Activity) migrated `GlassCard`→`VitalCard`, ad-hoc icon
  `ZStack`s → `IconBadge(style: .soft)`, chevrons → `textTertiary`. New
  **Devices row** (`VitalCard` + `IconBadge("applewatch")`, subtitle "Apple
  Watch · Connected"/"· Not connected") is a `NavigationLink` to new
  `Features/Profile/DevicesView.swift`: canvas background, `screenTitleStyle()`
  "Devices" title, one `VitalCard` per device. **Deviation**: the spec's
  "Apple Watch / Apple Health: status from `vm.integrations`" is rendered as
  a single "Apple Watch" row (matching the mock's exact device name) backed
  by `vm.integrations` — the backend's `/api/profile` route only returns one
  combined `{ name: "Apple Health", status }` integration (verified in
  `app/api/profile/route.ts`), which is also the channel Apple Watch data
  flows through, so there's no separate watch-specific signal to read;
  showing two rows both claiming status from the same one signal would have
  been misleading. Whoop/Oura/Garmin are non-functional `VitalCard` stubs
  with a `textSecondary` "Not connected" line and a trailing `accentSoft`
  "Connect" pill; tapping one flips a local `@State private var tappedStub:
  String?` to append an inline "· Coming soon" to that row's subtitle only —
  never a fake connected state. Sign-out row migrated to `VitalCard` with a
  `Theme.Colors.alert.opacity(0.12))`-tinted icon square (kept the existing
  hand-rolled `ZStack` rather than `IconBadge`, which has no red/alert style
  variant — judged as the "red-tinted variant if trivial" the spec allowed).
  **Goal detail** (`DietBudgetEditorView`, auto-mode branch only): migrated
  `heroCard`/`macroRow`/`goalCard` `GlassCard`→`VitalCard`; added a
  `coachRecommendsCard` (`accentSoft` rounded-24, "COACH RECOMMENDS" label,
  "Endurance" + the marathon-training line from the brief verbatim, "Use
  this goal" lime pill → `vm.setGoal("endurance")`), hidden via `if vm.goal
  != "endurance"`; added a `whatThisMeansCard` (`VitalCard`, "WHAT THIS
  MEANS" label, 3 bullet facts per goal from a new static `private static
  let goalFacts: [String: [String]]` keyed by all four goal ids, each with a
  small `accentContent` checkmark icon) reading `vm.goal` live so it updates
  when the menu picker changes goals. Verify:
  `cd ios/Vital && xcodegen generate` (picked up the new `DevicesView.swift`
  via the existing `Sources/` glob, no `project.yml` edit needed);
  `xcodebuild ... build` → **BUILD SUCCEEDED**; `xcodebuild ... test` →
  **TEST SUCCEEDED, 85/85** (this branch had picked up more tests from `main`
  since Phase 6's 73 — `CoachSpecialistViewTests`/`ProactiveNotificationsTests`
  etc. from unrelated merged PRs; zero new tests added this phase, consistent
  with prior presentation-only phases). Notes for Phase 8: unrelated
  (EventKit/calendar merge on Today) — no overlap with this phase's files.
- 2026-07-13: Phase 8 done (Sonnet subagent) — calendar merge, iOS only, on
  `feat/redesign-v3-calendar`. `ios/Vital/project.yml`: added
  `NSCalendarsFullAccessUsageDescription`. New
  `Features/Today/CalendarEventsProvider.swift`: pure `CalendarPlanMapping`
  enum (`planItemFields`/`minutesFromMidnight`/`subtitle`/`merge` — no
  EventKit types, unit-testable) + `@MainActor CalendarEventsProvider` class
  wrapping one `EKEventStore` (`authorizationStatus`, `requestAccess()` via
  iOS 17+ `requestFullAccessToEvents()`, `fetchTodayPlanItems(now:)` —
  predicate-scoped to the local calendar day, skips all-day and
  cheaply-detected declined events, maps to `PlanItem(id: "cal-" +
  eventIdentifier, source: .calendar, kind: .other, sfSymbol: "calendar")`).
  `TodayViewModel`: both `applyPlanResult` paths (server `/api/plan` and the
  Phase 1 fallback) now funnel through one new `mergeAndSetPlanItems(
  serverItems:)` — fetches calendar items (if authorized), drops
  session-local `hiddenCalendarItemIDs`, unions + sorts via
  `CalendarPlanMapping.merge`, then runs the existing `computeStatuses`;
  publishes `calendarSyncState` (`.notDetermined`/`.authorized`/`.denied`)
  for the view. `setStatus`/`removeItem` guard on `item.source == .calendar`:
  status changes mutate `planItems` only (no `APIClient` call); remove
  inserts the id into `hiddenCalendarItemIDs` and drops it locally — no
  `cal-…` id ever reaches `APIClient`. New `syncCalendar()` is the only
  caller of `requestAccess()`, itself only invoked from an explicit user tap
  (never auto-requested). `PlanTimelineView` gained an optional
  `onSyncCalendar: (() -> Void)?`: when non-nil (authorization
  `.notDetermined`) it swaps the footer caption for a tappable "Sync your
  calendar" row (`calendar.badge.plus` icon, `accentContent` text); nil
  (authorized or denied/restricted) shows the existing plain caption
  unchanged in both cases, per spec — deliberately not distinguishing denied
  from authorized copy. `TodayView` wires `onSyncCalendar` from
  `vm.calendarSyncState`. New `Tests/CalendarPlanMappingTests.swift` (13
  tests): timed vs all-day mapping, minutes-from-midnight, subtitle
  formatting (short/long/empty calendar name, noon-boundary AM/PM), and
  merge (sort, hidden-id filtering, no duplication, empty inputs). No
  backend changes; no calendar data constructed anywhere near `APIClient` —
  grepped the diff to confirm. Deviation: `derivePlanItems` (Phase 1
  fallback) changed from a `planItems`-mutating `Void` function to a pure
  `-> [PlanItem]` return so both paths funnel through the single new merge
  point, exactly as the spec asked ("factor the merge so it's applied after
  either source resolves") — its own internal `computeStatuses` call was
  removed since `mergeAndSetPlanItems` now runs it once on the merged set.
  Verify: `xcodegen generate` regenerated `Vital.xcodeproj`/`Info.plist`
  (both gitignored/tracked-generated respectively) picking up the new file
  and Info.plist key automatically (glob-based `Sources/` + `project.yml`
  properties, no other `project.yml` change needed); `xcodebuild ... build`
  → **BUILD SUCCEEDED**; `xcodebuild ... test` → **TEST SUCCEEDED, 98/98**
  (85 existing + 13 new `CalendarPlanMappingTests`, 0 failures). Simulator
  has no calendar data so `CalendarEventsProvider` itself only exercised via
  build; all EventKit-adjacent logic that matters is covered through the
  pure `CalendarPlanMapping` unit tests instead, as the spec anticipated.
  Redesign v3 is now feature-complete through the stretch phase (0–8).
