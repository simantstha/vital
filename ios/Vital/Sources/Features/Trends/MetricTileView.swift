import SwiftUI

/// One tile on the Trends grid index. Pure rendering — no navigation, no
/// haptics, no tap handling; `TrendsView` wraps this in a `Button` (see
/// `TilePressStyle` below) so this view stays trivially previewable and
/// testable in isolation.
///
/// Renders every state `TrendsIndexSections.build` can produce for a metric
/// (a fully-hidden metric never reaches this view — see that type's doc
/// comment): `.chart` (value + sparkline + a small status dot + delta line,
/// possibly still gated to a calibrating line), `.sparse` (1-2 readings —
/// value only, no sparkline, no verdict), and `.dimmed` (has history,
/// nothing in the requested window — "Last synced …", dimmed opacity, name
/// kept visible so it doesn't read as "this metric vanished").
///
/// Trends-phase-1 redesign: the old verdict `Chip` row is gone, replaced by
/// an 8pt status dot (top-right, next to the name) and a single 12pt
/// semibold delta line under the value — "↑ 7 above normal" rather than a
/// pill reading "above normal". The sparkline itself now shades the
/// mean30±sd30 "normal" band behind the series and dots the latest point,
/// so the chart alone carries what used to need the chip's context.
struct MetricTileView: View {
    let tile: TrendsTile
    @ObservedObject private var unitPref = UnitPreference.shared
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var spec: MetricSpec? { MetricCatalog.spec(for: tile.key) }

    /// Reserves the sparkline's footprint for `.dimmed`/`.sparse` tiles (no
    /// chart drawn) so every tile in a grid row lands the same height
    /// regardless of state — matches `Sparkline`'s own default `height`.
    private static let sparklineSlotHeight: CGFloat = 40

    var body: some View {
        // Trends-phase-1: tiles use the solid `VitalCard` surface (not
        // `GlassCard`) — see `TilePressStyle`'s doc comment below for why
        // that also changes the press feedback. `Theme.Radius.lg` (20pt)
        // matches the mock's tile corner radius.
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: 0) {
                nameRow

                valueRow
                    .padding(.top, 5)

                deltaLine
                    .padding(.top, 2)

                middleContent
                    .padding(.top, Theme.Spacing.sm)

                Spacer(minLength: 0)
            }
            .frame(minHeight: 100, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .opacity(isDimmed ? 0.42 : 1.0)
        // A single combined VoiceOver stop — e.g. "HRV, 61 milliseconds, 7
        // above your normal, good" — instead of exposing the name/value/dot/
        // sparkline as separate nodes. `TrendsView`'s wrapping `Button`
        // still supplies the tap/navigation and the button trait; this only
        // replaces what gets read.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MetricTileAccessibility.label(tile: tile, spec: spec, unitSystem: unitPref.current))
    }

    private var isDimmed: Bool {
        if case .dimmed = tile.content { return true }
        return false
    }

    // MARK: - Name row (name + status dot)

    private var nameRow: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.xs) {
            Text(spec?.displayName ?? tile.key)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
                // AX sizes: let the name wrap to a 2nd line rather than
                // clip — `.frame(minHeight:)` above already lets the tile
                // grow to fit.
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            Spacer(minLength: Theme.Spacing.xs)
            statusDot
        }
    }

    /// 8pt dot: good = positive, watch = caution, everything else
    /// (normal/calibrating/noData/sparse/dimmed) = `textTertiary`. Tints
    /// strictly by polarity via `TrendDirection.resolve` — never by "is this
    /// out of range" alone — so a `neutral`-polarity metric that's drifted
    /// (steps, strain, weight) never accidentally reads as good/bad.
    private var statusDot: some View {
        Circle()
            .fill(statusDotColor)
            .frame(width: 8, height: 8)
            .padding(.top, 3)
            .accessibilityHidden(true)
    }

    private var statusDotColor: Color {
        guard case .chart(_, _, let verdict) = tile.content, let spec else { return Theme.Colors.textTertiary }
        switch verdict {
        case .above: return TrendDirection.resolve(spec.polarity, rising: true).isGood ? Theme.Colors.positive : Theme.Colors.caution
        case .below: return TrendDirection.resolve(spec.polarity, rising: false).isGood ? Theme.Colors.positive : Theme.Colors.caution
        default:      return Theme.Colors.textTertiary
        }
    }

    // MARK: - Value row (name already rendered above; this is the big number)

    @ViewBuilder
    private var valueRow: some View {
        switch tile.content {
        case .dimmed:
            Text("—")
                .font(Theme.Typography.numericLarge(24))
                .foregroundStyle(Theme.Colors.textTertiary)
        case .sparse(let value, _):
            valueText(value)
        case .chart(let value, _, _):
            valueText(value)
        }
    }

    private func valueText(_ value: Double) -> some View {
        HStack(alignment: .lastTextBaseline, spacing: 3) {
            Text(Self.formattedNumber(value, decimals: spec?.decimals ?? 0))
                .font(Theme.Typography.numericLarge(24))
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

    // MARK: - Delta line (replaces the old verdict chip)

    @ViewBuilder
    private var deltaLine: some View {
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
            deltaLineForChart(value: value, verdict: verdict)
        }
    }

    @ViewBuilder
    private func deltaLineForChart(value: Double, verdict: Verdict) -> some View {
        switch verdict {
        case .above, .below:
            if let spec, let mean30 = tile.baseline?.mean30 {
                let delta = value - mean30
                let rising = delta >= 0
                let isGood = TrendDirection.resolve(spec.polarity, rising: rising).isGood
                Text("\(TrendsDeltaFormat.arrow(delta)) \(TrendsDeltaFormat.magnitudeText(delta, spec: spec, system: unitPref.current, includeUnit: false)) \(rising ? "above" : "below") normal")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(isGood ? Theme.Colors.positive : Theme.Colors.caution)
            } else {
                // Verdict math already requires a baseline to reach
                // `.above`/`.below` — this branch is unreachable in
                // practice, but falls back to plain copy rather than
                // fabricating a delta with no `mean30`.
                let isAbove: Bool = {
                    if case .above = verdict { return true }
                    return false
                }()
                Text(isAbove ? "above normal" : "below normal")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        case .normal:
            Text("in your normal range")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textSecondary)
        case .calibrating(let daysRemaining):
            let text = daysRemaining > 0
                ? "\(daysRemaining) more day\(daysRemaining == 1 ? "" : "s")"
                : "not enough variation yet"
            Text(text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
        case .noData:
            Text("no data yet")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.Colors.textTertiary)
        }
    }

    // MARK: - Middle: sparkline, or an empty slot holding its place

    @ViewBuilder
    private var middleContent: some View {
        switch tile.content {
        case .dimmed, .sparse:
            Color.clear.frame(height: Self.sparklineSlotHeight)
        case .chart(_, let sparklineValues, let verdict):
            if let spec {
                let band = normalBand(for: verdict)
                Sparkline(
                    values: sparklineValues,
                    style: spec.sparkline,
                    tint: sparklineTint(spec: spec, verdict: verdict),
                    height: Self.sparklineSlotHeight,
                    bandLower: band?.lower,
                    bandUpper: band?.upper,
                    showsLatestDot: true
                )
                // Decorative — the value + delta line already say everything
                // the sparkline conveys; VoiceOver shouldn't stop on it.
                .accessibilityHidden(true)
            } else {
                Color.clear.frame(height: Self.sparklineSlotHeight)
            }
        }
    }

    /// The shaded band only renders once the verdict is actually gated in —
    /// never for `.calibrating`/`.noData`, matching `MetricDetailView`'s own
    /// `showsBand` gate (same source of truth: a verdict that hasn't
    /// cleared `TrendsVerdict`'s gates has no "normal" to show yet).
    private func normalBand(for verdict: Verdict) -> (lower: Double, upper: Double)? {
        switch verdict {
        case .calibrating, .noData: return nil
        default:
            guard let mean30 = tile.baseline?.mean30, let sd30 = tile.baseline?.sd30 else { return nil }
            return (mean30 - sd30, mean30 + sd30)
        }
    }

    /// Sleep keeps the app's established indigo identity regardless of
    /// verdict (matches `TrendBarChart`'s existing sleep convention).
    /// Every other metric's sparkline mirrors its status dot's color —
    /// `TrendDirection.resolve` is the only place a direction becomes a
    /// color (the plan's explicit rule), so the chart and the dot can never
    /// disagree about what "above normal" looks like.
    private func sparklineTint(spec: MetricSpec, verdict: Verdict) -> Color {
        if spec.key == "sleep_minutes" || spec.key == "whoop_sleep_min" {
            return Theme.Colors.indigo
        }
        switch verdict {
        case .above: return TrendDirection.resolve(spec.polarity, rising: true).isGood ? Theme.Colors.positive : Theme.Colors.caution
        case .below: return TrendDirection.resolve(spec.polarity, rising: false).isGood ? Theme.Colors.positive : Theme.Colors.caution
        default:     return Theme.Colors.textSecondary
        }
    }

    // MARK: - Formatting helpers

    private static func formattedNumber(_ value: Double, decimals: Int) -> String {
        TrendsDeltaFormat.formattedNumber(value, decimals: decimals)
    }

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

// MARK: - Tile press feedback

/// Trends-phase-1: tiles moved off `GlassCard` onto the solid `VitalCard`
/// surface (see the body's doc comment above), so the old
/// backdrop-blur-resampling hazard that kept this opacity-only no longer
/// applies — a `VitalCard` is a plain `RoundedRectangle` fill, not a
/// `.glassEffect()`, so scaling it costs nothing extra. Reduce Motion still
/// gets opacity-only feedback (no motion), matching every other press style
/// in this file family.
struct TilePressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(!reduceMotion && configuration.isPressed ? 0.97 : 1.0)
            .opacity(configuration.isPressed ? 0.85 : 1.0)
            .animation(Theme.Motion.micro, value: configuration.isPressed)
    }
}
