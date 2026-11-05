import SwiftUI

/// Pure, network-free logic behind `TrendBarChart`'s bar scaling and
/// per-bar accessibility copy — kept free of SwiftUI so it's cheap to unit
/// test exhaustively, same convention as `WeightHeroLogic`/`TrendsSummary`.
enum TrendBarChartLogic {

    /// One night's place in the goal-relative layout.
    struct Slot: Equatable {
        /// Signed whole minutes vs the goal (negative = short of it), rounded
        /// to the nearest minute. `nil` for a missing (or non-finite) night.
        let minutesVsGoal: Int?
        /// Height of the bar hanging BELOW the goal line, as a 0...1 fraction
        /// of the plot height. Zero unless the night was short of the goal.
        let shortFraction: Double
        /// Height of the bar rising ABOVE the goal line, as a 0...1 fraction
        /// of the plot height. Zero unless the night beat the goal.
        let overFraction: Double
    }

    struct Layout: Equatable {
        let slots: [Slot]
        /// Where the goal line sits, as a 0...1 fraction of the plot height
        /// measured from the TOP: 0 when every night is short (the line is
        /// the ceiling the bars hang from), growing with the biggest night
        /// that beat the goal.
        let goalLineFraction: Double
    }

    /// Smallest total span (in minutes) the plot represents, so a week whose
    /// nights are all within a few minutes of the goal doesn't blow a tiny
    /// gap up to full height.
    static let minimumSpanMinutes = 60.0

    /// Goal-relative layout: each night is its signed rounded minutes vs the
    /// goal, drawn as a bar hanging below (short) or rising above (over) a
    /// goal line. The plot spans `max(maxShort + maxOver, 60)` minutes.
    /// A non-positive (or non-finite) goal falls back to the view's 8h
    /// default rather than dividing or crashing.
    static func layout(values: [Double?], goalHours: Double) -> Layout {
        let safeGoalHours = goalHours.isFinite && goalHours > 0 ? goalHours : 8
        let goalMinutes = safeGoalHours * 60

        let deltas: [Int?] = values.map { value in
            guard let value, value.isFinite else { return nil }
            let raw = (value * 60 - goalMinutes).rounded()
            return Int(min(max(raw, -100_000), 100_000))
        }

        let maxShort = Double(deltas.compactMap { $0 }.map { max(0, -$0) }.max() ?? 0)
        let maxOver = Double(deltas.compactMap { $0 }.map { max(0, $0) }.max() ?? 0)
        let span = max(maxShort + maxOver, minimumSpanMinutes)

        let slots = deltas.map { delta -> Slot in
            guard let delta else { return Slot(minutesVsGoal: nil, shortFraction: 0, overFraction: 0) }
            return Slot(
                minutesVsGoal: delta,
                shortFraction: Double(max(0, -delta)) / span,
                overFraction: Double(max(0, delta)) / span
            )
        }
        return Layout(slots: slots, goalLineFraction: maxOver / span)
    }

    /// "\u{2212}45m", "\u{2212}1h20", "+12m", "0m" (true minus sign, U+2212).
    static func deltaLabel(minutes: Int) -> String {
        guard minutes != 0 else { return "0m" }
        let sign = minutes < 0 ? "\u{2212}" : "+"
        let magnitude = abs(minutes)
        guard magnitude >= 60 else { return "\(sign)\(magnitude)m" }
        return "\(sign)\(magnitude / 60)h\(String(format: "%02d", magnitude % 60))"
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

/// Hand-drawn 7-column, goal-relative bar chart for the Sleep summary card.
/// A solid goal line crosses the plot; a night short of the goal hangs below
/// it, a night that beat the goal rises above it, and every bar carries its
/// signed distance from the goal at its far end ("−45m", "+12m"). Scale and
/// rounding live in `TrendBarChartLogic.layout`. Only today's (last) bar is
/// `accent` — past nights are neutral — so the eye lands on one bar. A
/// missing night renders as a full-height dashed outline with no label.
/// Tapping a bar swaps its delta label for its total ("7h10"); tapping again
/// restores the delta.
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
    /// The bar whose label currently shows its total hours instead of its
    /// delta. `nil` means every bar shows its delta.
    @State private var selectedIndex: Int?

    private let plotHeight: CGFloat = 96
    private let barWidth: CGFloat = 30
    private let barRadius: CGFloat = 6
    private let minBarHeight: CGFloat = 4
    private let goalLineWidth: CGFloat = 1.2
    /// Height of the label row reserved beyond the plot's top / bottom edge
    /// so a delta label at the far end of the longest bar never clips (the
    /// chart is capped at `.xxxLarge`, where 11pt text is ~17pt tall).
    private let labelRoom: CGFloat = 20
    private let labelGap: CGFloat = 3

    private var shortThresholdHours: Double {
        TrendsSummary.shortSleepThreshold(for: goalHours)
    }
    private var todayIndex: Int { values.count - 1 }
    /// Bars render at full height immediately unless this render is meant
    /// to play the entrance (Reduce Motion always skips the grow-in).
    private var startsGrown: Bool { !animatesIn || reduceMotion }

    var body: some View {
        let layout = TrendBarChartLogic.layout(values: values, goalHours: goalHours)
        // Room above the plot only when a label sits above the goal line
        // (a night at/over the goal), below only when a bar hangs from it.
        let topRoom: CGFloat = layout.slots.contains { ($0.minutesVsGoal ?? -1) >= 0 } ? labelRoom : 0
        let bottomRoom: CGFloat = layout.slots.contains { ($0.minutesVsGoal ?? 0) < 0 } ? labelRoom : 0
        let goalY = topRoom + plotHeight * CGFloat(layout.goalLineFraction)
        let totalHeight = topRoom + plotHeight + bottomRoom

        VStack(alignment: .leading, spacing: 8) {
            // Fixed row so the caption never moves with the bars.
            Text("\(TrendsSummary.hoursLabel(goalHours))h goal")
                .scaledFont(size: 11, weight: .medium)
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            ZStack(alignment: .topLeading) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                        barColumn(
                            index: index,
                            value: value,
                            slot: index < layout.slots.count ? layout.slots[index] : nil,
                            goalY: goalY,
                            topRoom: topRoom,
                            totalHeight: totalHeight
                        )
                    }
                }
                Rectangle()
                    .fill(Theme.Colors.textPrimary)
                    .frame(height: goalLineWidth)
                    .offset(y: goalY - goalLineWidth / 2)
                    .opacity(goalLineVisible || startsGrown ? 1 : 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .frame(height: totalHeight, alignment: .top)

            HStack(spacing: 8) {
                ForEach(Array(dayLabels.enumerated()), id: \.offset) { index, label in
                    Text(label)
                        .scaledFont(size: 11, weight: index == todayIndex ? .heavy : .medium)
                        .foregroundStyle(index == todayIndex ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .sensoryFeedback(Theme.Haptics.selection, trigger: selectedIndex)
        .onAppear(perform: startEntranceIfNeeded)
        // Day / value / goal labels are positioned against fixed bar
        // geometry (labels sit a fixed gap past each bar's end), so they
        // stop growing at the largest standard size.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    // MARK: - One bar (no day label — that's its own row below, so every
    // column shares one baseline)

    private func barColumn(
        index: Int,
        value: Double?,
        slot: TrendBarChartLogic.Slot?,
        goalY: CGFloat,
        topRoom: CGFloat,
        totalHeight: CGFloat
    ) -> some View {
        let fullDayName = index < fullDayLabels.count && !fullDayLabels[index].isEmpty
            ? fullDayLabels[index]
            : (index < dayLabels.count ? dayLabels[index] : "Day \(index + 1)")
        let isToday = index == todayIndex

        return ZStack(alignment: .top) {
            if let value, let slot, let minutes = slot.minutesVsGoal {
                let isOver = minutes >= 0
                let fraction = isOver ? slot.overFraction : slot.shortFraction
                // A real (non-zero) gap never draws thinner than 4pt, so a
                // -2m night isn't a clipped sliver; 0m stays barless.
                let grownHeight = fraction > 0 ? max(plotHeight * CGFloat(fraction), minBarHeight) : 0
                let height = barsGrown || startsGrown ? grownHeight : 0
                // Bars grow outward from the goal line: a short bar's top
                // stays pinned to it, an over bar's bottom does.
                RoundedRectangle(cornerRadius: min(barRadius, height / 2), style: .continuous)
                    .fill(isToday ? Theme.Colors.accent : Theme.Colors.textTertiary.opacity(0.45))
                    .frame(width: barWidth, height: height)
                    .offset(y: isOver ? goalY - height : goalY)
                    .animation(reduceMotion ? nil : Theme.Motion.settle.delay(entranceDelay(index: index)), value: barsGrown)

                if valueLabelPopped || startsGrown {
                    let labelHeight = labelRoom - labelGap
                    Text(selectedIndex == index
                         ? TrendBarChartLogic.compactHoursLabel(value)
                         : TrendBarChartLogic.deltaLabel(minutes: minutes))
                        .scaledFont(size: 11, weight: isToday ? .heavy : .semibold)
                        .foregroundStyle(isToday ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)
                        .fixedSize()
                        .frame(height: labelHeight)
                        .offset(y: isOver
                                ? goalY - grownHeight - labelGap - labelHeight
                                : goalY + grownHeight + labelGap)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            } else {
                RoundedRectangle(cornerRadius: barRadius, style: .continuous)
                    .stroke(
                        Theme.Colors.textTertiary.opacity(0.25),
                        style: StrokeStyle(lineWidth: 1, dash: [3, 3])
                    )
                    .frame(width: barWidth, height: plotHeight)
                    .offset(y: topRoom)
            }
        }
        .frame(height: totalHeight, alignment: .top)
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

    // MARK: - Entrance motion (V5 storyboard: 180ms bars grow 30ms apart,
    // 420ms settle, 520ms goal line fades in, 640ms labels pop)

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
