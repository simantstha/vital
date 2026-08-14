import Foundation

/// Whether a rising value is good, bad, or neither for a given metric.
/// Drives `TrendDirection.resolve` so the trend chip's color reflects the
/// metric's meaning instead of always tinting "up" the same as "improving"
/// (the metric-blind chip bug — rising resting HR is not the same as rising
/// HRV, and `body_mass_kg` / `steps` / `whoop_day_strain` have no inherent
/// "better" direction at all).
enum MetricPolarity {
    case higherIsBetter
    case lowerIsBetter
    case neutral
}

extension TrendDirection {
    /// Resolves a metric's polarity + observed direction into the concrete
    /// `TrendDirection` (arrow + color) to render.
    static func resolve(_ polarity: MetricPolarity, rising: Bool) -> TrendDirection {
        switch polarity {
        case .higherIsBetter:
            return rising ? .upGood : .downBad
        case .lowerIsBetter:
            return rising ? .upBad : .downGood
        case .neutral:
            return rising ? .upNeutral : .downNeutral
        }
    }
}
