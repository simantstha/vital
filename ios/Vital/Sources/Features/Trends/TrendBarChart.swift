import SwiftUI

/// Hand-drawn 7-column bar chart for the Sleep summary card (v3 mock's
/// `Bars` component). Each bar's height is `value / goalHours` of the chart
/// area, capped at 1.0; nights under `shortThresholdHours` render in the
/// muted "short night" token instead of the accent lime. A missing day
/// renders as a full-height dashed hairline outline with no fill.
///
/// Values are in **hours**. Both this and `TrendLineChart` take
/// `values: [Double?]` (exactly 7, oldest → newest) + `dayLabels: [String]`.
struct TrendBarChart: View {
    let values: [Double?]
    let dayLabels: [String]
    var goalHours: Double = TrendsSummary.sleepGoalHours
    var shortThresholdHours: Double = TrendsSummary.sleepShortThresholdHours

    private let chartHeight: CGFloat = 62

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                VStack(spacing: 8) {
                    ZStack(alignment: .bottom) {
                        if let value {
                            let fraction = min(max(value / goalHours, 0), 1.0)
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(
                                    value < shortThresholdHours
                                        ? Theme.Colors.chartMuted
                                        : Theme.Colors.accent
                                )
                                .frame(height: chartHeight * CGFloat(fraction))
                        } else {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(
                                    Theme.Colors.textTertiary.opacity(0.25),
                                    style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                                )
                                .frame(height: chartHeight)
                        }
                    }
                    .frame(height: chartHeight, alignment: .bottom)

                    Text(index < dayLabels.count ? dayLabels[index] : "")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

#Preview {
    VStack(spacing: 24) {
        TrendBarChart(
            values: [5.87, 7.13, 7.67, 5.97, 5.70, 6.20, 6.10],
            dayLabels: ["F", "S", "S", "M", "T", "W", "T"]
        )
        TrendBarChart(
            values: [nil, nil, 7.67, 5.97, nil, 6.20, 6.10],
            dayLabels: ["F", "S", "S", "M", "T", "W", "T"]
        )
    }
    .padding()
    .background(Theme.Colors.canvas)
}
