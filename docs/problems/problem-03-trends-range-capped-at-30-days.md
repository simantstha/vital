# Problem 03 — A year of data is stored but Trends only shows ≤30 days

**Status:** ✅ Fixed on branch `fix/barcode-decode-mismatch` (bundled into PR #33)
**Reported:** 2026-07-09
**Area:** iOS — Trends screen range picker (UI-only; backend + data are fine)

**Fix applied:**
- **3a (range cap):** range picker now offers `14 / 30 / 90 / 365` (labelled
  14d / 30d / 3M / 1Y) so the app can request the full backfilled year. The
  chart X-axis switched to `.automatic(desiredCount: 6)` with month-only labels
  above 90 days, so ticks stay legible instead of overcrowding.
- **3b (analysis, cheap path):** added an **Average** stat badge and a **trend
  chip** (first→last % change with up/down arrow) computed client-side from the
  points already fetched — no backend change. The richer "return the `baselines`
  row from `/api/trends`" path (mean7/30/60, percentiles, vs-baseline) remains
  **deferred**.

---

## Symptom

The app backfills ~365 days of HealthKit data, but the Trends charts never show
more than a month. There's no way in the UI to view a quarter / half-year / year
of history, even though "we grab 1 year of data."

## Expected

Be able to select longer ranges (e.g. 90d / 180d / 365d / "1Y") in Trends and
see the full backfilled history plotted.

## Root cause

Purely a **client UI cap**. The Trends range picker only offers 14 and 30 days,
and the view model defaults to 14 — so the app never requests more than 30 days
from an endpoint that already supports up to 365. The data exists and the backend
returns it; the UI just never asks for it.

### Evidence (files + lines)

1. **`ios/Vital/Sources/Features/Trends/TrendsViewModel.swift:47`** — default:
   ```swift
   @Published var selectedDays: Int = 14
   ```

2. **`ios/Vital/Sources/Features/Trends/TrendsView.swift:79-81`** — the only
   selectable ranges:
   ```swift
   var daysPicker: some View {
       HStack(...) {
           ForEach([14, 30], id: \.self) { days in   // ← no 90 / 180 / 365 option
   ```

3. **`TrendsViewModel.swift:75-78`** — the request just forwards `selectedDays`:
   ```swift
   let response = try await apiClient.fetchTrends(
       metric: selectedMetric.rawValue,
       days: selectedDays,   // capped at 30 because the picker never sets more
   )
   ```

4. **Backend already supports a year — `app/api/trends/route.ts:43`:**
   ```ts
   const days = Math.max(1, Math.min(365, Number(searchParams.get('days') ?? '30')));
   ```
   It reads from `daily_metrics` (the same store the 365-day backfill and
   background sync write to), so `days=365` would return up to a year of points.

5. **Backfill really does write a year — `ios/Vital/Sources/Health/BackfillCoordinator.swift:38`:**
   `static let totalDays = 365`, uploaded to `/api/ingest/daily`.

### Not the cause

- Not a data/storage problem: `daily_metrics` holds the backfilled year.
- Not a backend windowing bug: the route honors `days` up to 365.
- Not an auth/decoding problem: 14/30-day requests work; the value is simply
  never larger.

## Proposed fix (for the fix session — do NOT implement yet)

1. **Add longer ranges to the picker** in `TrendsView.swift:81`, e.g.
   `[14, 30, 90, 365]` (label 365 as "1Y"). Optionally keep the default at 30
   for a fast first paint, or add a dedicated "1Y" pill.

2. **Make the X-axis stride range-aware** — `TrendsView.swift:207` currently does
   `.stride(by: .day, count: vm.selectedDays == 14 ? 4 : 7)`. For 90/365-day
   ranges switch to week/month strides (e.g. `.month` for a year) so labels don't
   overcrowd; consider `.chartXVisibleDomain` / scrolling for dense series.

3. (Optional, perf) For a 365-point series consider light downsampling or point
   marks off at long ranges so the chart stays smooth; the `PointMark`
   (`:199-204`) at 365 points will be noisy.

### Files likely touched
- `ios/Vital/Sources/Features/Trends/TrendsView.swift` (range picker + axis stride)
- `ios/Vital/Sources/Features/Trends/TrendsViewModel.swift` (optional: default,
  and any label formatting for longer periods)
- No backend change required.

## Verification plan (after fix)
- With a backfilled account, select the longest range and confirm the chart
  plots months of history (point count ≫ 30) and the X-axis labels are legible.
- Confirm 14/30-day ranges still render as before (no regression).
- Confirm the network request carries the larger `days` value and the response
  point count matches available history.

---

## Related gap (3b) — Trends shows raw points, no analysis (average / trend vs baseline)

**Question raised:** does Trends do any analysis (average HRV, trend direction,
etc.) over the data we have? **Answer: not on the Trends screen.** The analysis
is already computed on the backend but is only surfaced through the coach chat,
never on the charts.

### What the Trends screen computes today (only this)
- **`TrendsViewModel.swift:56-59`** — `currentValue` = the last point's value
  ("Latest").
- **`TrendsViewModel.swift:61-67`** — `rangeLabel` = `min – max` of the visible
  points ("Range").
- **`TrendsView.swift:229-234`** — stats row = Latest / Range / Period only.
- **`app/api/trends/route.ts:79`** — the endpoint returns only raw
  `{ date, value }` points; no mean, no trend, no baseline delta.

No average/mean, no trend direction or slope, no "vs your normal" comparison.

### The analysis already exists (backend, coach-only)
- **`lib/brain/baselines.ts`** — `recomputeBaselines()` computes **7/30/60-day
  means, 30-day stddev, and p25/p50/p75 over a 90-day window** per (user, metric),
  upserted into the `baselines` table on every `POST /api/ingest/daily`.
- **`lib/brain/coachViz.ts`** — computes **mean, baseline (mean30) and deltaPct**
  (`:82-97`) and period-over-period comparisons (`current.mean` vs
  `previous.mean`, `:123-134`).
- Coach data-tools `get_baseline` / `compare_periods` (see
  `lib/brain/context.ts:15`) expose these in chat, not on the Trends charts.

### Proposed enhancement (fix session — do NOT implement yet)
Surface the existing analysis on the Trends screen. Two paths:
1. **Cheapest:** compute an **average** (and maybe a simple first-vs-last or
   linear-fit trend arrow) client-side in `TrendsViewModel` from the points it
   already fetches, and add an "Average" / "Trend" stat badge next to
   Latest/Range.
2. **Richer + consistent with the coach:** extend `/api/trends` (or a small new
   summary endpoint) to return the `baselines` row for the metric (mean7/30/60,
   sd30, percentiles) and render "avg", "vs 30-day baseline (±X%)", and a trend
   direction on the chart — reusing the numbers the coach already shows so the
   two surfaces agree.

### Files likely touched
- `ios/Vital/Sources/Features/Trends/TrendsViewModel.swift` (compute avg/trend)
- `ios/Vital/Sources/Features/Trends/TrendsView.swift` (stat badges / chart annotations)
- Optional backend: `app/api/trends/route.ts` (+ read from `lib/brain/baselines.ts`
  / `lib/brain/tools.ts`) to return summary stats.
