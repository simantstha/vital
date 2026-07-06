# QA Handoff — simulator test pass, 2026-07-03

**Tester:** senior-QA pass via ios-simulator MCP
**Env:** iPhone 17 · iOS 26.5 · branch `feat/background-sync` · dev server `:3000` · dev-user session (signed in, calibrating account, Apple Health "Connected")
**Scope:** exercised all 5 tabs against the intent of the 7-PR cycle (#6–#12). No code changed — report only.

> Screenshots from the session were in the ephemeral scratchpad (not committed). Repro steps below are self-contained; re-shoot on next run if needed.

> **Update 2026-07-03 (branch `fix/today-daily-metrics-source`):** F1/F4 and F5 **resolved**. `/api/today` biometric cards and `getCalibration` now both read the aggregated `daily_metrics` store (single source of truth), so all surfaces agree by construction and the calibration counter tracks the charts. Verified against local DB with a 20-day `daily_metrics` fixture: cards emit real values (HRV 74 ms / RHR 50 bpm / Sleep 7.8 h) and calibration reads `ready` (20/20 each), not "5 of 14". Diet budget left on the events pipeline (unchanged, coherent). F2 / F3 / F6 (iOS-side) deferred.

---

## TL;DR
The feature surfaces (Coach SSE, Trends, Logs, calibrating gate) mostly work. The **one systemic problem** is data-store fragmentation: Today cards, Trends, coach tools, and the calibration counter read **different stores**, so the same metric shows different values and calibration state contradicts the charts. Fix that and most findings collapse.

---

## Findings (ranked)

### 🔴 F1 / F4 — HIGH — Same metric shows different values on every surface
HRV appears as **five different numbers** in one session:

| Surface | HRV |
|---|---|
| Today metric card | **0 ms** |
| Today coach narrative | 65 ms |
| Coach tool table | 58 ms |
| Trends (14d latest) | 73 ms |
| Profile "Avg HRV" | 64 ms |

Sleep same story: Today card **0h 0m** vs Trends 7.8h vs coach narrative "7h 48m".

**Root cause (confirmed in code):** `app/api/today/route.ts` builds the biometric cards from raw `schema.events` of type `hrv_reading` / `sleep_session` within the **last 3 days** (route.ts:81, 90–96, extractHrv @98–104). Trends and the coach data-tools read aggregated **`daily_metrics`**. This account has `daily_metrics` (rich charts) but no recent raw `events` → `hrvValue` / `sleepHours` / `rhrValue` resolve to `null` → the null-tolerant iOS decode renders them as **0**.

**Fix direction:** make `/api/today` fall back to `daily_metrics` when no recent raw events exist (single source of truth), OR ensure seed/backfill also writes raw `events`. Prefer the former — `daily_metrics` is the canonical aggregate everything else already trusts. After fix, verify all five surfaces agree.
**Repro:** launch app → Today; compare card values (0) to the coach paragraph and to Trends.

### 🔴 F5 — HIGH — Calibration counter contradicts the charts
Today says *"Calibrating your baselines — 5 of 14 days collected."* But:
- Trends → 30d shows a **continuous 30-day** history (Jun 13–Jul 3, ~25 points).
- Profile STATS shows **17 Logged days**.

17 (or 30) days of data should read **14/14 = complete**, not 5/14. The calibration day-counter (`getCalibration`) is counting a different store than Trends/Profile. User sees "still calibrating" while looking at a month of data.
**Fix direction:** point calibration day-count at the same `daily_metrics` day set the charts use; then re-check the "established ≥14 data-days" gate.
**Repro:** Today card vs Trends(30d) vs Profile stats.

### 🟠 F2 — MED — Coach renders markdown tables as raw text
Asking "what has my HRV and RHR been this week?" returns a literal `| Date | HRV (ms) | Resting HR (bpm) |` / `|---|---|---|` block shown as plain text. Core coach surface looks broken.
**Fix direction:** render markdown (tables) in the chat bubble, OR system-prompt the coach to avoid tables and use prose/bullets.
**Repro:** Coach → "What has my HRV and resting heart rate been over the last week?"

### 🟠 F6 — MED — No sign-out / account controls on Profile
Profile has avatar, stats, and integrations but **no sign-out, settings, or account row**. Consequences:
- Auth logout + per-user isolation (headline of #6) can't be exercised from the UI.
- Onboarding/auth can't be re-tested without a full app reinstall.
**Fix direction:** add a sign-out (and ideally "manage account") control to Profile.

### 🟢 F3 — LOW — Missing space in streamed coach text
"...pull both of those trends right now!**H**ere's what the data shows" — SSE delta boundary dropping a space/newline between sentences.
**Fix direction:** check delta concatenation / sentence-join in the coach stream assembler.

---

## Working as intended (regression baseline)
- **Coach SSE + tool-call UI** — streaming, tool chips (`✓ Checked your HRV trend`, `✓ Checked your resting heart rate trend`), typing indicator all render correctly.
- **Calibrating persona gate** — coach correctly refuses to declare baselines / readiness at 5/14 days and explains the 14-day requirement. (The *gate* works; only the day-count feeding it is wrong — see F5.)
- **Nutrition pipeline is fully coherent** — Logs "Yesterday · 556 kcal" matches the coach narrative AND the Today diet budget; macro math checks out; day grouping correct. Proves the biometric break (F1) is isolated, not app-wide.
- **Trends** — metric toggles (HRV/Sleep/Weight/Steps), 14d/30d period toggle, charts, latest/range/period summary cards all functional.
- **Profile integrations** — Apple Health "Connected" reflects HealthKit authorization correctly.
- Minor Trends nit: x-axis renders only 2 tick labels (e.g. Jun 19 / Jun 23 on a 14d window) — spacing looks off; cosmetic.

---

## Coverage gaps (not testable this pass)
- **Onboarding (7-step)** — already completed on this install; needs fresh reinstall to re-exercise.
- **Auth logout / Apple Sign-In / per-user isolation** — blocked by F6 (no UI) + active dev session.
- **Background HealthKit sync (#12)** — not observable in-session; needs HK writes + observer trigger on device/sim.

---

## Suggested next-session order
1. **F1/F4** — re-point `/api/today` biometrics at `daily_metrics` (highest leverage; likely also softens F5). File: `app/api/today/route.ts`.
2. **F5** — align calibration day-count with `daily_metrics`. Find `getCalibration`.
3. **F2** — markdown rendering in coach bubble (or prompt fix).
4. **F6** — add sign-out to Profile (unblocks auth/onboarding retesting).
5. **F3** — coach stream spacing (quick).
6. Re-run this simulator pass to confirm all five surfaces agree + calibration reads correctly, then attempt the onboarding/background-sync coverage gaps via fresh reinstall.
