/**
 * Vital — shared change-detection thresholds (pure, no DB import).
 *
 * This module is CONFIG ONLY. It is not, and must never become, a second
 * verdict rule:
 *  - The per-day verdict (is today's reading notable?) lives in Swift,
 *    `ios/Vital/Sources/Features/Trends/TrendsVerdict.swift`. Swift cannot
 *    import this module and does NOT read anything from here: it holds its
 *    own independent copies of these constants, hardcoded as literals — `14`
 *    in gate 2 (the `dataDays >= 14` calibration check) and `0.02` in gate 5
 *    (`sd30 >= max(minMeaningfulSD, 0.02 * abs(mean30))`) — and takes
 *    `minMeaningfulSD` as a parameter fed from `MetricCatalog.swift`. The
 *    only thing keeping the two languages in sync is the drift-guard test in
 *    metricThresholds.test.ts, which parses the Swift source off disk and
 *    fails if the values diverge. Change a number here and you must change
 *    it in Swift too.
 *  - Multi-day statistical significance (is a run of days a real trend?)
 *    lives in `lib/insights/` (`lib/insights/stats.ts`), which does
 *    Benjamini-Hochberg FDR control across metrics — genuinely different
 *    math from a single-day z-score gate, not something to fold in here.
 *  - This file exists solely because `lib/brain/baselines.ts` imports `@/db`
 *    (and throws at module load without DATABASE_URL), so anything that
 *    needs `ESTABLISHED_MIN_DAYS` or the noise-floor constants without a DB
 *    connection — `lib/trendsResponse.ts`, tests, future callers — has one
 *    place to import them from instead of hand-copying the numbers.
 *
 * MIN_MEANINGFUL_SD and METRIC_DIRECTION are ported from the Swift catalog
 * (`MetricCatalog.swift`'s `minMeaningfulSD` and `polarity` fields) and
 * converted to **storage units** (`lib/metricCatalog.ts`'s `scale`), since
 * this file is consumed server-side where values are still in storage units.
 * The drift guard in metricThresholds.test.ts reads the Swift source
 * directly and fails the build if the two catalogs disagree.
 *
 * Coverage gap (deliberate): the four `dietary_*` metrics
 * (`dietary_energy_kcal`, `dietary_protein_g`, `dietary_carbs_g`,
 * `dietary_fat_g`) exist in `lib/metricCatalog.ts` but have no Swift
 * MetricCatalog entry yet — nobody has made an engineering judgment call on
 * their noise floor or polarity. They are deliberately OMITTED from both
 * tables below rather than inventing a floor. Any caller must treat a
 * missing `MIN_MEANINGFUL_SD` / `METRIC_DIRECTION` entry as "no verdict" —
 * never fall back to a guessed default.
 */

/** Trailing-90-day data-day count required for a metric baseline to count as "established". */
export const ESTABLISHED_MIN_DAYS = 14;

/**
 * Relative noise floor: a metric's sd30 is "degenerate" (too small to trust
 * for a verdict) if it's below `max(MIN_MEANINGFUL_SD[metric], RELATIVE_SD_FLOOR * abs(mean30))`.
 * Mirrors the literal `0.02` in TrendsVerdict.swift's gate-5 formula.
 */
export const RELATIVE_SD_FLOOR = 0.02;

/**
 * Absolute noise-floor fallback per metric, in **storage units**
 * (`daily_metrics.value` / `baselines.stats` units — see lib/metricCatalog.ts).
 * Ported from Swift's `minMeaningfulSD` (display units) via
 * `storage = display / METRIC_CATALOG[metric].scale`.
 *
 * Only two metrics have a non-1 scale, so only two values differ from the
 * Swift source:
 *  - sleep_minutes: Swift 0.15 h, scale 1/60 → 0.15 / (1/60) = 9 minutes
 *  - distance_m:    Swift 0.1 km, scale 1/1000 → 0.1 / (1/1000) = 100 metres
 * Every other metric has scale 1, so its storage-unit floor equals Swift's
 * display-unit value verbatim.
 */
export const MIN_MEANINGFUL_SD: Record<string, number> = {
  hrv_sdnn: 1.0,
  resting_hr: 1.0,
  hr_avg: 1.0,
  sleep_minutes: 9, // 0.15h / (1/60 scale) — see comment above
  steps: 200,
  distance_m: 100, // 0.1km / (1/1000 scale) — see comment above
  exercise_min: 2,
  flights: 1,
  active_energy_kcal: 15,
  basal_energy_kcal: 20,
  vo2_max: 0.3,
  body_mass_kg: 0.15,
  whoop_recovery: 2,
  whoop_day_strain: 0.2,
  whoop_hrv_rmssd: 1.0,
  whoop_resting_hr: 1.0,
  whoop_sleep_min: 5,
  whoop_spo2: 0.3,
  whoop_skin_temp: 0.1,
};

/**
 * Direction of "better" per metric, ported verbatim from Swift's
 * `polarity:` field (unit-independent, so no conversion needed).
 */
export const METRIC_DIRECTION: Record<string, 'higherIsBetter' | 'lowerIsBetter' | 'neutral'> = {
  hrv_sdnn: 'higherIsBetter',
  resting_hr: 'lowerIsBetter',
  hr_avg: 'neutral',
  sleep_minutes: 'higherIsBetter',
  steps: 'higherIsBetter',
  distance_m: 'higherIsBetter',
  exercise_min: 'higherIsBetter',
  flights: 'neutral',
  active_energy_kcal: 'higherIsBetter',
  basal_energy_kcal: 'neutral',
  vo2_max: 'higherIsBetter',
  body_mass_kg: 'neutral',
  whoop_recovery: 'higherIsBetter',
  whoop_day_strain: 'neutral',
  whoop_hrv_rmssd: 'higherIsBetter',
  whoop_resting_hr: 'lowerIsBetter',
  whoop_sleep_min: 'higherIsBetter',
  whoop_spo2: 'higherIsBetter',
  whoop_skin_temp: 'neutral',
};
