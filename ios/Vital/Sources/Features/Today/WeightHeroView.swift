import SwiftUI
import Charts

/// Today's weight_loss goal hero (docs/ux-spec-v4.md §4.1): "kcal left" as
/// the big number (the diet budget Today already loads — `FuelStripView` is
/// hidden for this goal since this card already covers calories) plus a
/// compact smoothed weight trend, current trend weight, 7-day change, and
/// the one-tap weigh-in chip (§5.3).
struct WeightHeroView: View {
    let kcalRemaining: Int
    let kcalTarget: Int
    let kcalFraction: Double
    let proteinHave: Int
    let proteinGoal: Int

    let trend: WeightTrendDTO?
    /// Raw weigh-in history — needed (alongside `trend`) for
    /// `WeightHeroLogic`'s >= 7-day span gate on the weekly-rate line.
    let entries: [WeightLogEntryDTO]
    let system: UnitSystem
    let chip: WeightHeroLogic.WeighInChip

    /// One-tap confirm (HealthKit reading present) or opens the manual sheet.
    var onChipTap: () -> Void
    var isLogging: Bool
    /// Opens the full diet-logging sheet — the hero's calorie section takes
    /// over `FuelStripView`'s tap-to-log role for this goal (§4: "the hero
    /// already covers calories"), so it must keep an equivalent entry point.
    var onOpenDiet: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var trendHeadline: String { WeightHeroLogic.trendHeadline(trend: trend, system: system) }
    private var weeklyChange: String? {
        WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: system)
    }

    /// Last ~30 days of smoothed trend points, converted to the user's unit.
    private var sparklinePoints: [(day: String, value: Double)] {
        guard let trend, trend.established else { return [] }
        return trend.days.suffix(30).map { day in
            let value = system == .metric ? day.trendKg : UnitConvert.kgToLb(day.trendKg)
            return (day.day, value)
        }
    }

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.xl) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                // Combined into one VoiceOver element (§6): the numbers read
                // as a single sensible sentence rather than four separate
                // stops. The weigh-in chip below stays OUTSIDE this combine
                // boundary so it remains its own focusable/actionable
                // element (mirrors `ActionToastView`'s message-vs-button split).
                Button(action: onOpenDiet) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        HStack(alignment: .top, spacing: Theme.Spacing.md) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(alignment: .lastTextBaseline, spacing: 4) {
                                    Text("\(max(0, kcalRemaining).formatted())")
                                        .font(.system(size: 34, weight: .bold, design: .rounded))
                                        .foregroundStyle(Theme.Colors.textPrimary)
                                        .monospacedDigit()
                                        .contentTransition(.numericText())
                                    Text("kcal left")
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(Theme.Colors.textSecondary)
                                }
                                Text("Protein \(proteinHave) / \(proteinGoal) g")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.Colors.textSecondary)
                                    .monospacedDigit()
                            }

                            Spacer(minLength: Theme.Spacing.sm)

                            VStack(alignment: .trailing, spacing: 2) {
                                Text(trendHeadline)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Theme.Colors.textPrimary)
                                    .multilineTextAlignment(.trailing)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let weeklyChange {
                                    Text(weeklyChange)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }
                        }

                        VitalProgressBar(
                            fraction: kcalFraction,
                            tint: Theme.Colors.accent,
                            height: 6
                        )
                        Text("\((kcalTarget - max(0, kcalRemaining)).formatted()) of \(kcalTarget.formatted()) kcal")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .monospacedDigit()

                        if !sparklinePoints.isEmpty {
                            sparkline
                                .frame(height: 36)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityIdentifier("today.fuelStrip")

                weighInButton
            }
        }
    }

    // MARK: - Sparkline

    private var sparkline: some View {
        Chart {
            ForEach(Array(sparklinePoints.enumerated()), id: \.offset) { _, point in
                LineMark(x: .value("Day", point.day), y: .value("Trend", point.value))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        // Purely decorative — the numeric trend/weekly-change text above
        // already carries the information a VoiceOver user needs.
        .accessibilityHidden(true)
        .animation(reduceMotion ? nil : Theme.Motion.settle, value: sparklinePoints.map(\.value))
    }

    // MARK: - Weigh-in chip

    private var weighInButton: some View {
        Button(action: onChipTap) {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "scalemass")
                    .font(.system(size: 13, weight: .semibold))
                Text(chip.title)
                    .font(.system(size: 13, weight: .semibold))
                if isLogging {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.Colors.accentContent)
                }
            }
            .foregroundStyle(Theme.Colors.accentContent)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .background(Capsule().fill(Theme.Colors.accentSoft))
        }
        .buttonStyle(.vital(scale: 0.96))
        .disabled(isLogging)
        // The `success` haptic (§6: "User-initiated log confirmed") fires
        // from `ActionToastHostModifier` when `vm.actionToast.show(...)`
        // presents the "Logged …" toast on a successful save — not
        // duplicated here.
        .accessibilityIdentifier("today.weighInChip")
    }

    // MARK: - Accessibility

    /// One combined label so VoiceOver reads the hero as a single sensible
    /// sentence rather than four separate elements (§6 accessibility note).
    private var accessibilityLabel: String {
        var parts = ["\(max(0, kcalRemaining)) kilocalories left of \(kcalTarget)"]
        parts.append("Protein \(proteinHave) of \(proteinGoal) grams")
        parts.append(trendHeadline)
        if let weeklyChange { parts.append(weeklyChange) }
        return parts.joined(separator: ". ")
    }
}
