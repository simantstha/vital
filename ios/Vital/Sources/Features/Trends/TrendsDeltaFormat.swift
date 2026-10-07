import Foundation

/// Shared number/delta formatting for the redesigned tile's delta line
/// ("↑ 7 above normal") and the "What moved" card's delta pill ("↑ 7 ms").
/// Both read the same `latest − mean30` a `WhatMovedRow`/tile already
/// computed — this only turns that signed `Double` into copy.
///
/// `NumberFormatter` is expensive to construct (locale/format-string
/// parsing on every allocation); every metric tile requests one on every
/// body evaluation via a fresh `NumberFormatter()`, which is the exact
/// per-render allocation the plan's performance pass calls out. Caching one
/// instance per `decimals` value (there are only a handful across the whole
/// `MetricCatalog`) turns that into a one-time cost per distinct precision.
enum TrendsDeltaFormat {
    /// "↑" for a non-negative delta (including exactly zero), "↓" otherwise
    /// — mirrors `Verdict.above`/`.below`'s own sign convention.
    static func arrow(_ delta: Double) -> String {
        delta >= 0 ? "↑" : "↓"
    }

    /// `|delta|`, rounded to `spec.decimals`, with `spec.unit(system)`
    /// appended when `includeUnit` is true and the unit isn't empty (e.g.
    /// steps/flights, which render as a bare count).
    static func magnitudeText(_ delta: Double, spec: MetricSpec, system: UnitSystem, includeUnit: Bool) -> String {
        let numberText = formattedNumber(abs(delta), decimals: spec.decimals)
        guard includeUnit else { return numberText }
        let unit = spec.unit(system)
        return unit.isEmpty ? numberText : "\(numberText) \(unit)"
    }

    /// Hero pill copy for the metric detail screen, measured against the
    /// same "normal" band the chart and range tile draw (mean30 ± sd30) —
    /// not against the mean, which made "6 above" disagree with a band edge
    /// only 3 below the value. Inside the band → "Within your normal
    /// (49–55)"; outside → distance to the nearest edge.
    static func bandPillText(value: Double, lower: Double, upper: Double, spec: MetricSpec, system: UnitSystem) -> String {
        let lo = formattedNumber(lower, decimals: spec.decimals)
        let hi = formattedNumber(upper, decimals: spec.decimals)
        if value > upper {
            let m = magnitudeText(value - upper, spec: spec, system: system, includeUnit: true)
            return "\(arrow(1)) \(m) above your normal range"
        }
        if value < lower {
            let m = magnitudeText(lower - value, spec: spec, system: system, includeUnit: true)
            return "\(arrow(-1)) \(m) below your normal range"
        }
        return "Within your normal (\(lo)–\(hi))"
    }

    private static var cachedFormatters: [Int: NumberFormatter] = [:]

    static func formattedNumber(_ value: Double, decimals: Int) -> String {
        let formatter: NumberFormatter
        if let cached = cachedFormatters[decimals] {
            formatter = cached
        } else {
            let f = NumberFormatter()
            f.numberStyle = .decimal
            f.minimumFractionDigits = 0
            f.maximumFractionDigits = decimals
            f.usesGroupingSeparator = true
            cachedFormatters[decimals] = f
            formatter = f
        }
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(decimals)f", value)
    }
}
