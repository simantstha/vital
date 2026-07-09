# Problem 04 — 365-day backfill self-disables after an empty first run

**Status:** ✅ Fixed on branch `fix/backfill-empty-run-selfdisable`
**Reported:** 2026-07-09
**Area:** iOS — `BackfillCoordinator` (HealthKit 365-day backfill), data population

**Fix applied:**
- **Empty run no longer self-disables:** the `days.isEmpty` guard in
  `BackfillCoordinator.startIfNeeded()` now just `return`s instead of calling
  `markComplete()`, so a first attempt before HealthKit access is granted (or
  before history syncs) doesn't permanently set `backfill.completed`. A later
  launch retries.
- **Recovery for already-stuck accounts:** added `BackfillCoordinator.resync()`
  (clears the `completed`/`lastCompletedDate` flags and re-runs) surfaced as a
  **"Re-sync Health History"** button in Profile → Integrations. Existing
  accounts stuck with `completed = true` (like the reporter's) can recover
  without a reinstall; server ingest is an idempotent upsert.

**Data-source caveat still applies:** if the device's Apple Health genuinely
lacks older history (fresh device / simulator), re-syncing can only import what
exists.

---

## Symptom

Trends "1Y" renders, but the chart only shows a sparse ~4-month arch — "most of
the year" is missing. It looks like the app never grabbed a year of data even
though the backfill is supposed to pull 365 days.

## Ground truth (production `daily_metrics`)

The signed-in account (`user_id 299bf24b-…`) has **only ~6 days total, across
every metric**, all on the same handful of dates:

| metric | days | span |
|---|---|---|
| steps / sleep / hr_avg / hrv_sdnn / resting_hr / active_energy / workouts | 6 | 2026-03-09 → 2026-07-09 |
| body_mass_kg | 4 | 2026-03-09 → 2026-07-07 |

The 6 step rows: `2026-03-09: 9316`, `2026-06-30: 11700`, `2026-07-06: 6082`,
`2026-07-07: 8958`, `2026-07-08: 5302`, `2026-07-09: 10004` — which exactly
reproduce the screenshot (Latest 10004, Range 5302–11700, Average 8560, +7%).

By contrast, two other users have a **full dense year**:
`user 333f64e5 → 368 step-days (2025-07-07 → 2026-07-09)`,
`user 4cef2b1d → 366 step-days`. So the pipeline works; it just never ran for
this account.

**Interpretation:** the same 6 dates appearing across *all* metrics = these came
from ordinary **daily syncs** on the days the app was opened, **not** from the
365-day backfill. The backfill never populated this account.

## Root cause

`BackfillCoordinator` is a **one-shot gated by `backfill.completed`**, and it
sets that flag even when it uploaded **zero** days — so a first run that pulled
little/no history permanently disables all future backfills.

### Evidence (`ios/Vital/Sources/Health/BackfillCoordinator.swift`)

1. **Permanent no-op once completed (`:71-75`):**
   ```swift
   guard !defaults.bool(forKey: Keys.completed) else {
       isComplete = true; progress = 1; return
   }
   ```

2. **Marks complete on empty days (`:92-95`) — the trap:**
   ```swift
   guard !days.isEmpty else {
       markComplete()   // sets backfill.completed = true with nothing uploaded
       return
   }
   ```

3. **Auth is fire-and-forget with no grant check (`:82-85`):**
   ```swift
   await healthKitManager.requestAuthorization()
   var days = try await backfill.buildIngestDays(days: Config.totalDays)
   ```
   HealthKit *read* authorization is opaque (you can't query whether read was
   granted). If the user hasn't granted history access yet, or the build runs
   before auth settles, `buildIngestDays` returns empty → `markComplete()` →
   backfill is disabled forever, even after access is later granted.

4. **`markComplete()` only writes the flag (`:140-144`)** — no record of how many
   days were actually uploaded, so there's no signal to distinguish "completed a
   real year" from "completed with nothing."

### Why this account looks the way it does

The first `startIfNeeded()` almost certainly ran before/without effective
HealthKit history access (empty `days`) → `completed = true`. Since
`RootTabView`'s `.task` calls `startIfNeeded()` on every launch but it's now a
no-op, the year never uploads. The ~6 days present are whatever the **daily
sync** wrote on the days the app was opened.

## Not the cause

- **Not the Trends feature (Problem 3).** The 1Y picker, axis, and stats are
  correct — the chart faithfully draws all 6 points. Other users render a full
  dense year through the same screen.
- **Not the query.** `queryMetricPoints` (`lib/brain/tools.ts:491`) filters
  `date >= today-365` with **no LIMIT**; it returns everything that exists.
- **Not the backfill *range* math.** `range(days:)` requests a full 365-day
  window; `HKStatisticsCollectionQuery` skips only days HealthKit has no data
  for — correct behavior.
- **Not a per-metric issue.** All 8 metrics are equally sparse on the same dates.

## Open dependency to confirm

Does this account's **Apple Health actually contain a year** of history? (Real
personal device → yes; a fresh test device / simulator → maybe not.) If Health
genuinely lacks older data, no fix can conjure it — but the self-disable bug is
real regardless and would mask a legitimate backfill on any account whose first
run was empty.

## Proposed fix (for the fix session — do NOT implement yet)

1. **Don't mark complete on an empty/near-empty run.** In `:92-95`, when `days`
   is empty (or below a small threshold), leave `completed` unset so the next
   launch retries. Only `markComplete()` after a run that actually uploaded a
   meaningful number of days.
2. **Record coverage, not just a boolean.** Persist `daysUploaded` (or the min
   date reached) so the coordinator (or a server check) can tell a real year from
   an empty completion and self-heal.
3. **Gate on real authorization where possible.** Skip `markComplete()` if
   HealthKit read access wasn't effectively granted; retry once it is.
4. **Manual re-sync affordance.** Add a "Re-sync health history" action (Profile)
   that clears `backfill.completed` + `backfill.lastCompletedDate` and re-runs —
   so a stuck account can recover without a reinstall.
5. **Verify the sign-out path.** The header comment claims the flag clears on
   sign-out; confirm sign-out actually removes these UserDefaults keys (if not,
   reinstall is currently the only recovery).

### Immediate remedy for the current account (no code change)
Reinstall the app (clears `UserDefaults` → clears the `completed` flag), grant
**full Health read access** when prompted, and let the backfill run once. If the
device's Apple Health holds a year, it will upload it.

### Files likely touched
- `ios/Vital/Sources/Health/BackfillCoordinator.swift` (`:82-95`, `:140-144`)
- Possibly `ios/.../Health/HealthSyncCoordinator.swift` / a Profile view for the
  manual re-sync action
- Sign-out logic (wherever the session + UserDefaults are cleared)

## Verification plan (after fix)
- Simulate an empty first run (deny/withhold Health history): confirm
  `backfill.completed` stays **false** and the next launch retries.
- Grant access with a year of Health data: confirm all ~365 days upload and
  Trends "1Y" fills in.
- Confirm the manual "re-sync" action clears the flags and re-runs.
