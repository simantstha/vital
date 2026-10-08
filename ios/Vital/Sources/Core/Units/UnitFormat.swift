import Foundation

/// Pure metric/imperial formatting statics, all taking `UnitSystem`
/// explicitly (never reading `UnitPreference.shared` directly) so every
/// function here is trivially testable. Replaces the formatting math that
/// used to be duplicated across `ProfileViewModel` and `PersonalDetailsView`.
enum UnitFormat {

    /// U+00A0. Every user-facing "number + unit" string built here joins the
    /// two with a NON-BREAKING space, so a narrow row (Profile's Goal row,
    /// goal-sheet stats, a toast) can wrap BETWEEN tokens but never strand the
    /// unit on its own line ("30" / "km/wk"). Entry-field text
    /// (`weightEntryText`, `distanceEntryText`) stays bare digits, no unit.
    static let nbsp = "\u{00A0}"

    // MARK: - Weight

    /// Metric reproduces `ProfileViewModel.formatWeight`'s existing output
    /// (e.g. `"62.5 kg"`) and imperial `"154 lb"`, with a non-breaking space
    /// (`nbsp`) between the number and the unit.
    static func weight(kg: Double?, _ system: UnitSystem, placeholder: String = "--") -> String {
        guard let kg else { return placeholder }
        switch system {
        case .metric:
            return "\(formatNumber(kg, maximumFractionDigits: 1))\(nbsp)kg"
        case .imperial:
            return "\(Int(UnitConvert.kgToLb(kg).rounded()))\(nbsp)lb"
        }
    }

    /// The weight-trend hero's "−0.4 kg this week" line (§4.1). `kgPerWeek`
    /// is the server's `delta7dKgPerWeek`/`delta30dKgPerWeek` (already
    /// kg/week — never re-divide by 7). Always shows exactly 1 decimal in
    /// both systems (`"−1.0"`, not `"−1"`; `"0.0"`, not `"0"`) so a
    /// near-zero rate (e.g. -0.04 kg/wk) reads as the honest "0.0" it
    /// rounds to rather than collapsing to a bare, unit-less-looking "0",
    /// and a whole-number rate ("−1.0") stays visually consistent with
    /// every other rate on the same line. The sign is derived from the
    /// ROUNDED value (never the raw one) so a value that rounds to zero
    /// (e.g. -0.04) never prints as "−0.0" — and is written explicitly
    /// (U+2212 minus, matching the rest of the trend UI) rather than
    /// relying on the formatter's default hyphen-minus. Zero gets no sign.
    static func weightDelta(kgPerWeek: Double, _ system: UnitSystem) -> String {
        let value = system == .metric ? kgPerWeek : UnitConvert.kgToLb(kgPerWeek)
        let rounded = roundedToOneDecimal(value)
        let sign = rounded < 0 ? "\u{2212}" : (rounded > 0 ? "+" : "")
        let magnitude = String(format: "%.1f", abs(rounded))
        return "\(sign)\(magnitude)\(nbsp)\(system.weightUnit)/wk"
    }

    /// Same sign/rounding as `weightDelta`, without the repeated unit
    /// letters — for copy that already states the unit once nearby, e.g.
    /// the weigh-in toast's "Logged · trend 82.1 kg (−0.4/wk)".
    static func weightDeltaCompact(kgPerWeek: Double, _ system: UnitSystem) -> String {
        let value = system == .metric ? kgPerWeek : UnitConvert.kgToLb(kgPerWeek)
        let rounded = roundedToOneDecimal(value)
        let sign = rounded < 0 ? "\u{2212}" : (rounded > 0 ? "+" : "")
        let magnitude = String(format: "%.1f", abs(rounded))
        return "\(sign)\(magnitude)/wk"
    }

    /// Rounds to 1 decimal place, normalizing `-0.0` to `0.0` first — Swift's
    /// `.rounded()` preserves the sign of a value that rounds to zero (e.g.
    /// `(-0.4).rounded()` is `-0.0`, not `0.0`), and `-0.0 < 0` is `false`
    /// but `String(format: "%.1f", -0.0)` still prints `"-0.0"`. Comparing
    /// `-0.0 == 0` is `true` (IEEE 754), so reassigning the literal `0`
    /// (positive zero) here is what actually clears the sign bit.
    private static func roundedToOneDecimal(_ value: Double) -> Double {
        let rounded = (value * 10).rounded() / 10
        return rounded == 0 ? 0 : rounded
    }

    // MARK: - Height

    /// Metric reproduces `"168 cm"` (non-breaking space before the unit);
    /// imperial reproduces `"5' 9\""`.
    static func height(cm: Double?, _ system: UnitSystem, placeholder: String = "--") -> String {
        guard let cm else { return placeholder }
        switch system {
        case .metric:
            return "\(Int(cm.rounded()))\(nbsp)cm"
        case .imperial:
            let parts = heightParts(cm: cm)
            return "\(parts.feet)' \(parts.inches)\""
        }
    }

    /// Rounds TOTAL INCHES before splitting into feet/inches, so
    /// `182.88cm` → `(6, 0)` — never `(5, 12)` from rounding a feet quotient
    /// and an inches remainder independently.
    static func heightParts(cm: Double) -> (feet: Int, inches: Int) {
        let totalInches = Int(UnitConvert.cmToInches(cm).rounded())
        return (totalInches / UnitConvert.inchesPerFoot, totalInches % UnitConvert.inchesPerFoot)
    }

    static func cm(fromFeet feet: Int, inches: Int) -> Double {
        UnitConvert.inchesToCm(Double(feet * UnitConvert.inchesPerFoot + inches))
    }

    // MARK: - Distance

    static func distance(metres: Double?, _ system: UnitSystem, placeholder: String = "--") -> String {
        guard let metres else { return placeholder }
        return distance(km: metres / 1000, system, placeholder: placeholder)
    }

    static func distance(km: Double?, _ system: UnitSystem, placeholder: String = "--") -> String {
        guard let km else { return placeholder }
        switch system {
        case .metric:
            return "\(formatNumber(km, maximumFractionDigits: 1))\(nbsp)km"
        case .imperial:
            return "\(formatNumber(UnitConvert.kmToMiles(km), maximumFractionDigits: 1))\(nbsp)mi"
        }
    }

    /// Seeds/round-trips an editable weekly-distance field: up to one decimal
    /// in the user's unit (whole numbers unadorned), empty when `km` is nil.
    static func distanceEntryText(km: Double?, _ system: UnitSystem) -> String {
        guard let km else { return "" }
        let value = system == .metric ? km : UnitConvert.kmToMiles(km)
        let rounded = (value * 10).rounded() / 10
        return rounded.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(rounded))
            : String(format: "%.1f", rounded)
    }

    /// Parses the text a user typed into a distance field (accepting `,` as a
    /// decimal separator) in `system`'s unit and converts it to km for the
    /// API. Returns nil for unparseable input.
    static func km(fromDistanceEntry text: String, _ system: UnitSystem) -> Double? {
        guard let value = entryNumber(text) else { return nil }
        return system == .metric ? value : UnitConvert.milesToKm(value)
    }

    // MARK: - Pace

    /// Keeps the `seconds == 60` carry from the pre-existing
    /// `AnalysisView.paceLabel` so metric output stays byte-identical to
    /// today (`5.999 min/km` → `"6′00″"`). Imperial multiplies minutes-per-km
    /// by `kmPerMile` first, then applies the same carry.
    static func pace(minPerKm: Double, _ system: UnitSystem) -> String {
        let value = system == .metric ? minPerKm : UnitConvert.paceKmToMile(minPerKm)
        var wholeMinutes = Int(value)
        var seconds = Int(((value - Double(wholeMinutes)) * 60).rounded())
        if seconds == 60 { wholeMinutes += 1; seconds = 0 }
        return "\(wholeMinutes)′\(String(format: "%02d", seconds))″"
    }

    // MARK: - Energy

    /// "1,850" — a whole number with the locale's thousands separator, the
    /// same grouping Today's budget text gets from `Int.formatted()`, so
    /// Profile's "Daily budget" and the Logs day header never print "1850"
    /// next to Today's "1,850". `locale` is injectable for tests.
    static func kcalNumber(_ value: Int, locale: Locale = .current) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    /// "1,850 kcal" (non-breaking space), or `placeholder` when `value` is nil.
    static func kcal(_ value: Int?, locale: Locale = .current, placeholder: String = "--") -> String {
        guard let value else { return placeholder }
        return "\(kcalNumber(value, locale: locale))\(nbsp)kcal"
    }

    // MARK: - Editable entry-field text (PersonalDetailsView-style editors)

    /// Seeds/round-trips an editable weight text field: metric shows up to
    /// one decimal (whole numbers unadorned), imperial shows whole lb.
    static func weightEntryText(kg: Double?, _ system: UnitSystem) -> String {
        guard let kg else { return "" }
        switch system {
        case .metric:
            let rounded = (kg * 10).rounded() / 10
            return rounded.truncatingRemainder(dividingBy: 1) == 0
                ? String(Int(rounded))
                : String(format: "%.1f", rounded)
        case .imperial:
            return String(Int(UnitConvert.kgToLb(kg).rounded()))
        }
    }

    /// Parses the text a user typed into a weight field (accepting `,` as a
    /// decimal separator) and converts it to kg for the API. Returns nil for
    /// unparseable input.
    static func kg(fromEntry text: String, _ system: UnitSystem) -> Double? {
        guard let value = entryNumber(text) else { return nil }
        return system == .metric ? value : UnitConvert.lbToKg(value)
    }

    // MARK: - Private

    /// Shared by both entry parsers: tolerates a pasted non-breaking space
    /// (the formatted outputs above use one) and `,` as the decimal separator.
    private static func entryNumber(_ text: String) -> Double? {
        Double(
            text.replacingOccurrences(of: nbsp, with: "")
                .trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: ",", with: ".")
        )
    }

    private static func formatNumber(_ value: Double, maximumFractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = maximumFractionDigits
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}
