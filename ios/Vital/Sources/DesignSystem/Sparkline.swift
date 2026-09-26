import SwiftUI

/// Visual treatment for `Sparkline`.
enum SparklineStyle {
    case line
    case bar
}

/// Shared minimal trend sparkline for metric tiles. Deliberately drawn as a
/// `Canvas`-hosted `Path`, never a Swift Charts `Chart` — with up to 19 of
/// these in one scroll view (the Trends grid), a `Chart` instance per tile
/// is the real perf hazard. Renders nothing until there are at least 3
/// non-nil values — a 1–2 point sparkline is misleading, not informative.
struct Sparkline: View {
    let values: [Double?]
    var style: SparklineStyle = .line
    var tint: Color = Theme.Colors.accentContent
    var height: CGFloat = 40
    /// The "your normal" band (mean30 ± sd30) to shade behind the series,
    /// in the same display units as `values`. Both nil (the default) omits
    /// the band entirely — every existing call site is unaffected.
    var bandLower: Double? = nil
    var bandUpper: Double? = nil
    /// Draws a small filled dot on the latest non-nil value when true.
    var showsLatestDot: Bool = false

    private var nonNilCount: Int {
        values.reduce(0) { $0 + ($1 == nil ? 0 : 1) }
    }

    /// Value range padded ~12% so a near-flat series doesn't fill the frame
    /// edge to edge, matching `TrendLineChart`'s padding approach. Widened
    /// to include the band (when present) so a normal range that sits
    /// outside the plotted series' own min/max is never clipped.
    private var scale: (lo: Double, hi: Double) {
        var available = values.compactMap { $0 }
        if let bandLower { available.append(bandLower) }
        if let bandUpper { available.append(bandUpper) }
        guard let lo = available.min(), let hi = available.max() else { return (0, 1) }
        guard hi > lo else { return (lo - 1, hi + 1) }
        let pad = (hi - lo) * 0.12
        return (lo - pad, hi + pad)
    }

    private func yPosition(_ value: Double, size: CGSize) -> CGFloat {
        let (lo, hi) = scale
        guard hi > lo else { return size.height / 2 }
        return size.height - CGFloat((value - lo) / (hi - lo)) * size.height
    }

    var body: some View {
        Canvas { context, size in
            guard nonNilCount >= 3, size.width > 0, size.height > 0 else { return }
            drawBand(context: context, size: size)
            switch style {
            case .line: drawLine(context: context, size: size)
            case .bar:  drawBar(context: context, size: size)
            }
            if showsLatestDot {
                drawLatestDot(context: context, size: size)
            }
        }
        .frame(height: height)
    }

    // MARK: - Normal band

    private func drawBand(context: GraphicsContext, size: CGSize) {
        guard let bandLower, let bandUpper else { return }
        let top = yPosition(bandUpper, size: size)
        let bottom = yPosition(bandLower, size: size)
        guard bottom > top else { return }
        let rect = CGRect(x: 0, y: top, width: size.width, height: bottom - top)
        context.fill(Path(rect), with: .color(tint.opacity(0.12)))
    }

    // MARK: - Latest-point dot

    private func drawLatestDot(context: GraphicsContext, size: CGSize) {
        guard let lastIndex = values.lastIndex(where: { $0 != nil }), let value = values[lastIndex] else { return }
        let count = values.count
        let x = (CGFloat(lastIndex) + 0.5) / CGFloat(max(count, 1)) * size.width
        let y = yPosition(value, size: size)
        let radius: CGFloat = 2.75
        let dot = Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
        context.fill(dot, with: .color(tint))
    }

    // MARK: - Line style

    /// Connects available points only, skipping (but visually bridging)
    /// missing days — mirrors `TrendLineChart`'s polyline behavior.
    private func drawLine(context: GraphicsContext, size: CGSize) {
        let (lo, hi) = scale
        let count = values.count

        func xPosition(_ index: Int) -> CGFloat {
            (CGFloat(index) + 0.5) / CGFloat(max(count, 1)) * size.width
        }
        func yPosition(_ value: Double) -> CGFloat {
            guard hi > lo else { return size.height / 2 }
            return size.height - CGFloat((value - lo) / (hi - lo)) * size.height
        }

        let points: [CGPoint?] = values.enumerated().map { index, value in
            guard let value else { return nil }
            return CGPoint(x: xPosition(index), y: yPosition(value))
        }
        let available = points.compactMap { $0 }
        guard let first = available.first, let last = available.last else { return }

        var linePath = Path()
        var started = false
        for point in points {
            guard let point else { continue }
            if started {
                linePath.addLine(to: point)
            } else {
                linePath.move(to: point)
                started = true
            }
        }

        var fillPath = linePath
        fillPath.addLine(to: CGPoint(x: last.x, y: size.height))
        fillPath.addLine(to: CGPoint(x: first.x, y: size.height))
        fillPath.closeSubpath()

        context.fill(
            fillPath,
            with: .linearGradient(
                Gradient(colors: [tint.opacity(0.22), tint.opacity(0.0)]),
                startPoint: CGPoint(x: 0, y: 0),
                endPoint: CGPoint(x: 0, y: size.height)
            )
        )
        context.stroke(
            linePath,
            with: .color(tint),
            style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
        )
    }

    // MARK: - Bar style

    private func drawBar(context: GraphicsContext, size: CGSize) {
        let (lo, hi) = scale
        let count = values.count
        guard count > 0 else { return }
        let slotWidth = size.width / CGFloat(count)
        let barWidth = max(slotWidth * 0.5, 1.5)

        for (index, value) in values.enumerated() {
            guard let value else { continue }
            let normalized = hi > lo ? CGFloat((value - lo) / (hi - lo)) : 0.5
            let barHeight = max(normalized * size.height, 2)
            let x = (CGFloat(index) + 0.5) * slotWidth
            let rect = CGRect(
                x: x - barWidth / 2,
                y: size.height - barHeight,
                width: barWidth,
                height: barHeight
            )
            let path = Path(roundedRect: rect, cornerRadius: min(barWidth / 2, 2))
            context.fill(path, with: .color(tint))
        }
    }
}

#Preview {
    VStack(spacing: 24) {
        Sparkline(values: [47, 47, 48, nil, 49, 49, 49, 50, 51], style: .line)
        Sparkline(values: [6.2, 7.1, 5.8, nil, 6.9, 7.4, 6.5, 7.0], style: .bar)
        Sparkline(values: [nil, nil, 5]) // fewer than 3 non-nil — renders nothing
    }
    .padding()
    .background(Theme.Colors.canvas)
}
