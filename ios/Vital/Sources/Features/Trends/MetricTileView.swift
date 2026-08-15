import SwiftUI

/// One tile on the Trends grid index. Pure rendering — no navigation, no
/// haptics, no tap handling; `TrendsView` wraps this in a `Button` (see
/// `TilePressStyle` below) so this view stays trivially previewable and
/// testable in isolation.
///
/// Renders every state `TrendsIndexSections.build` can produce for a metric
/// (a fully-hidden metric never reaches this view — see that type's doc
/// comment): `.chart` (value + sparkline + verdict chip, verdict possibly
/// still gated to a calibrating chip), `.sparse` (1-2 readings — value only,
/// no sparkline, no verdict), and `.dimmed` (has history, nothing in the
/// requested window — "Last synced …", dimmed opacity, name kept visible so
/// it doesn't read as "this metric vanished").
struct MetricTileView: View {
    let tile: TrendsTile
    @ObservedObject private var unitPref = UnitPreference.shared

    private var spec: MetricSpec? { MetricCatalog.spec(for: tile.key) }

    /// Reserves the sparkline's footprint for `.dimmed`/`.sparse` tiles (no
    /// chart drawn) so every tile in a grid row lands the same height
    /// regardless of state — matches `Sparkline`'s own default `height`.
    private static let sparklineSlotHeight: CGFloat = 40

    var body: some View {
        GlassCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: 0) {
                Text(spec?.displayName ?? tile.key)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)

                valueRow
                    .padding(.top, 5)

                middleContent
                    .padding(.vertical, Theme.Spacing.sm)

                Spacer(minLength: 0)

                chip
            }
            .frame(minHeight: 118, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .opacity(isDimmed ? 0.42 : 1.0)
    }

    private var isDimmed: Bool {
        if case .dimmed = tile.content { return true }
        return false
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
            if let unit = spec?.unit(unitPref.current), !unit.isEmpty {
                Text(unit)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
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
                Sparkline(
                    values: sparklineValues,
                    style: spec.sparkline,
                    tint: sparklineTint(spec: spec, verdict: verdict),
                    height: Self.sparklineSlotHeight
                )
            } else {
                Color.clear.frame(height: Self.sparklineSlotHeight)
            }
        }
    }

    /// Sleep keeps the app's established indigo identity regardless of
    /// verdict (matches `TrendBarChart`'s existing sleep convention).
    /// Every other metric's sparkline mirrors its verdict chip's color —
    /// `TrendDirection.resolve` is the only place a direction becomes a
    /// color (the plan's explicit rule), so the chart and the chip can never
    /// disagree about what "above normal" looks like.
    private func sparklineTint(spec: MetricSpec, verdict: Verdict) -> Color {
        if spec.key == "sleep_minutes" || spec.key == "whoop_sleep_min" {
            return Theme.Colors.indigo
        }
        switch verdict {
        case .above: return TrendDirection.resolve(spec.polarity, rising: true).color
        case .below: return TrendDirection.resolve(spec.polarity, rising: false).color
        default:     return Theme.Colors.textSecondary
        }
    }

    // MARK: - Chip (verdict, reading count, or "last synced")

    @ViewBuilder
    private var chip: some View {
        switch tile.content {
        case .dimmed(let lastDate):
            Chip(text: Self.lastSyncedText(lastDate))
        case .sparse(_, let count):
            Chip(text: count == 1 ? "1 reading" : "\(count) readings")
        case .chart(_, _, let verdict):
            verdictChip(verdict, polarity: spec?.polarity ?? .neutral)
        }
    }

    /// Tints strictly by polarity via `TrendDirection.resolve` — never by
    /// "is this out of range" alone, so a `neutral`-polarity metric that's
    /// drifted (steps, strain, weight) renders gray, not accidentally
    /// positive/alert. `.normal`/`.calibrating`/`.noData` are always neutral
    /// (there is no direction to tint).
    private func verdictChip(_ verdict: Verdict, polarity: MetricPolarity) -> some View {
        switch verdict {
        case .above:
            return Chip(text: "↑ above your normal", tint: TrendDirection.resolve(polarity, rising: true).color)
        case .below:
            return Chip(text: "↓ below your normal", tint: TrendDirection.resolve(polarity, rising: false).color)
        case .normal:
            return Chip(text: "in your normal range")
        case .calibrating(let daysRemaining):
            let text = daysRemaining > 0
                ? "\(daysRemaining) more day\(daysRemaining == 1 ? "" : "s")"
                : "not enough variation yet"
            return Chip(text: text)
        case .noData:
            return Chip(text: "no data yet")
        }
    }

    // MARK: - Formatting helpers

    private static func formattedNumber(_ value: Double, decimals: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = decimals
        formatter.usesGroupingSeparator = true
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.\(decimals)f", value)
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

/// Opacity-only press feedback, deliberately not `.buttonStyle(.vital)` (or
/// any `scaleEffect`) — `Theme.swift`'s `VitalButtonStyle` doc comment warns
/// that scaling a `.glassEffect()` subtree forces the backdrop blur to
/// re-sample every frame of the press animation. A `MetricTileView` is a
/// `GlassCard`, and this grid can render up to 19 of them at once, so a
/// scaled press animation is exactly the hazard the plan's Skin-B risk list
/// calls out. Dimming opacity only avoids re-sampling the blur geometry.
struct TilePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1.0)
            .animation(Theme.Motion.micro, value: configuration.isPressed)
    }
}
