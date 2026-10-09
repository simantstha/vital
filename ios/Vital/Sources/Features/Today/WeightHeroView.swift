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
    /// Goal target weight (kg) from goal progress, or `nil` — draws a dashed
    /// target line and a "Target" caption under the sparkline.
    var targetKg: Double? = nil
    /// Goal-progress 4-week rate (kg/wk, signed). When present the hero shows it
    /// ("over 4 weeks") so it agrees with the goal card below.
    var goalRateKgPerWeek: Double? = nil
    let chip: WeightHeroLogic.WeighInChip

    /// One-tap confirm (HealthKit reading present) or opens the manual sheet.
    var onChipTap: () -> Void
    var isLogging: Bool
    /// Opens the full diet-logging sheet — the hero's calorie section takes
    /// over `FuelStripView`'s tap-to-log role for this goal (§4: "the hero
    /// already covers calories"), so it must keep an equivalent entry point.
    var onOpenDiet: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var trendHeadline: String? { WeightHeroLogic.heroHeaderTrendText(trend: trend, system: system) }
    private var weeklyChange: String? {
        WeightHeroLogic.weeklyChangeText(
            trend: trend, entries: entries, system: system, goalRateKgPerWeek: goalRateKgPerWeek
        )
    }

    /// Last ~30 days of smoothed trend points, converted to the user's unit.
    private var sparklinePoints: [(day: String, value: Double)] {
        guard let trend, trend.established else { return [] }
        return trend.days.suffix(30).map { day in
            let value = system == .metric ? day.trendKg : UnitConvert.kgToLb(day.trendKg)
            return (day.day, value)
        }
    }

    /// Enforces a floor on the visible range (1.0 kg / 2.0 lb) so a stable
    /// weight over the window doesn't get zoomed in so far that sub-100g
    /// noise reads as a dramatic swing — see `WeightHeroLogic.sparklineDomain`.
    private var sparklineMinSpan: Double { system == .metric ? 1.0 : 2.0 }

    /// `nil` hides the chart entirely (empty `sparklinePoints`) — screenshot-
    /// review fix, 2026-09-23: Swift Charts includes 0 in a numeric y-domain
    /// by default, which pins an ~82 kg trend to the very top of the frame
    /// and reads as a flat divider line rather than a chart.
    private var sparklineLayout: WeightHeroLogic.SparklineLayout? {
        WeightHeroLogic.sparklineLayout(values: sparklinePoints.map(\.value), minSpan: sparklineMinSpan, target: targetDisplayValue)
    }

    /// The trend column sits trailing beside the kcal figure, or leading
    /// underneath it at accessibility sizes.
    private var trendColumnAlignment: HorizontalAlignment {
        dynamicTypeSize.isAccessibilitySize ? .leading : .trailing
    }
    private var trendTextAlignment: TextAlignment {
        dynamicTypeSize.isAccessibilitySize ? .leading : .trailing
    }

    /// Target weight in the user's unit, matching `sparklinePoints`.
    private var targetDisplayValue: Double? {
        guard let targetKg else { return nil }
        return system == .metric ? targetKg : UnitConvert.kgToLb(targetKg)
    }

    /// Dashed target line's y position — true value when near the trend,
    /// otherwise a compressed marker near the chart's edge (see
    /// `WeightHeroLogic.sparklineLayout`).
    private var drawnTargetValue: Double? { sparklineLayout?.targetLine }

    /// "→" (to scale), "↓"/"↑" (compressed: the goal is far beyond the chart).
    private var targetArrow: String {
        WeightHeroLogic.sparklineTargetArrow(
            layout: sparklineLayout, targetKg: targetKg, lastKg: trend?.days.last?.trendKg
        )
    }

    /// "Start 83.7 kg … Now 82 kg → Goal 76 kg" captions (kg-based inputs,
    /// formatted in the user's unit).
    private var sparklineCaptions: (start: String, now: String, target: String?)? {
        guard let trend, trend.established else { return nil }
        let days = trend.days.suffix(30)
        return WeightHeroLogic.sparklineCaptions(
            firstKg: days.first?.trendKg, lastKg: days.last?.trendKg, targetKg: targetKg, system: system
        )
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
                        // Accessibility sizes stack the trend column under the
                        // kcal figure instead of squeezing both into one row.
                        AccessibilityAdaptiveStack(alignment: .top, spacing: Theme.Spacing.md, stackedSpacing: Theme.Spacing.sm) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(alignment: .lastTextBaseline, spacing: 4) {
                                    Text("\(max(0, kcalRemaining).formatted())")
                                        .scaledFont(size: 34, weight: .bold, design: .rounded)
                                        .foregroundStyle(Theme.Colors.textPrimary)
                                        .monospacedDigit()
                                        .contentTransition(.numericText(value: Double(max(0, kcalRemaining))))
                                        // Hero number: cap growth so a 4-digit
                                        // figure still fits the card at AX5.
                                        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                                    Text("kcal left")
                                        .scaledFont(size: 15, weight: .semibold)
                                        .foregroundStyle(Theme.Colors.textSecondary)
                                }
                                Text("Protein \(proteinHave) / \(proteinGoal) g")
                                    .scaledFont(size: 13)
                                    .foregroundStyle(Theme.Colors.textSecondary)
                                    .monospacedDigit()
                                    .contentTransition(.numericText())
                            }

                            if !dynamicTypeSize.isAccessibilitySize {
                                Spacer(minLength: Theme.Spacing.sm)
                            }

                            VStack(alignment: trendColumnAlignment, spacing: 2) {
                                if let trendHeadline {
                                    Text(trendHeadline)
                                        .scaledFont(size: 13, weight: .semibold)
                                        .foregroundStyle(Theme.Colors.textPrimary)
                                        .multilineTextAlignment(trendTextAlignment)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .contentTransition(.numericText())
                                }
                                if let weeklyChange {
                                    Text(weeklyChange)
                                        .scaledFont(size: 12)
                                        .foregroundStyle(Theme.Colors.textSecondary)
                                        .multilineTextAlignment(trendTextAlignment)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }

                        VitalProgressBar(
                            fraction: kcalFraction,
                            tint: Theme.Colors.accent,
                            height: 6
                        )
                        Text("\((kcalTarget - max(0, kcalRemaining)).formatted()) of \(kcalTarget.formatted()) kcal")
                            .scaledFont(size: 11)
                            .foregroundStyle(Theme.Colors.textTertiary)
                            .monospacedDigit()
                            .contentTransition(.numericText())

                        if let layout = sparklineLayout {
                            sparkline(domain: layout.domain)
                                .frame(height: 36)
                            if let captions = sparklineCaptions {
                                AccessibilityAdaptiveStack(spacing: Theme.Spacing.xs, stackedSpacing: Theme.Spacing.xxs) {
                                    Text(captions.start)
                                    Spacer(minLength: 0)
                                    Text(captions.now)
                                    // Goal sits at the trailing edge, after "Now", so it
                                    // reads as where the trend is heading — not a centred
                                    // orphan under a line with no target marker.
                                    if let target = captions.target {
                                        Text("\(targetArrow) \(target)")
                                            .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : Theme.Spacing.md)
                                    }
                                }
                                .scaledFont(size: 11)
                                .foregroundStyle(Theme.Colors.textTertiary)
                                .monospacedDigit()
                                .accessibilityIdentifier("today.weightHero.sparklineCaptions")
                            }
                        }
                    }
                }
                .buttonStyle(.pressableCard)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityIdentifier("today.fuelStrip")

                weighInButton
            }
        }
    }

    // MARK: - Sparkline

    /// Scale/fade-in for the newest trend point after a weigh-in — starts
    /// small+transparent and springs up whenever a new point count arrives.
    /// `false` under Reduce Motion, so the point is simply present at full
    /// size (no line-extend cue at all, matching `MotionTransition`'s "no
    /// large movement" rule).
    @State private var newestPointRevealed = false

    private func sparkline(domain: ClosedRange<Double>) -> some View {
        Chart {
            ForEach(Array(sparklinePoints.enumerated()), id: \.offset) { _, point in
                LineMark(x: .value("Day", point.day), y: .value("Trend", point.value))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)
            }
            if let target = drawnTargetValue {
                RuleMark(y: .value("Target", target))
                    .foregroundStyle(Theme.Colors.textTertiary)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
            if let last = sparklinePoints.last {
                PointMark(x: .value("Day", last.day), y: .value("Trend", last.value))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .symbolSize(reduceMotion || newestPointRevealed ? 26 : 26 * 0.6)
                    .opacity(reduceMotion || newestPointRevealed ? 1 : 0)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: domain)
        .chartLegend(.hidden)
        // Purely decorative — the numeric trend/weekly-change text above
        // already carries the information a VoiceOver user needs.
        .accessibilityHidden(true)
        .animation(reduceMotion ? nil : Theme.Motion.settle, value: sparklinePoints.map(\.value))
        .onAppear { newestPointRevealed = true }
        .onChange(of: sparklinePoints.count) { _, _ in
            guard !reduceMotion else { return }
            newestPointRevealed = false
            withAnimation(Theme.Motion.settle) { newestPointRevealed = true }
        }
    }

    // MARK: - Weigh-in chip

    private var weighInButton: some View {
        Button(action: onChipTap) {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "scalemass")
                    .scaledFont(size: 13, weight: .semibold)
                Text(chip.title)
                    .scaledFont(size: 13, weight: .semibold)
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
        if let trendHeadline { parts.append(trendHeadline) }
        if let weeklyChange { parts.append(weeklyChange) }
        if let captions = sparklineCaptions {
            parts.append([captions.start, captions.now, captions.target].compactMap { $0 }.joined(separator: ", "))
        }
        return parts.joined(separator: ". ")
    }
}
