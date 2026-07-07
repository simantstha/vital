# Design — Data-unification fix: Trends + Logs read `daily_metrics`

**Date:** 2026-07-07
**Ships as:** release `v0.2.2` (backend-only fix; iOS unchanged)
**Status:** approved, ready for implementation plan

## Problem

The app writes HealthKit data to two tables, and some read paths query the wrong one:

- **HealthKit backfill + background sync** (the user's 1-year history) writes to
  **`daily_metrics`** via `POST /api/ingest/daily`. Metrics are stored day-keyed
  as `hrv_sdnn`, `sleep_minutes`, `body_mass_kg`, `steps`, and `workouts`
  (value = count, `payload` = array of `{hkUuid, type, durationMin, kcal}`).
- **`GET /api/trends`** still queries the append-only **`events`** table for types
  `hrv_reading`, `sleep_session`, `weight_logged`, `steps_recorded` — which the
  sync no longer writes. Result: Trends charts render "No data yet" despite a
  full year of synced data.
- **`GET /api/logs`** queries `events` for `workout_completed` — which the sync
  never writes either. A completed workout is captured and stored in
  `daily_metrics.workouts`, but never appears in the Logs screen.

This is the same class of bug already fixed for Profile in commit `0434823`
(moved to read `daily_metrics`). The Today screen is already correct — it reads
`daily_metrics` via the `queryMetricPoints()` helper. Only **Trends** and
**Logs** remain on the stale `events` path.

## Goals

1. Trends charts populate from `daily_metrics` for all four metrics (HRV, Sleep,
   Weight, Steps).
2. HealthKit-synced workouts appear in the Logs screen.
3. No iOS changes: both route response shapes stay identical, so the fix takes
   effect on backend deploy — including for the currently-installed TestFlight
   build.

## Non-goals (deferred — see "Planned next")

- Post-workout analysis + calorie-intake recommendation (feature #2).
- Meal-plan detail view / recipes (feature #3).
- App-wide unit unification from the onboarding preference (feature #4).
- Deduplicating a workout that is both synced and manually logged (nothing writes
  `workout_completed` events today, so risk is nil; intentionally left out to
  keep the diff minimal).

## Approach

Read from `daily_metrics` only (plus the manual weight file for weight); do **not**
union the legacy `events` health rows — the sync stopped writing those event types,
so unioning would only add dead code. `daily_metrics` is already day-keyed
(`UNIQUE(user, date, metric)`), so the current Trends route's manual per-day
bucketing/aggregation is deleted and replaced with the existing
`queryMetricPoints()` helper. Net result: **less** code.

### Component 1 — `app/api/trends/route.ts` (rewrite, smaller)

Map the requested Trends metric to its `daily_metrics` name, pull points via
`queryMetricPoints(userId, mapped, days)` (from `lib/brain/tools.ts`), and apply
a unit transform:

| Trends metric | `daily_metrics` metric | transform (→ display unit) |
|---|---|---|
| `hrv`    | `hrv_sdnn`     | round to integer (ms) |
| `sleep`  | `sleep_minutes`| `value / 60`, round to 1 dp (hours) |
| `steps`  | `steps`        | as-is |
| `weight` | `body_mass_kg` **+ manual weight file** | round to 1 dp (kg) |

Keep the existing metric validation, auth (`getUserIdFromRequest`), and the
`days` clamp (1–365). Response shape is unchanged:
`{ metric, points: [{ date: "YYYY-MM-DD", value: number }] }` (oldest→newest).

**Weight merge:** query `body_mass_kg` points from `daily_metrics`, then read
manual entries via `readWeightLog(userId)` (`lib/weightLog.ts`). Normalize manual
entries to kg (`lbs → × 0.453592`), filter to the requested window, and merge by
date with the **manual entry winning** for that day. If the weight file is empty
or the FS is read-only, it silently falls back to `daily_metrics` only. Weight
stays in **kg** this release (canonical); unit preference is feature #4.

### Component 2 — `app/api/logs/route.ts` (additive)

Keep the existing `events` query untouched. **Additionally** query `daily_metrics`
where `metric = 'workouts'` within the same `days` window. Expand each row's
`payload` array into individual log items:

- `id`: `hkUuid` (stable; falls back to `"{date}-{index}"` if absent)
- `type`: `"workout_completed"`
- `timestamp`: the day's date at noon UTC (`{date}T12:00:00.000Z`) — `daily_metrics`
  has no exact start time; noon keeps same-day workouts grouped and correctly
  ordered relative to timestamped events
- `title`: `"{type} · {kcal} kcal"` (drop the ` · kcal` suffix when kcal absent)
- `subtitle`: `"{durationMin} min"` (rounded)

Merge into the events-derived items and sort newest-first by timestamp. iOS
`LogsViewModel` already renders `workout_completed` (run icon, indigo), so no app
change is needed.

### Component 3 — iOS

No changes. `TrendsViewModel` and `LogsViewModel` both consume the unchanged
response shapes.

## Release mechanics

Backend-only fix → effective on Fly deploy. Follow the documented tag-driven flow
(`CLAUDE.md` → Releasing):

1. Merge the fix to `main` via PR (user merges).
2. `git checkout main && git pull --ff-only origin main`.
3. Confirm `v0.2.2` is free (`git rev-parse v0.2.2` should fail).
4. Tag + push: `git tag -a v0.2.2 -m "v0.2.2 — Trends/Logs read daily_metrics" && git push origin v0.2.2`.
5. Watch `release.yml`; confirm both backend + iOS jobs are `success`.

The iOS job rebuilds the (functionally unchanged) app — harmless. Existing
installs get the fix as soon as the backend deploys.

## Verification

- `npx tsc --noEmit` clean; lint clean.
- Exercise `/api/trends?metric={hrv,sleep,weight,steps}&days=30` against a DB with
  `daily_metrics` rows → non-empty `points`, correct units (sleep in hours, weight
  in kg, hrv/steps integers).
- Exercise `/api/logs?days=30` with a `daily_metrics.workouts` row present → a
  `workout_completed` item appears with duration/kcal.
- Weight merge: with both a `body_mass_kg` row and a same-day manual `weight-log.json`
  entry, the manual value wins; lbs entries convert to kg.
- Post-deploy canary: the user's real Trends screen populates across all four
  metrics; a recent workout shows in Logs.

## Planned next (separate specs, do later)

- **#2 — Post-workout analysis + calorie suggestion:** detect a completed workout,
  analyze it (type/duration/energy), and recommend intake adjustment. New feature,
  both backend + iOS.
- **#3 — Meal-plan detail / recipes:** generate recipe/ingredient content and make
  the Today "Today's Plan" meal cards tappable into a detail view. New feature,
  both ends (`/api/today` currently returns only `{name, kcal, why}`; `MealRowView`
  is non-tappable).
- **#4 — App-wide unit unification:** persist the onboarding `units` preference
  (currently captured then discarded), expose it via profile, apply it everywhere
  weight/height is shown or entered (Trends, Profile, onboarding, logging), and add
  a settings toggle to change it later.
