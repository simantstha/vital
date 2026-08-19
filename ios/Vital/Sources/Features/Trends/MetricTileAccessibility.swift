import Foundation

/// Pure composition of a `MetricTileView`'s single combined VoiceOver label
/// — e.g. "HRV, 52 milliseconds, above your normal" — so a tile reads as one
/// swipe stop instead of four separate nodes (name, value, chip, sparkline).
/// No SwiftUI import, so the string composition here is independently
/// testable; `MetricTileView` only calls `label(tile:spec:unitSystem:)`.
/// `formattedValue`/`verdictPhrase` are also reused by
/// `MetricChartAccessibility` for the detail view's chart summary, so the
/// two never disagree about how a value or a verdict reads aloud.
enum MetricTileAccessibility {
    static func label(tile: TrendsTile, spec: MetricSpec?, unitSystem: UnitSystem) -> String {
        let name = spec?.displayName ?? tile.key
        switch tile.content {
        case .dimmed(let lastDate):
            return "\(name), \(lastSyncedPhrase(lastDate))"
        case .sparse(let value, let readingCount):
            let valueText = formattedValue(value, spec: spec, unitSystem: unitSystem)
            let readings = readingCount == 1 ? "1 reading" : "\(readingCount) readings"
            return "\(name), \(valueText), \(readings)"
        case .chart(let value, _, let verdict):
            let valueText = formattedValue(value, spec: spec, unitSystem: unitSystem)
            return "\(name), \(valueText), \(verdictPhrase(verdict))"
        }
    }

    /// Mirrors `TrendsVerdict`'s "never surface σ to UI copy" rule — same
    /// wording family as `MetricDetailView.verdictLineText`, just without a
    /// trailing scrub-date suffix.
    static func verdictPhrase(_ verdict: Verdict) -> String {
        switch verdict {
        case .above: return "above your normal"
        case .below: return "below your normal"
        case .normal: return "in your normal range"
        case .calibrating(let daysRemaining):
            return daysRemaining > 0
                ? "\(daysRemaining) more day\(daysRemaining == 1 ? "" : "s") until your normal range is known"
                : "not enough variation yet to know your normal range"
        case .noData:
            return "no data yet"
        }
    }

    static func formattedValue(_ value: Double, spec: MetricSpec?, unitSystem: UnitSystem) -> String {
        let decimals = spec?.decimals ?? 0
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = decimals
        formatter.usesGroupingSeparator = true
        let numberText = formatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(decimals)f", value)
        guard let unitName = spec?.accessibilityUnitName(unitSystem), !unitName.isEmpty else { return numberText }
        return "\(numberText) \(unitName)"
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f
    }()

    private static func lastSyncedPhrase(_ date: Date?) -> String {
        guard let date else { return "last synced unknown" }
        return "last synced " + relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}
