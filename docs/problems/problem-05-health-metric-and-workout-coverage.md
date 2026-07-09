# Problem 05 — Missing health metrics (VO2 max, etc.) and thin workout detail

**Status:** ✅ Fixed on branch `feat/health-metrics-workout-coverage` (Phase A + B)
**Reported:** 2026-07-09
**Area:** HealthKit ingest pipeline — metric whitelist + workout DTO

**Fix applied (Phase A — metrics):** added VO₂ max (`vo2_max`), distance
(`distance_m`), exercise minutes (`exercise_min`), flights climbed (`flights`),
and resting energy (`basal_energy_kcal`) to the read authorization
(`HealthKitManager`), the backfill queries + DTO (`HealthKitBackfill`), the live
sync observers (`HealthSyncCoordinator`), the DTO (`APIClient`), and the backend
whitelist (`ingest/daily` `SCALAR_METRICS`). VO₂ max and Distance are also
surfaced in the Trends picker (`/api/trends` + iOS `TrendMetric`).

**Fix applied (Phase B — workouts):** each workout now also carries `distanceM`,
`avgHr`, `maxHr`, `paceMinPerKm`, `elevationGainM`, and `startTime`, captured
from `HKWorkout` statistics/metadata. No backend change was needed — ingest
validation accepts `Array<{ hkUuid; [key]: unknown }>` and stores the workout
payload verbatim.

**Deferred:** SpO2 / respiratory rate / HR recovery (Phase C); GPS route +
splits; converting workouts into `workout_completed` events; coach `metricLabel`
entries for the new metrics.

---

## Symptom / request

1. Important metrics like **VO2 max** (and others) aren't imported at all.
2. Synced **workouts carry only basic info** — a run shows type + duration +
   calories, but no distance, pace, or heart rate.

## What we capture today

Both the 365-day backfill and the live background sync query the **same fixed
set** — six scalar metrics + sleep + workouts:

| stored metric | HK source | note |
|---|---|---|
| `hrv_sdnn` | `.heartRateVariabilitySDNN` | discreteAverage |
| `resting_hr` | `.restingHeartRate` | discreteAverage |
| `hr_avg` | `.heartRate` | discreteAverage |
| `steps` | `.stepCount` | cumulativeSum |
| `active_energy_kcal` | `.activeEnergyBurned` | cumulativeSum |
| `body_mass_kg` | `.bodyMass` | discreteAverage |
| `sleep_minutes` (+ stages payload) | `.sleepAnalysis` | union-merged |
| `workouts` (count + payload) | `HKWorkoutType` | 4 fields each |

Whitelist locations:
- iOS backfill: `ios/Vital/Sources/Health/HealthKitBackfill.swift:79-84`
- iOS live sync: `ios/Vital/Sources/Health/HealthSyncCoordinator.swift:249-254`
- Backend accept-list: `app/api/ingest/daily/route.ts:38-45` (`SCALAR_METRICS`)

Anything not on this list is never queried, sent, or stored.

## Root cause

Deliberate **initial scoping** (Phase 4), never expanded — not a technical
limit. `daily_metrics` is a generic `(user, date, metric, value, payload)` store
(`UNIQUE(user_id, date, metric)`), so new scalar metrics need only:
1. a HealthKit query on iOS (backfill + live sync), and
2. the metric name added to the backend `SCALAR_METRICS` whitelist.

No schema change is required for new scalar metrics.

### Gap 1 — missing metrics

Not currently imported (candidate HK identifiers):
- **VO2 max** — `.vo2Max` (cardio fitness; sparse — Apple Watch estimates it
  only during outdoor walk/run, ~weekly)
- **Distance** — `.distanceWalkingRunning`, `.distanceCycling`
- **Exercise / stand minutes** — `.appleExerciseTime`, `.appleStandTime`
- **Flights climbed** — `.flightsClimbed`
- **Resting/basal energy** — `.basalEnergyBurned`
- **Respiratory rate** — `.respiratoryRate` (needs supported hardware; sparse)
- **Blood oxygen / SpO2** — `.oxygenSaturation` (hardware-dependent; sparse)
- **Walking HR avg** — `.walkingHeartRateAverage`; **HR recovery** —
  `.heartRateRecoveryOneMinute`
- (lower priority) body fat %, waist, blood pressure, mindful minutes

### Gap 2 — thin workout detail

Each workout stores only 4 fields
(`HealthKitBackfill.swift:37-43`, mapped at `:262-274`):
```swift
DailyWorkoutData(day, hkUuid, type, durationMin, kcal)
```
…serialized to the `workouts` metric's JSON **payload** verbatim
(`app/api/ingest/daily/route.ts:145-153`). Missing per workout:
- **distance** (`workout.totalDistance` / `statistics(for: .distanceWalkingRunning)`)
- **average & max heart rate** (`statistics(for: .heartRate)`)
- **pace / average speed** (derive from distance + duration, or
  `.runningSpeed`)
- **elevation gain** (`HKMetadataKeyElevationAscended` / workout metadata)
- **start time** (only the start *day* is kept today)
- (later) **GPS route** (`HKWorkoutRoute`) and **splits/laps**

Because the backend stores the workout payload as-is, enriching workouts is
largely an iOS-side DTO widening — minimal backend change (mostly validation).

Related: memory obs 2989 — workouts land in `daily_metrics` but aren't converted
into `workout_completed` events, so richer workout data also isn't surfaced to
the coach/Today event stream yet. Worth aligning if we enrich workouts.

## Proposed plan (for a fix/feature session — do NOT implement yet)

**Phase A — high-value scalar metrics (small, additive):**
Add VO2 max, distance (walking/running), exercise minutes, flights climbed,
resting/basal energy. For each: add the HK query in `HealthKitBackfill` +
`HealthSyncCoordinator`, add the name to `SCALAR_METRICS`, and (optionally)
expose in Trends' metric picker + coach `metricLabel`/tools. Handle sparse
metrics (VO2 max) gracefully — they'll have few points.

**Phase B — workout enrichment:**
Extend `DailyWorkoutData` / `DailyIngestWorkout` with distance, avg/max HR,
pace, elevation, start time. Capture from `HKWorkout` statistics. Backend
stores payload as-is; add validation for the new fields. Surface richer workout
cards in Logs/coach (and consider emitting `workout_completed` events).

**Phase C (optional/later):** SpO2, respiratory rate, HR recovery, GPS route +
splits.

### Files likely touched
- `ios/Vital/Sources/Health/HealthKitBackfill.swift` (queries + DTOs)
- `ios/Vital/Sources/Health/HealthSyncCoordinator.swift` (live-sync query set)
- `app/api/ingest/daily/route.ts` (`SCALAR_METRICS`, workout validation)
- `lib/brain/tools.ts` / Trends (`metricLabel`, metric picker) to surface them
- iOS Trends/Logs views for new metric options + richer workout cards

## Verification plan (after implementing)
- Re-sync on a device with the new metrics → confirm rows land in
  `daily_metrics` for the new metric names and (for workouts) the payload
  carries the new fields.
- Confirm sparse metrics (VO2 max) render acceptably in Trends (few points).
- Confirm no regression to the existing six metrics + sleep + workout count.
