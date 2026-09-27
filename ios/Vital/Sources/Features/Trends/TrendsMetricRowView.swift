import SwiftUI

/// One row inside a Trends metric-group card (W1/W2 calm-layout revamp,
/// replacing the old 2-column `MetricTileView` grid tile): name (+ an
/// optional secondary line), a small sparkline with no shaded "normal" band
/// box, the value + unit, and a chevron. Pure rendering — no navigation, no
/// haptics, no tap handling; `TrendsView` wraps this in a `Button` exactly
/// like it wrapped `MetricTileView`, so this view stays trivially
/// previewable and testable in isolation.
///
/// Renders every state `TrendsIndexSections.build` can produce for a metric,
/// same as the tile it replaces: `.chart` (value + sparkline, and either the
/// above/below delta line or a calibrating progress bar as the secondary
/// line), `.sparse` (1–2 readings — value only), and `.dimmed` (has history,
/// nothing in the requested window — "Last synced …", dimmed opacity).
struct TrendsMetricRowView: View {
    let tile: TrendsTile
    /// Trends-phase-2 index motion: true only on the render where
    /// `TrendsViewModel.hasAnimatedIn` is still `false` (the screen's first
    /// load) — see `Sparkline.animatesOnAppear`'s doc comment.
    var animatesIn: Bool = false
    @ObservedObject private var unitPref = UnitPreference.shared

    private var spec: MetricSpec? { MetricCatalog.spec(for: tile.key) }

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                // Exact text "HRV" (etc.) — `ScreenshotTests` finds this row
                // by `app.staticTexts["HRV"]`, the same query it used
                // against `MetricTileView`'s identical name `Text`.
                Text(spec?.displayName ?? tile.key)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                secondaryLine
            }

            Spacer(minLength: Theme.Spacing.sm)

            sparklineView
                .frame(width: 64, height: 28)

            valueView
                .frame(minWidth: 44, alignment: .trailing)

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
        .padding(.vertical, Theme.Spacing.sm)
        .contentShape(Rectangle())
        .opacity(isDimmed ? 0.5 : 1.0)
        // A single combined VoiceOver stop — e.g. "HRV, 61 milliseconds, 7
        // above your normal, good" — instead of exposing name/value/sparkline
        // as separate nodes. Matches `MetricTileView`'s identical modifier
        // order (`.ignore` then `.accessibilityLabel`), which is also what
        // keeps `app.staticTexts["HRV"]` still resolvable in UI tests.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MetricTileAccessibility.label(tile: tile, spec: spec, unitSystem: unitPref.current))
    }

    private var isDimmed: Bool {
        if case .dimmed = tile.content { return true }
        return false
    }

    // MARK: - Secondary line (delta text, calibrating progress, or a plain
    // reading/sync note)

    @ViewBuilder
    private var secondaryLine: some View {
        switch tile.content {
        case .dimmed(let lastDate):
            Text(Self.lastSyncedText(lastDate))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
        case .sparse(_, let count):
            Text(count == 1 ? "1 reading" : "\(count) readings")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
        case .chart(let value, _, let verdict):
            chartSecondary(value: value, verdict: verdict)
        }
    }

    @ViewBuilder
    private func chartSecondary(value: Double, verdict: Verdict) -> some View {
        switch verdict {
        case .above, .below:
            if let spec, let mean30 = tile.baseline?.mean30 {
                let delta = value - mean30
                let rising = delta >= 0
                let moved = TrendsMetricRowLogic.movedSecondary(value: value, mean30: mean30, spec: spec, rising: rising, unitSystem: unitPref.current)
                Text(moved.text)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(moved.isGood ? Theme.Colors.positive : Theme.Colors.caution)
            } else {
                // Verdict math already requires a baseline to reach
                // `.above`/`.below` — this branch is unreachable in
                // practice, but falls back to plain copy rather than
                // fabricating a delta with no `mean30` (same fallback
                // `MetricTileView` had).
                let isAbove: Bool = {
                    if case .above = verdict { return true }
                    return false
                }()
                Text(isAbove ? "above normal" : "below normal")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        case .calibrating(let daysRemaining):
            calibratingProgressView(TrendsMetricRowLogic.calibratingProgress(daysRemaining: daysRemaining))
        case .normal, .noData:
            // W1 design: an established, unmoved row shows nothing under
            // the name — the sparkline + value already say "nothing to
            // report" on their own.
            EmptyView()
        }
    }

    private func calibratingProgressView(_ progress: TrendsMetricRowLogic.CalibratingProgress) -> some View {
        HStack(spacing: 6) {
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Theme.Colors.progressTrack)
                    .frame(width: 46, height: 4)
                Capsule()
                    .fill(Theme.Colors.accentContent)
                    .frame(width: 46 * CGFloat(progress.fraction), height: 4)
            }
            Text(progress.text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    // MARK: - Sparkline (no shaded band — that stays on "What moved" only)

    @ViewBuilder
    private var sparklineView: some View {
        switch tile.content {
        case .dimmed, .sparse:
            Color.clear
        case .chart(_, let sparklineValues, let verdict):
            if let spec {
                Sparkline(
                    values: sparklineValues,
                    style: spec.sparkline,
                    tint: sparklineTint(spec: spec, verdict: verdict),
                    height: 28,
                    showsLatestDot: true,
                    animatesOnAppear: animatesIn
                )
                // Decorative — the value + secondary line already say
                // everything the sparkline conveys; VoiceOver shouldn't stop
                // on it (matches `MetricTileView`'s identical call).
                .accessibilityHidden(true)
            } else {
                Color.clear
            }
        }
    }

    /// Sparkline tint mirrors metric direction's color, using neutral grey
    /// for all metrics in normal/noData states — same rule `MetricTileView`
    /// used, so the row and its accessibility label never disagree about
    /// what "above normal" looks like.
    private func sparklineTint(spec: MetricSpec, verdict: Verdict) -> Color {
        switch verdict {
        case .above: return TrendDirection.resolve(spec.polarity, rising: true).isGood ? Theme.Colors.positive : Theme.Colors.caution
        case .below: return TrendDirection.resolve(spec.polarity, rising: false).isGood ? Theme.Colors.positive : Theme.Colors.caution
        default:     return Theme.Colors.textSecondary
        }
    }

    // MARK: - Value (trailing number + unit)

    @ViewBuilder
    private var valueView: some View {
        switch tile.content {
        case .dimmed:
            Text("—")
                .font(Theme.Typography.numericSmall(17))
                .foregroundStyle(Theme.Colors.textTertiary)
        case .sparse(let value, _):
            valueText(value)
        case .chart(let value, _, _):
            valueText(value)
        }
    }

    private func valueText(_ value: Double) -> some View {
        HStack(alignment: .lastTextBaseline, spacing: 3) {
            Text(TrendsDeltaFormat.formattedNumber(value, decimals: spec?.decimals ?? 0))
                .font(Theme.Typography.numericSmall(17))
                .foregroundStyle(Theme.Colors.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                // Period switches change `value` in place (same tile
                // identity) — roll the digits instead of a hard swap.
                .contentTransition(.numericText())
                .animation(Theme.Motion.numeric, value: value)
            if let unit = spec?.unit(unitPref.current), !unit.isEmpty {
                Text(unit)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }

    // MARK: - Formatting helpers

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f
    }()

    private static func lastSyncedText(_ date: Date?) -> String {
        guard let date else { return "Last synced —" }
        return "Last synced " + relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}
