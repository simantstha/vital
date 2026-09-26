import SwiftUI
import Charts

/// Pure, network-free logic behind `TrendsWeightCard`'s rate pill and
/// subline copy — kept free of SwiftUI so it's cheap to unit test
/// exhaustively (same convention as `WeightHeroLogic`/`TrendsSummary`).
/// Both functions reuse `WeightHeroLogic`'s existing honesty gates
/// (`established`, `daySpan`/`minimumSpanDaysForWeeklyRate`) — neither
/// re-derives the trend/rate math itself, only its presentation.
enum TrendsWeightCardLogic {

    enum PillTone: Equatable {
        case positive, caution, neutral
    }

    struct RatePill: Equatable {
        let text: String
        let tone: PillTone
    }

    /// Cached DateFormatter for parsing "yyyy-MM-dd" format dates.
    /// Uses en_US_POSIX locale and UTC timezone for consistent parsing.
    private static let chartDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(abbreviation: "UTC")
        return f
    }()

    /// Parses a date string in "yyyy-MM-dd" format or longer ISO timestamp.
    /// For longer timestamps (e.g., "2026-09-01T10:30:00Z"), takes the first 10 characters.
    /// Returns `nil` if parsing fails.
    static func chartDate(_ isoDay: String) -> Date? {
        let dayString = isoDay.count > 10 ? String(isoDay.prefix(10)) : isoDay
        return chartDayFormatter.date(from: dayString)
    }

    /// "↓ 0.6 kg/wk" tinted `.positive` (weight_loss: a loss is progress
    /// toward the goal), "↑ 0.3 kg/wk" tinted `.caution` (a gain is moving
    /// away from it), or "→ 0.0 kg/wk" tinted `.neutral` for a flat week.
    /// `nil` under the exact same gate `WeightHeroLogic.weeklyChangeText`
    /// uses (established trend + >= 7-day entry span) — this card only ever
    /// renders for the weight_loss goal (see `TrendsView.showsWeightCard`),
    /// so "down is good" is a safe, non-configurable assumption here.
    static func ratePill(trend: WeightTrendDTO?, entries: [WeightLogEntryDTO], system: UnitSystem) -> RatePill? {
        guard let trend, trend.established else { return nil }
        guard let span = WeightHeroLogic.daySpan(entries: entries),
              span >= WeightHeroLogic.minimumSpanDaysForWeeklyRate else { return nil }
        guard let deltaPerWeek = trend.delta7dKgPerWeek ?? trend.delta30dKgPerWeek else { return nil }

        let displayValue = system == .metric ? deltaPerWeek : UnitConvert.kgToLb(deltaPerWeek)
        let rounded = roundedToOneDecimal(displayValue)
        let magnitude = String(format: "%.1f", abs(rounded))
        let arrow = rounded < 0 ? "↓" : (rounded > 0 ? "↑" : "→")
        let tone: PillTone = rounded < 0 ? .positive : (rounded > 0 ? .caution : .neutral)
        return RatePill(text: "\(arrow) \(magnitude) \(system.weightUnit)/wk", tone: tone)
    }

    /// "−3.1 kg since 28 Aug" — the total change between the first and last
    /// plotted trend points (the same values the chart draws), dated with
    /// the first plotted day's label. Always shows a sign (including a bare
    /// "+0.0"/"−0.0" normalized to "0.0") so a genuinely flat window reads
    /// as the honest zero it is, matching `UnitFormat.weightDelta`'s
    /// sign convention.
    static func sublineText(firstValue: Double, lastValue: Double, firstDayLabel: String, system: UnitSystem) -> String {
        let rounded = roundedToOneDecimal(lastValue - firstValue)
        let sign = rounded < 0 ? "\u{2212}" : (rounded > 0 ? "+" : "")
        let magnitude = String(format: "%.1f", abs(rounded))
        return "\(sign)\(magnitude) \(system.weightUnit) since \(firstDayLabel)"
    }

    /// Same `-0.0` → `0.0` normalization as `UnitFormat`'s private helper of
    /// the same name — duplicated here (rather than exposed from
    /// `UnitFormat`) since it's a two-line, dependency-free rounding rule.
    private static func roundedToOneDecimal(_ value: Double) -> Double {
        let rounded = (value * 10).rounded() / 10
        return rounded == 0 ? 0 : rounded
    }
}

/// Trends' weight_loss-only lead card (customer-panel finding, 2026-09-23;
/// docs/ux-spec-v4.md §9's screenshot acceptance table: "Weight card first").
/// Shows the SAME smoothed trend + honesty rules as Today's weight_loss hero
/// (`WeightHeroView`/`WeightHeroLogic`) — this view reuses that pure logic
/// directly rather than duplicating the math; it never re-derives a trend or
/// a weekly rate on its own. `Today`/`Coach`/`*Hero*` files themselves are
/// untouched — only their pure logic is called from here.
///
/// Trends-phase-2: no goal-weight caption/line — the app has no target-
/// weight field anywhere in its DTOs (`WeightLogResponse`/`DietBudgetDTO`),
/// so the mock's "goal 78 kg"/dashed goal rule are simply omitted rather
/// than fabricated; every other element (raw weigh-in dots, gridlines,
/// start/end date labels, halo) still ships.
struct TrendsWeightCard: View {
    let trend: WeightTrendDTO?
    /// Needed alongside `trend` for `WeightHeroLogic.weeklyChangeText`'s
    /// >= 7-day span gate — same honesty rule as the Today hero.
    let entries: [WeightLogEntryDTO]
    let system: UnitSystem
    /// `nil` when weight has no metric-detail destination to open — the card
    /// then renders as a plain, non-interactive `GlassCard` instead of a
    /// `Button`.
    var onTap: (() -> Void)?
    /// Trends-phase-2 index motion: true only on the render where
    /// `TrendsViewModel.hasAnimatedIn` is still `false` — see
    /// `Sparkline.animatesOnAppear`'s doc comment for the same one-shot gate.
    var animatesIn: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var trendHeadline: String { WeightHeroLogic.trendHeadline(trend: trend, system: system) }
    private var ratePill: TrendsWeightCardLogic.RatePill? {
        TrendsWeightCardLogic.ratePill(trend: trend, entries: entries, system: system)
    }

    /// Split from `trendHeadline`'s combined "Trend 82.0 kg" into the two
    /// pieces the big number display needs — reuses `UnitFormat.weight`'s
    /// existing rounding/conversion (never re-derives it) and just parses
    /// its output apart on the space between number and unit.
    private var latestWeightParts: (magnitude: String, unit: String)? {
        guard let trend, trend.established, let latest = trend.days.last else { return nil }
        let formatted = UnitFormat.weight(kg: latest.trendKg, system)
        guard let spaceIndex = formatted.firstIndex(of: " ") else { return (formatted, "") }
        return (String(formatted[formatted.startIndex..<spaceIndex]), String(formatted[formatted.index(after: spaceIndex)...]))
    }

    /// Mirrors `WeightHeroView.sparklinePoints` exactly (last ~30 days,
    /// established trend only) so the two cards never disagree about what
    /// "the trend line" looks like. Each point includes the parsed Date for chart x-axis.
    private var sparklinePoints: [(day: String, date: Date?, value: Double)] {
        guard let trend, trend.established else { return [] }
        return trend.days.suffix(30).map { day in
            let value = system == .metric ? day.trendKg : UnitConvert.kgToLb(day.trendKg)
            let date = TrendsWeightCardLogic.chartDate(day.day)
            return (day.day, date, value)
        }
    }

    /// Raw daily weigh-ins within the plotted trend window, faint dots
    /// behind the smoothed line — the mock's "individual readings" layer.
    /// Multiple entries on the same day all plot (a scale can be logged
    /// more than once); never averaged or deduped, since these are
    /// decorative context for the trend line, not a second trend.
    private var rawEntryPoints: [(day: String, date: Date?, value: Double)] {
        guard let firstDayDate = sparklinePoints.first?.date else { return [] }
        // Parse each entry once, then filter and sort
        let parsedEntries = entries.compactMap { entry -> (day: String, date: Date, value: Double)? in
            guard let date = TrendsWeightCardLogic.chartDate(entry.date) else { return nil }
            let value = system == .metric ? entry.weight : UnitConvert.kgToLb(entry.weight)
            return (entry.date, date, value)
        }
        return parsedEntries
            .filter { $0.date >= firstDayDate }
            .sorted { $0.date < $1.date }
            .map { (day: $0.day, date: Optional($0.date), value: $0.value) }
    }

    private var sparklineMinSpan: Double { system == .metric ? 1.0 : 2.0 }

    private var sparklineDomain: ClosedRange<Double>? {
        let allValues = sparklinePoints.map(\.value) + rawEntryPoints.map(\.value)
        return WeightHeroLogic.sparklineDomain(values: allValues, minSpan: sparklineMinSpan)
    }

    private var sublineText: String? {
        guard sparklinePoints.count >= 2,
              let first = sparklinePoints.first, let last = sparklinePoints.last else { return nil }
        return TrendsWeightCardLogic.sublineText(
            firstValue: first.value,
            lastValue: last.value,
            firstDayLabel: Self.shortDateLabel(first.day),
            system: system
        )
    }

    var body: some View {
        if let onTap {
            // Mirrors `WeightHeroView`'s combined-Button pattern exactly
            // (modifiers applied directly on the `Button`, not a wrapping
            // `Group`) so this surfaces as `app.buttons["trends.weightCard"]`
            // in XCUITest the same way `today.fuelStrip` does.
            Button(action: onTap) { cardBody }
                .buttonStyle(TilePressStyle())
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityIdentifier("trends.weightCard")
        } else {
            cardBody
                .accessibilityElement(children: .combine)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityIdentifier("trends.weightCard")
        }
    }

    // Trends-phase-2: the solid `VitalCard` surface, matching the redesigned
    // grid tiles (`MetricTileView`) — not the translucent `GlassCard` the
    // pre-phase-2 card used.
    private var cardBody: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Weight")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)

                if let parts = latestWeightParts {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(parts.magnitude)
                                .font(.system(size: 34, weight: .bold, design: .rounded))
                                .foregroundStyle(Theme.Colors.textPrimary)
                                .contentTransition(.numericText())
                            if !parts.unit.isEmpty {
                                Text(parts.unit)
                                    .font(.system(size: 15))
                                    .foregroundStyle(Theme.Colors.textSecondary)
                            }
                        }
                        if let ratePill {
                            pillView(ratePill)
                        }
                        Spacer(minLength: 0)
                    }
                } else {
                    Text(trendHeadline)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }

                if let sublineText {
                    Text(sublineText)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }

                if let sparklineDomain {
                    chart(domain: sparklineDomain)
                        .frame(height: 130)
                        .padding(.top, Theme.Spacing.xs)
                }
            }
        }
    }

    private func pillView(_ pill: TrendsWeightCardLogic.RatePill) -> some View {
        Text(pill.text)
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(pillColor(pill.tone))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Capsule().fill(pillColor(pill.tone).opacity(0.12)))
    }

    private func pillColor(_ tone: TrendsWeightCardLogic.PillTone) -> Color {
        switch tone {
        case .positive: return Theme.Colors.positive
        case .caution:  return Theme.Colors.caution
        case .neutral:  return Theme.Colors.textSecondary
        }
    }

    // MARK: - Chart (raw dots + smoothed line + gridlines + date labels)

    /// Same newest-point scale/fade-in as `WeightHeroView.sparkline` — kept
    /// in sync so Today and Trends animate a fresh weigh-in identically.
    @State private var newestPointRevealed = false
    /// Trends-phase-2: the trend line "draws in" on first appearance via a
    /// left-to-right wipe mask (native `.scaleEffect`/`.mask` interpolates
    /// smoothly under `withAnimation`; a `Chart`'s own marks don't animate
    /// per-frame on their own). `1` by default so a non-animating render
    /// (Reduce Motion, or after the first load) shows the full line.
    @State private var lineRevealFraction: CGFloat = 1

    private func chart(domain: ClosedRange<Double>) -> some View {
        // Extract all parsed dates to compute safe x-domain bounds.
        // Using compactMap avoids the crash risk of fallback Date() values.
        let dates = sparklinePoints.compactMap(\.date)
        let now = Date()
        let xDomain: ClosedRange<Date> = (dates.min() ?? now)...(dates.max() ?? now)

        return Chart {
            ForEach(Array(rawEntryPoints.enumerated()), id: \.offset) { _, point in
                if let date = point.date {
                    PointMark(x: .value("Day", date, unit: .day), y: .value("Reading", point.value))
                        .foregroundStyle(Theme.Colors.textTertiary.opacity(0.55))
                        .symbolSize(14)
                }
            }
            ForEach(Array(sparklinePoints.enumerated()), id: \.offset) { _, point in
                if let date = point.date {
                    LineMark(x: .value("Day", date, unit: .day), y: .value("Trend", point.value))
                        .foregroundStyle(Theme.Colors.accentContent)
                        .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.catmullRom)
                }
            }
            if let last = sparklinePoints.last, let date = last.date {
                PointMark(x: .value("Day", date, unit: .day), y: .value("Trend", last.value))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .symbolSize(reduceMotion || newestPointRevealed ? 34 : 34 * 0.6)
                    .opacity(reduceMotion || newestPointRevealed ? 1 : 0)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in
                AxisGridLine().foregroundStyle(Theme.Colors.glassBorder)
                AxisValueLabel().font(.system(size: 10)).foregroundStyle(Theme.Colors.textTertiary)
            }
        }
        .chartYScale(domain: domain)
        .chartXScale(domain: xDomain)
        .chartLegend(.hidden)
        // Purely decorative — `trendHeadline`/`ratePill`/`sublineText` above
        // already carry the information a VoiceOver user needs (matches
        // `WeightHeroView.sparkline`'s same call).
        .accessibilityHidden(true)
        .mask(alignment: .leading) {
            Rectangle().scaleEffect(x: lineRevealFraction, y: 1, anchor: .leading)
        }
        .overlay(alignment: .bottom) { dateLabelsRow }
        .animation(reduceMotion ? nil : Theme.Motion.settle, value: sparklinePoints.map(\.value))
        .onAppear(perform: startChartAnimationIfNeeded)
        .onChange(of: sparklinePoints.count) { _, _ in
            guard !reduceMotion else { return }
            newestPointRevealed = false
            withAnimation(Theme.Motion.settle) { newestPointRevealed = true }
        }
    }

    private func startChartAnimationIfNeeded() {
        guard animatesIn, !reduceMotion else {
            newestPointRevealed = true
            lineRevealFraction = 1
            return
        }
        newestPointRevealed = false
        lineRevealFraction = 0
        withAnimation(.easeOut(duration: 0.6)) { lineRevealFraction = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            withAnimation(Theme.Motion.settle) { newestPointRevealed = true }
        }
    }

    /// Start/end date labels under the chart (the mock's "28 Aug" / "Today"
    /// row) — a plain overlay rather than a native `chartXAxis`, since only
    /// the two endpoints need a label, not every plotted day.
    @ViewBuilder
    private var dateLabelsRow: some View {
        if let first = sparklinePoints.first?.day {
            HStack {
                Text(Self.shortDateLabel(first))
                Spacer()
                Text("Today")
            }
            .font(.system(size: 10))
            .foregroundStyle(Theme.Colors.textTertiary)
            .offset(y: 14)
        }
    }

    // MARK: - Date formatting ("yyyy-MM-dd" → "28 Aug")

    private static let isoDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let shortDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "d MMM"
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    private static func shortDateLabel(_ isoDay: String) -> String {
        guard let date = isoDayFormatter.date(from: isoDay) else { return isoDay }
        return shortDateFormatter.string(from: date)
    }

    private var accessibilityLabel: String {
        var parts = ["Weight", trendHeadline]
        if let ratePill { parts.append(ratePill.text) }
        if let sublineText { parts.append(sublineText) }
        return parts.joined(separator: ", ")
    }
}
