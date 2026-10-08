import Foundation

// MARK: - Metric group

/// Section grouping for the Trends grid index. Order here is display order
/// (`TrendsIndexSections` walks groups in exactly this sequence): the three
/// "your body today" groups first, the slow-moving body group next, WHOOP
/// fenced off last behind its own source `Chip` — see the plan's WHOOP
/// section on why `whoop_recovery` / `whoop_hrv_rmssd` never share a section
/// with their HealthKit counterparts (different device, different scale).
enum MetricGroup: String, CaseIterable, Equatable {
    case recovery
    case sleep
    case activity
    case body
    case whoop
}

// MARK: - Metric spec

/// Everything the Trends grid/detail needs to know about one raw
/// `daily_metrics` metric, independent of any single reading. The single
/// Swift source of truth for key → display name, grouping, polarity,
/// sparkline treatment, rounding, and the degenerate-σ noise floor used by
/// `TrendsVerdict`'s gate 5.
struct MetricSpec: Equatable {
    /// Raw `daily_metrics.metric` / `baselines.metric` name — the same
    /// vocabulary the batch API keys its `series` dictionary by.
    let key: String
    let displayName: String
    /// Compact label for tight spaces (tile headers, chips).
    let shortName: String
    let group: MetricGroup
    let polarity: MetricPolarity
    let sparkline: SparklineStyle
    /// Decimal places for `format(_:_:)` — mirrors the backend's
    /// `lib/metricCatalog.ts` rounding for the same metric so a value never
    /// reads with different precision server-side vs. on-device.
    let decimals: Int
    /// Absolute noise-floor fallback for `TrendsVerdict`'s degenerate-σ gate
    /// (`sd < max(minMeaningfulSD, 0.02 * abs(mean30))`), in this metric's
    /// **metric-system, pre-`displayScale`** display unit (kg, km, ms, …).
    /// Engineering judgment per metric — the plan pins the general formula
    /// and the `body_mass_kg` example (a smart scale's ~0.05kg day-to-day
    /// wobble), not every metric's exact floor.
    let minMeaningfulSD: Double
}

extension MetricSpec {
    /// Additional multiplicative factor applied on top of the value the
    /// backend already returns (which is in the metric-system display unit —
    /// kg, km — per `lib/metricCatalog.ts`). 1.0 for every metric except the
    /// two the app converts further for an imperial user: body weight
    /// (kg→lb) and distance (km→mi). Applied once, at decode, to **both**
    /// `points` and every `baseline` field (see `MetricSeries`'s doc
    /// comment) — never in a computed property.
    func displayScale(_ system: UnitSystem) -> Double {
        guard system == .imperial else { return 1.0 }
        switch key {
        case "body_mass_kg": return UnitConvert.lbPerKg
        case "distance_m":   return 1.0 / UnitConvert.kmPerMile
        default:              return 1.0
        }
    }

    /// The unit label to render alongside a formatted value. Metric-system
    /// for every metric except the two `displayScale` converts.
    func unit(_ system: UnitSystem) -> String {
        switch key {
        case "body_mass_kg": return system.weightUnit
        case "distance_m":   return system.distanceUnit
        default:              return Self.baseUnits[key] ?? ""
        }
    }

    /// Formats an already-scaled value to this metric's rounding precision,
    /// with its unit suffix (omitted for unitless counts like steps).
    func format(_ value: Double, _ system: UnitSystem) -> String {
        // Sleep reads as "5h 48m", not "5.8 h" (see `TrendsDeltaFormat.isDuration`).
        if TrendsDeltaFormat.isDuration(self) { return TrendsDeltaFormat.durationText(hours: value) }
        let formatted = String(format: "%.\(decimals)f", value)
        let unitLabel = unit(system)
        return unitLabel.isEmpty ? formatted : "\(formatted) \(unitLabel)"
    }

    /// Full-word unit name for VoiceOver labels. `unit(_:)` above renders the
    /// compact `ms`/`bpm`/`kcal` abbreviation for sighted display — a screen
    /// reader spells it out instead, so an a11y label never reuses the
    /// visual abbreviation verbatim. Empty for genuinely unitless counts
    /// (steps, flights), matching `unit(_:)`.
    func accessibilityUnitName(_ system: UnitSystem) -> String {
        switch key {
        case "body_mass_kg": return system == .imperial ? "pounds" : "kilograms"
        case "distance_m":   return system == .imperial ? "miles" : "kilometers"
        default:              return Self.accessibilityUnitNames[key] ?? ""
        }
    }

    private static let accessibilityUnitNames: [String: String] = [
        "hrv_sdnn": "milliseconds",
        "resting_hr": "beats per minute",
        "hr_avg": "beats per minute",
        "steps": "",
        "active_energy_kcal": "kilocalories",
        "vo2_max": "milliliters per kilogram per minute",
        "exercise_min": "minutes",
        "flights": "",
        "basal_energy_kcal": "kilocalories",
        "sleep_minutes": "hours",
        "whoop_day_strain": "strain",
        "whoop_recovery": "percent",
        "whoop_hrv_rmssd": "milliseconds",
        "whoop_resting_hr": "beats per minute",
        "whoop_spo2": "percent",
        "whoop_skin_temp": "degrees Celsius",
        "whoop_sleep_min": "minutes",
    ]

    /// Base (metric-system) unit labels, mirroring `lib/metricCatalog.ts`'s
    /// `displayUnit` per metric. `body_mass_kg` and `distance_m` are handled
    /// separately in `unit(_:)` since they vary by `UnitSystem`; counts
    /// (`steps`, `flights`) render with no suffix at all.
    private static let baseUnits: [String: String] = [
        "hrv_sdnn": "ms",
        "resting_hr": "bpm",
        "hr_avg": "bpm",
        "steps": "",
        "active_energy_kcal": "kcal",
        "vo2_max": "ml/kg·min",
        "exercise_min": "min",
        "flights": "",
        "basal_energy_kcal": "kcal",
        "sleep_minutes": "h",
        "whoop_day_strain": "strain",
        "whoop_recovery": "%",
        "whoop_hrv_rmssd": "ms",
        "whoop_resting_hr": "bpm",
        "whoop_spo2": "%",
        "whoop_skin_temp": "°C",
        "whoop_sleep_min": "min",
    ]
}

// MARK: - Metric catalog

/// Single source of truth for the 19 raw metrics the backend's
/// `lib/metricCatalog.ts` knows about (11 HealthKit scalars + `sleep_minutes`
/// + 7 `whoop_*`). Deliberately excludes `workouts` — a `daily_metrics` row
/// used only for the streak calculation (`lib/streak.ts`), never returned by
/// `/api/trends`, and not a metric with a meaningful σ.
///
/// Polarity: the plan explicitly pins `resting_hr` (lowerIsBetter);
/// `hrv_sdnn`, `sleep_minutes`, `steps`, `vo2_max`, `whoop_recovery`
/// (higherIsBetter); `hr_avg`, `flights`, `whoop_day_strain`,
/// `basal_energy_kcal`, `whoop_skin_temp`, and `body_mass_kg`
/// (neutral — body weight is deliberately not "lower is better", the
/// fabricated-judgment failure PR #121 already fixed once for goals like
/// muscle gain). The remaining metrics extend that pattern by their closest
/// HealthKit/WHOOP analog: `distance_m`/`exercise_min`/`active_energy_kcal`
/// mirror `steps` (higherIsBetter — more activity), `whoop_hrv_rmssd`/
/// `whoop_sleep_min`/`whoop_spo2` mirror their HealthKit counterparts
/// (higherIsBetter), and `whoop_resting_hr` mirrors `resting_hr`
/// (lowerIsBetter).
enum MetricCatalog {
    static let all: [MetricSpec] = [
        // Recovery
        MetricSpec(key: "hrv_sdnn", displayName: "HRV", shortName: "HRV", group: .recovery, polarity: .higherIsBetter, sparkline: .line, decimals: 0, minMeaningfulSD: 1.0),
        MetricSpec(key: "resting_hr", displayName: "Resting HR", shortName: "RHR", group: .recovery, polarity: .lowerIsBetter, sparkline: .line, decimals: 0, minMeaningfulSD: 1.0),
        MetricSpec(key: "hr_avg", displayName: "Average HR", shortName: "Avg HR", group: .recovery, polarity: .neutral, sparkline: .line, decimals: 0, minMeaningfulSD: 1.0),

        // Sleep
        MetricSpec(key: "sleep_minutes", displayName: "Sleep", shortName: "Sleep", group: .sleep, polarity: .higherIsBetter, sparkline: .bar, decimals: 1, minMeaningfulSD: 0.15),

        // Activity
        MetricSpec(key: "steps", displayName: "Steps", shortName: "Steps", group: .activity, polarity: .higherIsBetter, sparkline: .bar, decimals: 0, minMeaningfulSD: 200),
        MetricSpec(key: "distance_m", displayName: "Distance", shortName: "Distance", group: .activity, polarity: .higherIsBetter, sparkline: .bar, decimals: 2, minMeaningfulSD: 0.1),
        MetricSpec(key: "exercise_min", displayName: "Exercise Minutes", shortName: "Exercise", group: .activity, polarity: .higherIsBetter, sparkline: .bar, decimals: 0, minMeaningfulSD: 2),
        MetricSpec(key: "flights", displayName: "Flights Climbed", shortName: "Flights", group: .activity, polarity: .neutral, sparkline: .bar, decimals: 0, minMeaningfulSD: 1),
        MetricSpec(key: "active_energy_kcal", displayName: "Active Energy", shortName: "Active", group: .activity, polarity: .higherIsBetter, sparkline: .bar, decimals: 0, minMeaningfulSD: 15),
        MetricSpec(key: "basal_energy_kcal", displayName: "Basal Energy", shortName: "Basal", group: .activity, polarity: .neutral, sparkline: .bar, decimals: 0, minMeaningfulSD: 20),
        MetricSpec(key: "vo2_max", displayName: "VO₂ Max", shortName: "VO₂", group: .activity, polarity: .higherIsBetter, sparkline: .line, decimals: 1, minMeaningfulSD: 0.3),

        // Body
        MetricSpec(key: "body_mass_kg", displayName: "Weight", shortName: "Weight", group: .body, polarity: .neutral, sparkline: .line, decimals: 1, minMeaningfulSD: 0.15),

        // WHOOP
        MetricSpec(key: "whoop_recovery", displayName: "Recovery", shortName: "Recovery", group: .whoop, polarity: .higherIsBetter, sparkline: .line, decimals: 0, minMeaningfulSD: 2),
        MetricSpec(key: "whoop_day_strain", displayName: "Strain", shortName: "Strain", group: .whoop, polarity: .neutral, sparkline: .bar, decimals: 1, minMeaningfulSD: 0.2),
        MetricSpec(key: "whoop_hrv_rmssd", displayName: "HRV (WHOOP)", shortName: "HRV", group: .whoop, polarity: .higherIsBetter, sparkline: .line, decimals: 0, minMeaningfulSD: 1.0),
        MetricSpec(key: "whoop_resting_hr", displayName: "Resting HR (WHOOP)", shortName: "RHR", group: .whoop, polarity: .lowerIsBetter, sparkline: .line, decimals: 0, minMeaningfulSD: 1.0),
        MetricSpec(key: "whoop_sleep_min", displayName: "Sleep (WHOOP)", shortName: "Sleep", group: .whoop, polarity: .higherIsBetter, sparkline: .bar, decimals: 0, minMeaningfulSD: 5),
        MetricSpec(key: "whoop_spo2", displayName: "Blood Oxygen", shortName: "SpO₂", group: .whoop, polarity: .higherIsBetter, sparkline: .line, decimals: 1, minMeaningfulSD: 0.3),
        MetricSpec(key: "whoop_skin_temp", displayName: "Skin Temp", shortName: "Skin Temp", group: .whoop, polarity: .neutral, sparkline: .line, decimals: 1, minMeaningfulSD: 0.1),
    ]

    private static let byKey: [String: MetricSpec] = Dictionary(uniqueKeysWithValues: all.map { ($0.key, $0) })

    static func spec(for key: String) -> MetricSpec? {
        byKey[key]
    }

    /// Keys in the fixed catalog order for one group — the order
    /// `TrendsIndexSections` renders tiles within that group's section.
    static func keys(in group: MetricGroup) -> [String] {
        all.filter { $0.group == group }.map(\.key)
    }

    /// Every catalog key, in catalog (grouped, display) order — the full set
    /// of metrics the grid index requests from the batch API.
    static let indexKeys: [String] = all.map(\.key)
}

// MARK: - Plain-language explainers

/// Single catalog of one-sentence, plain-English explanations and verdict
/// lines for every metric — the copy behind the "What is this?" info button
/// (`WhatIsThisButton`) on Today's recovery tiles, the metric detail screen
/// and Trends' "What moved" card. Jargon-first labels (HRV, resting HR,
/// strain) stay as they are; this is the translation layer under them, so
/// every surface says the same thing about the same metric.
enum MetricExplainer {

    /// One sentence a non-technical user can act on. `nil` for a key this
    /// catalog doesn't know — callers simply omit the info button then.
    static func explanation(for key: String) -> String? {
        explanations[key]
    }

    private static let hrvText = "A measure of how recovered your nervous system is. Compare it to your own normal, not to other people — higher than your normal usually means well recovered."
    private static let restingHRText = "Your heart rate when fully at rest. Lower than your normal usually means you're recovered; a jump above it can mean stress, poor sleep or getting sick."
    private static let sleepText = "How long you actually slept, not just time in bed. Steady nights matter as much as the total."

    private static let explanations: [String: String] = [
        "hrv_sdnn": hrvText,
        "whoop_hrv_rmssd": hrvText,
        "resting_hr": restingHRText,
        "whoop_resting_hr": restingHRText,
        "hr_avg": "Your average heart rate across the day. It rises when you're active or stressed, so it's most useful next to your own usual.",
        "sleep_minutes": sleepText,
        "whoop_sleep_min": sleepText,
        "steps": "How much you moved today. It doesn't count intensity, so a hard workout day can still be a low-step day.",
        "distance_m": "How far you walked or ran today, from your phone and watch.",
        "exercise_min": "Minutes of brisk activity today, the kind that gets your heart rate up.",
        "flights": "Flights of stairs you climbed today. A quick way to see everyday effort.",
        "active_energy_kcal": "Calories you burned from moving, on top of what your body burns just staying alive.",
        "basal_energy_kcal": "Calories your body burns just staying alive, before any movement.",
        "vo2_max": "A fitness score for how well your body uses oxygen when you exercise. Higher is fitter, and it changes slowly.",
        "body_mass_kg": "Your weight on the scale. Day-to-day swings are mostly water, so look at the trend, not a single weigh-in.",
        "weight_trend": "A smoothed average that ignores day-to-day water swings.",
        "whoop_recovery": "WHOOP's score for how ready your body is today. Green means ready to train hard, red means take it easy.",
        "whoop_day_strain": "How much load your body took on today, on WHOOP's 0-21 scale. Higher means a bigger day, and that's fine when you've recovered.",
        "whoop_spo2": "The share of oxygen in your blood overnight. It's normally steady, so only a clear drop from your own normal matters.",
        "whoop_skin_temp": "Your overnight skin temperature. A clear rise above your normal can be an early sign your body is fighting something.",
    ]

    /// A short, plain verdict to sit directly under a metric's big number,
    /// e.g. "Above your normal — you're well recovered". `nil` while
    /// calibrating or with no data (the still-learning card covers those),
    /// so it never claims a judgment the verdict gates haven't earned.
    static func verdictLine(for key: String, verdict: Verdict) -> String? {
        let polarity = MetricCatalog.spec(for: key)?.polarity ?? .neutral
        switch verdict {
        case .calibrating, .noData:
            return nil
        case .normal:
            return "Right in your normal range — nothing unusual"
        case .above:
            return aboveLine(key: key, polarity: polarity)
        case .below:
            return belowLine(key: key, polarity: polarity)
        }
    }

    private static func aboveLine(key: String, polarity: MetricPolarity) -> String {
        switch key {
        case "hrv_sdnn", "whoop_hrv_rmssd": return "Above your normal — you're well recovered"
        case "sleep_minutes", "whoop_sleep_min": return "Above your normal — you slept more than usual"
        case "steps", "distance_m", "exercise_min", "active_energy_kcal": return "Above your normal — a more active day than usual"
        default: break
        }
        switch polarity {
        case .higherIsBetter: return "Above your normal — a good sign"
        case .lowerIsBetter: return "Above your normal — your body may be under extra strain"
        case .neutral: return "Above your normal — higher than usual for you"
        }
    }

    private static func belowLine(key: String, polarity: MetricPolarity) -> String {
        switch key {
        case "hrv_sdnn", "whoop_hrv_rmssd": return "Below your normal — your body could use extra rest"
        case "sleep_minutes", "whoop_sleep_min": return "Below your normal — you slept less than usual"
        case "steps", "distance_m", "exercise_min", "active_energy_kcal": return "Below your normal — a quieter day than usual"
        default: break
        }
        switch polarity {
        case .higherIsBetter: return "Below your normal — worth keeping an eye on"
        case .lowerIsBetter: return "Below your normal — a good sign"
        case .neutral: return "Below your normal — lower than usual for you"
        }
    }
}

// MARK: - New-user calibration copy

/// Shared wording for "baselines are still building" so Today, Profile,
/// Trends and metric detail all lead with what already works today and put
/// the 14-day wait in context — never "0 of 14 days" on its own, which new
/// users read as "the app is useless for two weeks".
/// The ONE "days collected toward the 14-day baseline" number, shared by
/// Today's calibration card, Trends' "Getting to know your normal" ring and
/// Profile's percent. It is the smallest `dataDays` across the three
/// recovery metrics in the API's `calibration` block, clamped to 0...14 —
/// the same field `/api/today` and `/api/trends` both send.
enum CalibrationProgress {
    static let totalDays = 14
    static let metricKeys = ["hrv_sdnn", "resting_hr", "sleep_minutes"]

    static func daysDone(_ calibration: CalibrationStatus?) -> Int {
        guard let calibration else { return 0 }
        let smallest = metricKeys.map { calibration.metrics[$0]?.dataDays ?? 0 }.min() ?? 0
        return min(max(smallest, 0), totalDays)
    }

    static func fraction(_ calibration: CalibrationStatus?) -> Double {
        Double(daysDone(calibration)) / Double(totalDays)
    }
}

enum CalibrationCopy {
    static let totalDays = 14

    static let todayTitle = "Getting to know your normal"

    /// "Calorie, weight and workout tracking work today. Recovery insights
    /// get personal after 14 days of data (2 of 14)."
    static func todayBody(daysCollected: Int) -> String {
        let done = min(max(daysCollected, 0), totalDays)
        return "Calorie, weight and workout tracking work today. Recovery insights get personal after \(totalDays) days of data (\(done) of \(totalDays))."
    }

    /// Trends' "Getting to know your normal" card body. `daysRemaining == 0` means
    /// enough calendar history but not enough real variation yet.
    static func trendsBody(daysRemaining: Int) -> String {
        guard daysRemaining > 0 else {
            return "Your tracking works as usual. Recovery insights need a bit more variety in your data before they get personal."
        }
        let done = min(max(totalDays - daysRemaining, 0), totalDays)
        return "Calorie, weight and workout tracking work today. Recovery insights get personal after \(totalDays) days of data (\(done) of \(totalDays))."
    }
}
