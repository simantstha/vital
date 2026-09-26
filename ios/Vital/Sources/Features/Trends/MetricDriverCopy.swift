import Foundation

/// Pure copy for the metric detail's "What moves your HRV" section, built
/// from one `DriverDTO` (see `APIClient.swift`) plus the input/outcome
/// display names and formatting `MetricCatalog` already owns.
///
/// `lib/insights/drivers.ts`'s own doc comment is explicit: every row here
/// is a certified ASSOCIATION the proactive insight engine already stood
/// behind (its FDR-corrected hypothesis family, confirmed across two
/// consecutive daily runs) — never a fresh statistical claim this client
/// invents. The wording below never implies causation: no "causes",
/// "because", or "leads to" — only "tends to", the sample size, and the
/// section's own "not proof of cause" footer.
enum MetricDriverCopy {

    /// Display name for a raw `daily_metrics` input key. Prefers
    /// `MetricCatalog` (covers every Trends-grid input, e.g. `steps`);
    /// falls back to a small table for the diet inputs
    /// `lib/insights/detectors.ts`'s `INPUT_METRICS` allows that never got a
    /// Trends-grid tile of their own (they're logged nutrition, not a
    /// HealthKit/WHOOP series `MetricCatalog` tracks). Never hard-codes a
    /// name `MetricCatalog` already has.
    static func inputDisplayName(_ key: String) -> String {
        MetricCatalog.spec(for: key)?.displayName ?? dietInputNames[key] ?? key
    }

    /// Unit suffix for a raw input key, same catalog-first/fallback order as
    /// `inputDisplayName(_:)`. The diet inputs are always grams/kcal — never
    /// converted by `UnitSystem`, mirroring `lib/metricCatalog.ts`'s `scale: 1`
    /// for all four.
    static func inputUnit(_ key: String, _ system: UnitSystem) -> String {
        MetricCatalog.spec(for: key)?.unit(system) ?? dietInputUnits[key] ?? ""
    }

    /// Mirrors `lib/metricCatalog.ts`'s four `dietary_*` entries — the only
    /// `INPUT_METRICS` outside `MetricCatalog.swift`'s 19 Trends-grid keys.
    private static let dietInputNames: [String: String] = [
        "dietary_energy_kcal": "Dietary Energy",
        "dietary_protein_g": "Dietary Protein",
        "dietary_carbs_g": "Dietary Carbs",
        "dietary_fat_g": "Dietary Fat",
    ]

    private static let dietInputUnits: [String: String] = [
        "dietary_energy_kcal": "kcal",
        "dietary_protein_g": "g",
        "dietary_carbs_g": "g",
        "dietary_fat_g": "g",
    ]

    /// "that day" for lag 0, "the next day" for lag 1 (and defensively for
    /// any other value — the server only ever sends 0 or 1).
    static func lagPhrase(_ lag: Int) -> String {
        lag == 1 ? "the next day" : "that day"
    }

    /// "lower" when the association is negative (`direction == "down"`),
    /// "higher" otherwise — matches `lib/insights/drivers.ts`'s own
    /// `effect < 0 ? 'down' : 'up'`, so any unrecognized string reads as
    /// "up" the same way the server's own fallback does.
    static func directionWord(_ direction: String) -> String {
        direction == "down" ? "lower" : "higher"
    }

    /// "On days with higher steps, your HRV the next day tends to be lower
    /// — 48 vs 56 ms." The comparison clause is appended only when the
    /// engine cleared its own tercile-size gate for BOTH sides (`driver.high`
    /// and `driver.low` both non-nil); the first number is always the
    /// HIGH-input side, matching this sentence's own "days with higher
    /// input" framing.
    static func sentence(
        driver: DriverDTO,
        outcomeSpec: MetricSpec?,
        unitSystem: UnitSystem
    ) -> String {
        let inputName = inputDisplayName(driver.input).lowercased()
        let outcomeName = outcomeSpec?.displayName ?? driver.input
        var text = "On days with higher \(inputName), your \(outcomeName) \(lagPhrase(driver.lag)) tends to be \(directionWord(driver.direction))"
        if let comparison = comparisonClause(driver: driver, outcomeSpec: outcomeSpec, unitSystem: unitSystem) {
            text += " — \(comparison)"
        }
        return text + "."
    }

    /// "48 vs 56 ms" — `nil` when either tercile bucket is missing (the
    /// engine's own `MIN_TERCILE_PAIRS` gate wasn't cleared on one side).
    /// The outcome's own catalog unit/decimals are used, never the input's.
    static func comparisonClause(
        driver: DriverDTO,
        outcomeSpec: MetricSpec?,
        unitSystem: UnitSystem
    ) -> String? {
        guard let high = driver.high, let low = driver.low else { return nil }
        let decimals = outcomeSpec?.decimals ?? 0
        let unit = outcomeSpec?.unit(unitSystem) ?? ""
        let highText = TrendsDeltaFormat.formattedNumber(high.mean, decimals: decimals)
        let lowText = TrendsDeltaFormat.formattedNumber(low.mean, decimals: decimals)
        return unit.isEmpty ? "\(highText) vs \(lowText)" : "\(highText) vs \(lowText) \(unit)"
    }

    /// "Based on 64 days" — the sample-size line the API's doc comment
    /// requires alongside every driver this client renders.
    static func sampleSizeLine(pairs: Int) -> String {
        "Based on \(pairs) day\(pairs == 1 ? "" : "s")"
    }

    /// The section's static footer — small, secondary text under the rows.
    static let footer = "Patterns in your own data, not proof of cause."

    /// One combined VoiceOver label per row: the sentence, then the sample
    /// size, as two separate spoken sentences.
    static func accessibilityLabel(
        driver: DriverDTO,
        outcomeSpec: MetricSpec?,
        unitSystem: UnitSystem
    ) -> String {
        "\(sentence(driver: driver, outcomeSpec: outcomeSpec, unitSystem: unitSystem)) \(sampleSizeLine(pairs: driver.pairs))."
    }
}
