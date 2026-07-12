import SwiftUI

/// A compact card showing one health metric with a label, big value, unit,
/// trend arrow, and delta text.
struct MetricTile: View {
    let label: String
    let value: String
    let unit: String
    let trend: TrendDirection
    let delta: String

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {

                Text(label)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)

                HStack(alignment: .lastTextBaseline, spacing: 2) {
                    Text(value)
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)

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
