import SwiftUI

/// The Trends grid index's headline strip — one `GlassCard`: "THIS WEEK", a
/// 3-up row (sleep avg / HRV / resting HR), the existing goal-aware
/// `TrendBarChart` 7-night sleep week, and a two-tone data-driven footnote.
/// Consumes `TrendsSummary`'s existing pure helpers (unchanged — see that
/// file's "file move only" note in the Trends revamp plan); this view owns
/// only layout. The two-tone footnote renderer is intentionally local here
/// rather than promoted to DesignSystem — it had exactly one call site
/// before this rewrite (the deleted `TrendSummaryCard`) and still does.
struct WeeklyHeadlineStrip: View {
    @ObservedObject var vm: TrendsViewModel

    private var sleepGoalHours: Double { Double(vm.sleepGoalMinutes) / 60.0 }

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text("THIS WEEK")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(Theme.Colors.textSecondary)

                threeUpRow

                TrendBarChart(
                    values: vm.sleepWindow.values,
                    dayLabels: vm.sleepWindow.dayLabels,
                    goalHours: sleepGoalHours
                )

                footnoteView
            }
        }
    }

    private var threeUpRow: some View {
        HStack(spacing: 0) {
            headlineStat(value: vm.sleepValueText, label: "sleep avg")
            headlineStat(value: vm.hrvValueText, unit: "ms", label: "hrv")
            headlineStat(value: vm.rhrValueText, unit: "bpm", label: "resting hr")
        }
    }

    private func headlineStat(value: String, unit: String? = nil, label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(Theme.Typography.numericLarge(22))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let unit {
                    Text(unit)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Two-tone footnote (extracted from the deleted `TrendSummaryCard`)

    @ViewBuilder
    private var footnoteView: some View {
        let footnote = TrendsSummary.sleepFootnote(vm.sleepWindow.values, goalHours: sleepGoalHours)
        if let bold = footnote.bold {
            (
                Text(footnote.prefix).foregroundStyle(Theme.Colors.textSecondary)
                + Text(bold).foregroundStyle(Theme.Colors.textPrimary).fontWeight(.semibold)
                + Text(footnote.suffix).foregroundStyle(Theme.Colors.textSecondary)
            )
            .font(.system(size: 13))
        } else {
            Text(footnote.prefix)
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }
}
