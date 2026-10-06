import SwiftUI

/// A compact card showing one health metric with a label, big value, unit,
/// trend arrow, and delta text.
struct MetricTile: View {
    let label: String
    let value: String
    let unit: String
    let trend: TrendDirection
    let delta: String
    /// One-sentence plain-English explanation (`MetricExplainer`); when
    /// non-nil an info button sits beside the label.
    var explanation: String? = nil

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {

                HStack(spacing: 2) {
                    Text(label)
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    if let explanation {
                        Spacer(minLength: 0)
                        WhatIsThisButton(title: label, text: explanation)
                    }
                }

                HStack(alignment: .lastTextBaseline, spacing: 2) {
                    Text(value)
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                        .contentTransition(.numericText())

                    if !unit.isEmpty {
                        Text(unit)
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }

                HStack(spacing: Theme.Spacing.xxs) {
                    Image(systemName: trend.arrowSystemImage)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(trend.color)
                    Text(delta)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(trend.color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
