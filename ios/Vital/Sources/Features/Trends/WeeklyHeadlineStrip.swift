import SwiftUI

/// The Trends grid index's sleep-only card (calm-layout revamp, W1/W2
/// designs) — one `GlassCard`: "Sleep this week", the sleep average plus
/// nights-at-goal count, the existing goal-aware `TrendBarChart` 7-night
/// week, and a longest/shortest-night footnote. HRV and resting HR moved out
/// of this card entirely (Trends calm-layout revamp) — the metric-group list
/// below already shows both, and repeating them here read as redundant.
/// Consumes `TrendsSummary`'s existing pure helpers; this view owns only
/// layout.
struct WeeklyHeadlineStrip: View {
    @ObservedObject var vm: TrendsViewModel

    private var sleepGoalHours: Double { Double(vm.sleepGoalMinutes) / 60.0 }
    private var nightsAtGoalText: String? { TrendsSummary.nightsAtGoalText(vm.sleepWindow.values, goalHours: sleepGoalHours) }

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                // Trends-phase-2: sentence case, matches `TrendsWeightCard`'s
                // "Weight" header treatment — replaces the old
                // uppercase-tracked "THIS WEEK" label.
                Text("Sleep this week")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)

                if let nightsAtGoalText {
                    twoUpRow(nightsAtGoalText)
                } else {
                    // No synced nights (e.g. Apple Health not connected yet):
                    // say so instead of "0 of 7 nights at goal" / "7h 00m".
                    Text("No sleep data yet. Connect Apple Health to see your week.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("trends.sleepEmpty")
                }

                if nightsAtGoalText != nil {
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
        }
        // Stable UI-test hook: this is the topmost recovery-related content
        // Trends renders (the sleep card, above every metric-group section)
        // — `TrendsGoalOrdering`'s "weight card first" screenshot assertion
        // needs a unique element to compare frames against. `"HRV"` alone
        // isn't unique — the Recovery group's own list row renders the same
        // text lower on the same screen, and querying `.frame` on an
        // ambiguous match is a hard XCUITest failure (see #200).
        //
        // `.accessibilityElement(children: .contain)` MUST come before
        // `.accessibilityIdentifier` here (#200 round 2): without it, an
        // identifier on a plain container view doesn't make the container
        // itself one queryable element — it's simply inherited by every
        // accessible descendant (this card's own `Text`s), so
        // `app.otherElements["trends.recoveryFirst"]` matched several
        // elements and `.frame` hard-failed again. `.contain` (as opposed to
        // `.combine`, which `TrendsWeightCard`/`WeightHeroView` use because
        // they want ONE spoken label) makes this card itself one
        // accessibility element while still exposing its children as their
        // own elements underneath it. Kept unchanged by the calm-layout
        // revamp — UI tests still depend on this exact identifier/element.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trends.recoveryFirst")
    }

    private func twoUpRow(_ nightsAtGoalText: String) -> some View {
        HStack(spacing: 0) {
            headlineStat(value: vm.sleepValueText, label: "average")
            headlineStat(value: nightsAtGoalText, label: "nights at goal")
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
    /// span's color/weight set as attributes on just that range. Calm-layout
    /// revamp: this now reads `longestShortestFootnote` (longest/shortest
    /// night) instead of `sleepFootnote`'s short-nights count — `sleepFootnote`
    /// itself is left in place (still exercised by `TrendsSummaryTests`) since
    /// deleting it isn't part of this change.
    private var footnoteView: Text {
        let footnote = TrendsSummary.longestShortestFootnote(vm.sleepWindow.values, fullDayLabels: vm.sleepWindow.fullDayLabels)
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
