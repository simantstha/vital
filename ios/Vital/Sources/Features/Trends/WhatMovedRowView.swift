import SwiftUI

/// One row in the "What moved" card — name, value + unit, a 96×34 mini
/// sparkline (with the normal band shaded behind it and the latest point
/// dotted), and a tinted delta pill. Pure rendering, like `MetricTileView`;
/// `TrendsView` wraps this in a `Button` for the tap/navigation.
struct WhatMovedRowView: View {
    let row: WhatMovedRow
    let unitSystem: UnitSystem

    var body: some View {
        if let spec = MetricCatalog.spec(for: row.key) {
            content(spec: spec)
        }
    }

    private var tint: Color {
        row.isGood ? Theme.Colors.positive : Theme.Colors.caution
    }

    @ViewBuilder
    private func content(spec: MetricSpec) -> some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(spec.displayName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                HStack(alignment: .lastTextBaseline, spacing: 3) {
                    Text(TrendsDeltaFormat.formattedNumber(row.value, decimals: spec.decimals))
                        .font(Theme.Typography.numericSmall(17))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    let unit = spec.unit(unitSystem)
                    if !unit.isEmpty {
                        Text(unit)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
            }

            Spacer(minLength: Theme.Spacing.sm)

            Sparkline(
                values: row.sparklineValues,
                style: spec.sparkline,
                tint: tint,
                height: 34,
                bandLower: row.mean30 - row.sd30,
                bandUpper: row.mean30 + row.sd30,
                showsLatestDot: true
            )
            .frame(width: 96, height: 34)
            .accessibilityHidden(true)

            deltaPill(spec: spec)
        }
        .padding(.vertical, Theme.Spacing.sm)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(spec: spec))
    }

    private func deltaPill(spec: MetricSpec) -> some View {
        Text("\(TrendsDeltaFormat.arrow(row.delta)) \(TrendsDeltaFormat.magnitudeText(row.delta, spec: spec, system: unitSystem, includeUnit: true))")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(tint.opacity(0.14)))
    }

    /// "HRV, 61 milliseconds, 7 above your normal, good" — same phrasing
    /// family as `MetricTileAccessibility`'s moved-tile label, so the grid
    /// tile and this card never disagree about how the same reading reads
    /// aloud.
    private func accessibilityLabel(spec: MetricSpec) -> String {
        let valueText = TrendsDeltaFormat.formattedNumber(row.value, decimals: spec.decimals)
        let unitName = spec.accessibilityUnitName(unitSystem)
        let valuePhrase = unitName.isEmpty ? valueText : "\(valueText) \(unitName)"
        let deltaText = TrendsDeltaFormat.formattedNumber(abs(row.delta), decimals: spec.decimals)
        let direction = row.delta >= 0 ? "above" : "below"
        return "\(spec.displayName), \(valuePhrase), \(deltaText) \(direction) your normal, \(row.isGood ? "good" : "to watch")"
    }
}
