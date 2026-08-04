import Foundation

/// Metric vs imperial. Raw values are the wire contract shared with the
/// backend's `basics.units` (onboarding) and `users.unit_system` (profile)
/// columns — `"metric"` / `"imperial"` verbatim, do not rename the cases.
enum UnitSystem: String, Codable, CaseIterable, Sendable {
    case metric
    case imperial

    /// Absorbed from the deleted `ProfileViewModel.ProfileUnitSystem.from`.
    /// `.us` maps to `.imperial`; every other `Locale.MeasurementSystem`
    /// (including `.uk`) maps to `.metric`, preserving today's behaviour.
    /// The UK commonly uses imperial for height/weight in casual speech —
    /// changing `.uk`'s mapping is a deliberate separate product decision,
    /// not something this foundation PR should silently alter.
    static func from(measurementSystem: Locale.MeasurementSystem) -> UnitSystem {
        measurementSystem == .us ? .imperial : .metric
    }

    /// The device's locale-derived default — used before any server value
    /// or explicit user choice is known.
    static var deviceDefault: UnitSystem {
        from(measurementSystem: Locale.current.measurementSystem)
    }

    var displayName: String {
        switch self {
        case .metric: return "Metric"
        case .imperial: return "Imperial"
        }
    }

    var weightUnit: String {
        switch self {
        case .metric: return "kg"
        case .imperial: return "lb"
        }
    }

    var distanceUnit: String {
        switch self {
        case .metric: return "km"
        case .imperial: return "mi"
        }
    }

    var paceUnit: String {
        switch self {
        case .metric: return "/km"
        case .imperial: return "/mi"
        }
    }
}

/// Conversion constants + pure helpers shared by every metric/imperial call
/// site. Replaces the `2.2046226218` lb-per-kg and `2.54` cm-per-inch
/// literals that used to be duplicated independently in `ProfileViewModel`
/// and `PersonalDetailsView`.
enum UnitConvert {
    static let lbPerKg = 2.2046226218
    static let cmPerInch = 2.54
    static let inchesPerFoot = 12
    static let kmPerMile = 1.609344

    static func kgToLb(_ kg: Double) -> Double { kg * lbPerKg }
    static func lbToKg(_ lb: Double) -> Double { lb / lbPerKg }
    static func cmToInches(_ cm: Double) -> Double { cm / cmPerInch }
    static func inchesToCm(_ inches: Double) -> Double { inches * cmPerInch }
    static func kmToMiles(_ km: Double) -> Double { km / kmPerMile }
    static func milesToKm(_ miles: Double) -> Double { miles * kmPerMile }

    /// A mile is `kmPerMile` km, so the time to cover one mile at a given
    /// minutes-per-km pace is `minPerKm * kmPerMile` minutes.
    static func paceKmToMile(_ minPerKm: Double) -> Double { minPerKm * kmPerMile }
}
