import SwiftUI
import Charts

/// Trends' weight_loss-only lead card (customer-panel finding, 2026-09-23;
/// docs/ux-spec-v4.md §9's screenshot acceptance table: "Weight card first").
/// Shows the SAME smoothed trend + honesty rules as Today's weight_loss hero
/// (`WeightHeroView`/`WeightHeroLogic`) — this view reuses that pure logic
/// directly rather than duplicating the math; it never re-derives a trend or
/// a weekly rate on its own. `Today`/`Coach`/`*Hero*` files themselves are
/// untouched — only their pure logic is called from here.
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

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var trendHeadline: String { WeightHeroLogic.trendHeadline(trend: trend, system: system) }
    private var weeklyChange: String? {
        WeightHeroLogic.weeklyChangeText(trend: trend, entries: entries, system: system)
    }

    /// Mirrors `WeightHeroView.sparklinePoints` exactly (last ~30 days,
    /// established trend only) so the two cards never disagree about what
    /// "the trend line" looks like.
    private var sparklinePoints: [(day: String, value: Double)] {
        guard let trend, trend.established else { return [] }
        return trend.days.suffix(30).map { day in
            let value = system == .metric ? day.trendKg : UnitConvert.kgToLb(day.trendKg)
            return (day.day, value)
        }
    }

    private var sparklineMinSpan: Double { system == .metric ? 1.0 : 2.0 }

    private var sparklineDomain: ClosedRange<Double>? {
        WeightHeroLogic.sparklineDomain(values: sparklinePoints.map(\.value), minSpan: sparklineMinSpan)
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

    private var cardBody: some View {
        GlassCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Weight")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)

                HStack(alignment: .firstTextBaseline) {
                    Text(trendHeadline)
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .contentTransition(.numericText())
                    Spacer(minLength: Theme.Spacing.sm)
                    if let weeklyChange {
                        Text(weeklyChange)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }

                if let sparklineDomain {
                    sparkline(domain: sparklineDomain)
                        .frame(height: 48)
                }
            }
        }
    }

    /// Same newest-point scale/fade-in as `WeightHeroView.sparkline` — kept
    /// in sync so Today and Trends animate a fresh weigh-in identically.
    @State private var newestPointRevealed = false

    private func sparkline(domain: ClosedRange<Double>) -> some View {
        Chart {
            ForEach(Array(sparklinePoints.enumerated()), id: \.offset) { _, point in
                LineMark(x: .value("Day", point.day), y: .value("Trend", point.value))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)
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
        // Purely decorative — `trendHeadline`/`weeklyChange` above already
        // carry the information a VoiceOver user needs (matches
        // `WeightHeroView.sparkline`'s same call).
        .accessibilityHidden(true)
        .animation(reduceMotion ? nil : Theme.Motion.settle, value: sparklinePoints.map(\.value))
        .onAppear { newestPointRevealed = true }
        .onChange(of: sparklinePoints.count) { _, _ in
            guard !reduceMotion else { return }
            newestPointRevealed = false
            withAnimation(Theme.Motion.settle) { newestPointRevealed = true }
        }
    }

    private var accessibilityLabel: String {
        var parts = ["Weight", trendHeadline]
        if let weeklyChange { parts.append(weeklyChange) }
        return parts.joined(separator: ", ")
    }
}
