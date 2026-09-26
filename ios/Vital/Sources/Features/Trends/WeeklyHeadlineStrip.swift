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
                // Trends-phase-2: sentence case, matches `TrendsWeightCard`'s
                // "Weight" header treatment — replaces the old
                // uppercase-tracked "THIS WEEK" label.
                Text("Sleep this week")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)

                threeUpRow

                TrendBarChart(
                    values: vm.sleepWindow.values,
                    dayLabels: vm.sleepWindow.dayLabels,
                    goalHours: sleepGoalHours,
                    fullDayLabels: vm.sleepWindow.fullDayLabels,
                    // Not `vm.hasAnimatedIn`: `sleepWindow` loads via the
                    // separate `loadSummary()` call, which by design can
                    // finish after `load()` has already flipped
                    // `hasAnimatedIn` true (see `TrendsWeightCard`'s same
                    // note in `TrendsView`) — this card's own `@State`-gated
                    // `onAppear` in `TrendBarChart` already plays the
                    // entrance exactly once per session instead.
                    animatesIn: true
                )

                footnoteView
            }
        }
        // Stable UI-test hook: this is the topmost recovery-related content
        // Trends renders (sleep/HRV/RHR, above every metric-group section) —
        // `TrendsGoalOrdering`'s "weight card first" screenshot assertion
        // needs a unique element to compare frames against. `"HRV"` alone
        // isn't unique — `MetricTileView`'s recovery tile renders the same
        // text lower on the same screen, and querying `.frame` on an
        // ambiguous match is a hard XCUITest failure (see #200).
        //
        // `.accessibilityElement(children: .contain)` MUST come before
        // `.accessibilityIdentifier` here (#200 round 2): without it, an
        // identifier on a plain container view doesn't make the container
        // itself one queryable element — it's simply inherited by every
        // accessible descendant (the sleep/HRV/RHR `Text`s), so
        // `app.otherElements["trends.recoveryFirst"]` matched several
        // elements and `.frame` hard-failed again. `.contain` (as opposed to
        // `.combine`, which `TrendsWeightCard`/`WeightHeroView` use because
        // they want ONE spoken label) makes this card itself one
        // accessibility element while still exposing its children as their
        // own elements underneath it — VoiceOver still reads "sleep avg",
        // "hrv", "resting hr" individually, this identifier just also
        // resolves to exactly one (the container) XCUIElement.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trends.recoveryFirst")
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

    /// Trends-phase-2: `Text` `+` concatenation is deprecated — the two-tone
    /// footnote is built as one `AttributedString` instead, with the bold
    /// span's color/weight set as attributes on just that range.
    private var footnoteView: Text {
        let footnote = TrendsSummary.sleepFootnote(vm.sleepWindow.values, goalHours: sleepGoalHours)
        var attributed = AttributedString(footnote.prefix)
        attributed.foregroundColor = Theme.Colors.textSecondary
        if let bold = footnote.bold {
            var boldSpan = AttributedString(bold)
            boldSpan.foregroundColor = Theme.Colors.textPrimary
            boldSpan.font = .system(size: 13, weight: .semibold)
            attributed.append(boldSpan)
            var suffix = AttributedString(footnote.suffix)
            suffix.foregroundColor = Theme.Colors.textSecondary
            attributed.append(suffix)
        }
        return Text(attributed).font(.system(size: 13))
    }
}
