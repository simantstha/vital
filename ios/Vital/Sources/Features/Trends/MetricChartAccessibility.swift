import SwiftUI
import Accessibility

// MARK: - Summary label/value (pure — no Accessibility framework types)

/// Pure composition of `MetricDetailView`'s chart accessibility summary: the
/// `.accessibilityLabel` (metric, selected range, latest reading, 30-day
/// mean, and gated verdict) and the `.accessibilityValue` shown while
/// scrubbing. No SwiftUI/Charts/Accessibility import, so the string
/// composition here is independently testable. Never surfaces σ, mirroring
/// `TrendsVerdict`'s rule (`MetricTileAccessibility.verdictPhrase` is the
/// single place a `Verdict` becomes spoken words).
enum MetricChartAccessibility {
    static func summaryLabel(
        metricName: String,
        rangeLabel: String,
        latest: Double?,
        mean30: Double?,
        spec: MetricSpec?,
        unitSystem: UnitSystem,
        verdict: Verdict
    ) -> String {
        var parts = ["\(metricName) chart, last \(rangeLabel)"]
        if let latest {
            parts.append("latest \(MetricTileAccessibility.formattedValue(latest, spec: spec, unitSystem: unitSystem))")
        }
        if let mean30 {
            parts.append("30 day average \(MetricTileAccessibility.formattedValue(mean30, spec: spec, unitSystem: unitSystem))")
        }
        parts.append(MetricTileAccessibility.verdictPhrase(verdict))
        return parts.joined(separator: ", ")
    }

    static func scrubbedValueText(date: Date, value: Double, spec: MetricSpec?, unitSystem: UnitSystem) -> String {
        "\(dayFormatter.string(from: date)): \(MetricTileAccessibility.formattedValue(value, spec: spec, unitSystem: unitSystem))"
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f
    }()
}

// MARK: - Per-point Audio Graph descriptor

/// VoiceOver's per-point Audio Graph surface for `MetricDetailView`'s chart
/// (`.accessibilityChartDescriptor`) — without this, a Swift Chart with
/// dozens of marks is a single opaque image to VoiceOver. Built from the
/// exact `chartPoints` the visual chart draws (never `rawPoints`), so a
/// swipe-through of the graph and the on-screen line can never disagree
/// about which points exist. `updateChartDescriptor(_:)` is left at its
/// `AXChartDescriptorRepresentable` default (a no-op) — this type carries no
/// mutable state, so there's nothing to patch onto a previous descriptor;
/// SwiftUI just asks `makeChartDescriptor()` again on the next render.
struct MetricChartDescriptor: AXChartDescriptorRepresentable {
    let points: [ChartPoint]
    let metricName: String
    let spec: MetricSpec?
    let unitSystem: UnitSystem
    let yDomain: ClosedRange<Double>

    func makeChartDescriptor() -> AXChartDescriptor {
        let dates = points.map(\.date)
        let minDate = dates.min() ?? Date()
        let maxSeconds = max(
            (dates.max() ?? minDate).timeIntervalSinceReferenceDate,
            minDate.timeIntervalSinceReferenceDate + 1
        )

        let xAxis = AXNumericDataAxisDescriptor(
            title: "Date",
            range: minDate.timeIntervalSinceReferenceDate...maxSeconds,
            gridlinePositions: []
        ) { value in
            Self.axisDateFormatter.string(from: Date(timeIntervalSinceReferenceDate: value))
        }

        let decimals = spec?.decimals ?? 0
        let unitName = spec?.accessibilityUnitName(unitSystem)
        let yAxis = AXNumericDataAxisDescriptor(
            title: metricName,
            range: yDomain,
            gridlinePositions: []
        ) { value in
            let text = String(format: "%.\(decimals)f", value)
            guard let unitName, !unitName.isEmpty else { return text }
            return "\(text) \(unitName)"
        }

        let series = AXDataSeriesDescriptor(
            name: metricName,
            isContinuous: true,
            dataPoints: points.map { point in
                AXDataPoint(
                    x: point.date.timeIntervalSinceReferenceDate,
                    y: point.value,
                    label: Self.axisDateFormatter.string(from: point.date)
                )
            }
        )

        return AXChartDescriptor(
            title: metricName,
            summary: nil,
            xAxis: xAxis,
            yAxis: yAxis,
            additionalAxes: [],
            series: [series]
        )
    }

    private static let axisDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()
}
