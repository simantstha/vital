import Foundation

/// Pure metric/imperial formatting statics, all taking `UnitSystem`
/// explicitly (never reading `UnitPreference.shared` directly) so every
/// function here is trivially testable. Replaces the formatting math that
/// used to be duplicated across `ProfileViewModel` and `PersonalDetailsView`.
enum UnitFormat {

    // MARK: - Weight

    /// Metric reproduces `ProfileViewModel.formatWeight`'s existing output
    /// exactly (e.g. `"62.5 kg"`); imperial reproduces `"154 lb"`.
    static func weight(kg: Double?, _ system: UnitSystem, placeholder: String = "--") -> String {
        guard let kg else { return placeholder }
        switch system {
        case .metric:
            return "\(formatNumber(kg, maximumFractionDigits: 1)) kg"
        case .imperial:
            return "\(Int(UnitConvert.kgToLb(kg).rounded())) lb"
        }
    }

    // MARK: - Height

    /// Metric reproduces `"168 cm"`; imperial reproduces `"5' 9\""`.
    static func height(cm: Double?, _ system: UnitSystem, placeholder: String = "--") -> String {
        guard let cm else { return placeholder }
        switch system {
        case .metric:
            return "\(Int(cm.rounded())) cm"
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
            return "\(formatNumber(km, maximumFractionDigits: 1)) km"
        case .imperial:
            return "\(formatNumber(UnitConvert.kmToMiles(km), maximumFractionDigits: 1)) mi"
        }
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
        guard let value = Double(
            text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        ) else {
            return nil
        }
        return system == .metric ? value : UnitConvert.lbToKg(value)
    }

    // MARK: - Private

    private static func formatNumber(_ value: Double, maximumFractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = maximumFractionDigits
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}
