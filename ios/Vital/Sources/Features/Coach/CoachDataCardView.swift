import SwiftUI

/// Inline chart / stat card rendered from a chartable coach tool result. Three
/// shapes: `trend` (bar chart + baseline), `sleep` (bar chart), `compare`
/// (this-vs-last stat). Left-aligned in the transcript, distinct from bubbles.
struct CoachDataCardView: View {
    let viz: CoachViz

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                switch viz.kind {
                case "sleep":   sleepCard
                case "compare": compareCard
                default:        trendCard
                }
            }
            .padding(Theme.Spacing.lg)
            .background(cardSurface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.06), radius: 10, x: 0, y: 4)
            .frame(maxWidth: 300, alignment: .leading)

            Spacer(minLength: 0)
        }
    }

    // ── Trend (metric over N days) ────────────────────────────────────────────

    private var trendCard: some View {
        let points = viz.points ?? []
        let values = points.map(\.value)
        let minV = values.min() ?? 0
        let maxV = values.max() ?? 0
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            header(title: viz.title, pill: deltaPill(viz.deltaPct, suffix: "vs baseline"))

            if let mean = viz.mean {
                bigNumber("\(Int(mean))", unit: "\(viz.unit ?? "") avg")
            }
            if let base = viz.baseline {
                Text("30-day baseline \(Int(base))\(unitSuffix) · range \(Int(minV))–\(Int(maxV))")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            BarChart(points: points, baseline: viz.baseline, color: Theme.Colors.accent)
                .frame(height: 68)
        }
    }

    // ── Sleep (nightly minutes) ───────────────────────────────────────────────

    private var sleepCard: some View {
        let points = viz.points ?? []
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            header(title: viz.title, pill: consistencyPill(viz.consistency))

            if let mean = viz.meanMinutes {
                bigNumber(Self.hm(Int(mean)), unit: "avg")
            }

            BarChart(points: points, baseline: nil, color: Theme.Colors.indigo)
                .frame(height: 68)
        }
    }

    // ── Compare (this vs last period) ─────────────────────────────────────────

    private var compareCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            header(title: viz.title, pill: deltaPill(viz.deltaPct, absolute: viz.delta, unit: viz.unit))

            HStack(spacing: Theme.Spacing.lg) {
                compareSide(label: "This period", value: viz.currentMean)
                Image(systemName: "arrow.right")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.Colors.textSecondary)
                compareSide(label: "Last period", value: viz.previousMean)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func compareSide(label: String, value: Double?) -> some View {
        VStack(spacing: 2) {
            Text(label.uppercased())
                .font(Theme.Typography.labelSmall)
                .tracking(0.5)
                .foregroundStyle(Theme.Colors.textSecondary)
            Text(value.map { formatValue($0) } ?? "—")
                .font(Theme.Typography.numericLarge(22))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
        .frame(maxWidth: .infinity)
    }

    // ── Shared bits ───────────────────────────────────────────────────────────

    private var unitSuffix: String {
        let u = viz.unit ?? ""
        return u.isEmpty ? "" : " \(u)"
    }

    private func header(title: String, pill: AnyView?) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
                .font(Theme.Typography.labelSmall)
                .tracking(0.6)
                .foregroundStyle(Theme.Colors.textSecondary)
            Spacer()
            if let pill { pill }
        }
    }

    private func bigNumber(_ value: String, unit: String) -> some View {
        HStack(alignment: .lastTextBaseline, spacing: 4) {
            Text(value)
                .font(Theme.Typography.numericLarge(26))
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(unit)
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
    }

    private func formatValue(_ v: Double) -> String {
        (viz.unit == "min") ? Self.hm(Int(v)) : "\(Int(v))\(unitSuffix)"
    }

    // Delta pill: green when improving, coral when declining. `absolute`/`unit`
    // render an absolute delta (compare card); otherwise a % vs baseline.
    private func deltaPill(_ pct: Double?, suffix: String = "", absolute: Double? = nil, unit: String? = nil) -> AnyView? {
        guard let pct else { return nil }
        let up = pct >= 0
        let arrow = up ? "↑" : "↓"
        let text: String
        if let absolute {
            let mag = abs(Int(absolute))
            let u = (unit == "min") ? "min" : (unit ?? "")
            text = "\(arrow) \(mag)\(u.isEmpty ? "" : " \(u)")"
        } else {
            text = "\(arrow) \(abs(Int(pct)))%\(suffix.isEmpty ? "" : " \(suffix)")"
        }
        return AnyView(pillLabel(text, positive: up))
    }

    private func consistencyPill(_ c: String?) -> AnyView? {
        guard let c, c != "unknown" else { return nil }
        return AnyView(pillLabel(c, positive: c == "consistent"))
    }

    private func pillLabel(_ text: String, positive: Bool) -> some View {
        let color = positive ? Theme.Colors.accentContent : Theme.Colors.alert
        return Text(text)
            .font(Theme.Typography.labelSmall)
            .fontWeight(.semibold)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.14)))
    }

    private var cardSurface: Color {
        Color(uiColor: UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(white: 1.0, alpha: 0.06)
                : UIColor.white
        })
    }

    static func hm(_ minutes: Int) -> String {
        "\(minutes / 60)h \(minutes % 60)m"
    }
}

// MARK: - Bar chart

/// A minimal bar chart for a short series, with an optional dashed baseline.
private struct BarChart: View {
    let points: [CoachVizPoint]
    let baseline: Double?
    let color: Color

    var body: some View {
        let values = points.map(\.value)
        let maxV = max(values.max() ?? 1, baseline ?? 0, 1)

        return GeometryReader { geo in
            let barsHeight = geo.size.height - 14   // reserve room for labels
            ZStack(alignment: .bottomLeading) {
                if let baseline, baseline > 0, baseline <= maxV {
                    let y = barsHeight * (1 - CGFloat(baseline / maxV))
                    Path { p in
                        p.move(to: CGPoint(x: 0, y: y))
                        p.addLine(to: CGPoint(x: geo.size.width, y: y))
                    }
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(Theme.Colors.textSecondary.opacity(0.5))
                }

                HStack(alignment: .bottom, spacing: 6) {
                    ForEach(Array(points.enumerated()), id: \.offset) { _, pt in
                        VStack(spacing: 4) {
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(color)
                                .frame(height: max(3, barsHeight * CGFloat(pt.value / maxV)))
                            Text(pt.label)
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }
}
