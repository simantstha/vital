import SwiftUI

/// Pure, network-free logic behind `TrendBarChart`'s bar scaling and
/// per-bar accessibility copy — kept free of SwiftUI so it's cheap to unit
/// test exhaustively, same convention as `WeightHeroLogic`/`TrendsSummary`.
enum TrendBarChartLogic {

    /// The chart's y-axis ceiling (in hours): 12% above the goal, or the
    /// tallest night if that's taller — so a night that beat the goal
    /// renders as a taller bar instead of being capped flat at the top
    /// (Trends-phase-2 fix for the old `min(value / goalHours, 1.0)` cap).
    static func chartMax(values: [Double?], goalHours: Double) -> Double {
        let tallest = values.compactMap { $0 }.max() ?? 0
        let safeGoal = goalHours > 0 ? goalHours : 1
        return max(safeGoal * 1.12, tallest)
    }

    /// `value`'s height as a 0...1 fraction of `chartMax`. `chartMax <= 0`
    /// (degenerate) renders nothing rather than dividing by zero.
    static func fraction(value: Double, chartMax: Double) -> Double {
        guard chartMax > 0 else { return 0 }
        return min(max(value / chartMax, 0), 1)
    }

    /// "8h06" — hours + zero-padded minutes, no space, matching the mock's
    /// today-bar value label. Rounds to the nearest minute.
    static func compactHoursLabel(_ hours: Double) -> String {
        let totalMinutes = Int((hours * 60).rounded())
        let h = totalMinutes / 60
        let m = totalMinutes % 60
        return "\(h)h\(String(format: "%02d", m))"
    }

    /// One bar's VoiceOver label: "Monday, 7 hours 24 minutes, short night"
    /// (or without the short-night suffix once above threshold), and "no
    /// sleep synced" for a missing night — never silently skipped, since a
    /// missing night is still a real VoiceOver stop in this row.
    static func accessibilityLabel(fullDayName: String, hours: Double?, shortThresholdHours: Double) -> String {
        guard let hours else {
            return "\(fullDayName), no sleep synced"
        }
        let totalMinutes = Int((hours * 60).rounded())
        let h = totalMinutes / 60
        let m = totalMinutes % 60
        var parts = ["\(fullDayName)", "\(h) hour\(h == 1 ? "" : "s") \(m) minute\(m == 1 ? "" : "s")"]
        if hours < shortThresholdHours {
            parts.append("short night")
        }
        return parts.joined(separator: ", ")
    }
}

/// Hand-drawn 7-column bar chart for the Sleep summary card (v3/v5 mocks'
/// `Bars` component). Slim (~20pt) bars, rounded top corners only, scaled to
/// `TrendBarChartLogic.chartMax` (goal-relative, not capped at the goal) so
/// an above-goal night reads as visibly taller rather than flat. Nights
/// under `shortThresholdHours` render in the muted "short night" token
/// instead of the accent lime. A missing day renders as a full-height
/// dashed hairline outline with no fill.
///
/// The short-night cutoff comes from `TrendsSummary.shortSleepThreshold(for:)`
/// — the same helper behind the footnote copy — so the gray bars always agree
/// with the sentence under the chart.
///
/// Values are in **hours**. Both this and `TrendLineChart` take
/// `values: [Double?]` (exactly 7, oldest → newest) + `dayLabels: [String]`.
struct TrendBarChart: View {
    let values: [Double?]
    let dayLabels: [String]
    var goalHours: Double = 8.0
    /// Full weekday names, same 7 slots — VoiceOver only ("Monday" not "M").
    /// Empty (the default) falls back to the single-letter `dayLabels` so
    /// every pre-phase-2 call site/preview still reads sensibly.
    var fullDayLabels: [String] = []
    /// Trends-phase-2 index motion: true only on the render where
    /// `TrendsViewModel.hasAnimatedIn` is still `false` — see
    /// `Sparkline.animatesOnAppear`'s doc comment for the same one-shot gate.
    var animatesIn: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var barsGrown = false
    @State private var goalLineVisible = false
    @State private var valueLabelPopped = false
    /// The bar the value label currently renders above — `nil` means
    /// "today's (last) bar, the default"; tapping any other bar with data
    /// moves the label there instead, tapping it again returns to today's.
    @State private var selectedIndex: Int?

    private let chartHeight: CGFloat = 96
    private let barWidth: CGFloat = 20
    private var shortThresholdHours: Double {
        TrendsSummary.shortSleepThreshold(for: goalHours)
    }
    private var chartMax: Double {
        TrendBarChartLogic.chartMax(values: values, goalHours: goalHours)
    }
    private var todayIndex: Int { values.count - 1 }
    private var activeIndex: Int { selectedIndex ?? todayIndex }
    /// Bars render at full height immediately unless this render is meant
    /// to play the entrance (Reduce Motion always skips the grow-in).
    private var startsGrown: Bool { !animatesIn || reduceMotion }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                HStack(alignment: .bottom, spacing: 8) {
                    ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                        barColumn(index: index, value: value)
                    }
                }
                goalLine
            }
            .frame(height: chartHeight, alignment: .bottom)

            HStack(spacing: 8) {
                ForEach(Array(dayLabels.enumerated()), id: \.offset) { index, label in
                    Text(label)
                        .font(.system(size: 11, weight: index == todayIndex ? .heavy : .medium))
                        .foregroundStyle(index == todayIndex ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .sensoryFeedback(Theme.Haptics.selection, trigger: selectedIndex)
        .onAppear(perform: startEntranceIfNeeded)
    }

    // MARK: - One bar (no day label — that's its own row below, so every
    // column shares one baseline regardless of value-label overflow)

    private func barColumn(index: Int, value: Double?) -> some View {
        let fullDayName = index < fullDayLabels.count && !fullDayLabels[index].isEmpty
            ? fullDayLabels[index]
            : (index < dayLabels.count ? dayLabels[index] : "Day \(index + 1)")

        return ZStack(alignment: .bottom) {
            if let value {
                let fraction = TrendBarChartLogic.fraction(value: value, chartMax: chartMax)
                let grownHeight = chartHeight * CGFloat(fraction)
                let barShape = UnevenRoundedRectangle(
                    topLeadingRadius: 7,
                    bottomLeadingRadius: 3,
                    bottomTrailingRadius: 3,
                    topTrailingRadius: 7,
                    style: .continuous
                )
                barShape
                    .fill(value < shortThresholdHours ? Theme.Colors.chartMuted : Theme.Colors.accent)
                    .overlay {
                        // Today's bar gets the accent-content ring the mock
                        // outlines it with. `.stroke` (not `.strokeBorder`,
                        // which needs `InsettableShape`) works for any
                        // `Shape`, including `UnevenRoundedRectangle`.
                        if index == todayIndex {
                            barShape.stroke(Theme.Colors.accentContent, lineWidth: 2)
                        }
                    }
                    .frame(height: barsGrown || startsGrown ? grownHeight : 0)
                    .animation(reduceMotion ? nil : Theme.Motion.settle.delay(entranceDelay(index: index)), value: barsGrown)

                if index == activeIndex, valueLabelPopped || startsGrown {
                    Text(TrendBarChartLogic.compactHoursLabel(value))
                        .font(.system(size: 11, weight: index == todayIndex ? .heavy : .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize()
                        .offset(y: -(grownHeight + 14))
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            } else {
                UnevenRoundedRectangle(
                    topLeadingRadius: 7,
                    bottomLeadingRadius: 3,
                    bottomTrailingRadius: 3,
                    topTrailingRadius: 7,
                    style: .continuous
                )
                .stroke(
                    Theme.Colors.textTertiary.opacity(0.25),
                    style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                )
                .frame(height: chartHeight)
            }
        }
        .frame(width: barWidth)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            guard value != nil else { return }
            withAnimation(Theme.Motion.snap) {
                selectedIndex = (selectedIndex == index) ? nil : index
                valueLabelPopped = true // a manual tap always shows its label immediately
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            TrendBarChartLogic.accessibilityLabel(fullDayName: fullDayName, hours: value, shortThresholdHours: shortThresholdHours)
        )
        .accessibilityAddTraits(value != nil ? .isButton : [])
    }

    /// 30ms stagger per bar, matching the V5 storyboard.
    private func entranceDelay(index: Int) -> Double {
        Double(index) * 0.03
    }

    // MARK: - Goal line

    @ViewBuilder
    private var goalLine: some View {
        let fraction = TrendBarChartLogic.fraction(value: goalHours, chartMax: chartMax)
        VStack(alignment: .leading, spacing: 3) {
            Text("\(TrendsSummary.hoursLabel(goalHours))h goal")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Theme.Colors.textSecondary)
            DashedLine()
                .stroke(Theme.Colors.textSecondary.opacity(0.55), style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                .frame(height: 1.5)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(goalLineVisible || startsGrown ? 1 : 0)
        .offset(y: -(chartHeight * CGFloat(fraction)))
    }

    // MARK: - Entrance motion (V5 storyboard: 180ms bars grow 30ms apart,
    // 420ms settle, 520ms goal line fades in, 640ms today's label pops)

    private func startEntranceIfNeeded() {
        guard animatesIn, !reduceMotion else {
            barsGrown = true
            goalLineVisible = true
            valueLabelPopped = true
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            barsGrown = true // each bar's own `.animation(...delay:)` staggers from here
        }
        withAnimation(Theme.Motion.appear.delay(0.52)) {
            goalLineVisible = true
        }
        withAnimation(Theme.Motion.snap.delay(0.64)) {
            valueLabelPopped = true
        }
    }
}

/// A single horizontal dashed hairline, drawn as a `Shape` so `StrokeStyle`'s
/// `dash` pattern actually renders (a plain filled `Rectangle` can't dash).
private struct DashedLine: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

#Preview {
    VStack(spacing: 24) {
        TrendBarChart(
            values: [5.87, 7.13, 7.67, 5.97, 5.70, 6.20, 8.1],
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
