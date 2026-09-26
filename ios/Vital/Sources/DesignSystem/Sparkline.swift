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
    /// Trends-phase-2 index motion: when true, the line (and band) wipe in
    /// left→right over 0.6s easeOut on first appearance, then the latest
    /// dot pops (scale 0.6→1 + fade) 0.15s after the line completes — see
    /// `Theme.Motion`'s storyboard notes. Defaults to `false`, which keeps
    /// every existing caller's rendering exactly as before (drawn fully,
    /// immediately, with no `@State`/`onAppear` side effects). Callers
    /// (`MetricTileView`, `WhatMovedRowView`) pass `true` only on the render
    /// where `TrendsViewModel.hasAnimatedIn` is still `false` — i.e. the
    /// screen's first load — so the reveal plays once per session, not on
    /// every period switch or pull-to-refresh.
    var animatesOnAppear: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 0 = nothing drawn yet, 1 = fully drawn. Starts at 1 (already fully
    /// revealed) so a non-animating caller's very first frame renders
    /// identically to before this property existed.
    @State private var revealFraction: CGFloat = 1
    @State private var dotRevealed: Bool = true

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
        ZStack(alignment: .topLeading) {
            Canvas { context, size in
                guard nonNilCount >= 3, size.width > 0, size.height > 0 else { return }
                drawBand(context: context, size: size)
                switch style {
                case .line: drawLine(context: context, size: size)
                case .bar:  drawBar(context: context, size: size)
                }
                // The animated reveal draws its own dot as a separately
                // scaled/faded SwiftUI overlay below (Canvas draw calls
                // can't be individually animated) — only draw it here for
                // the non-animating (default) path.
                if showsLatestDot, !animatesOnAppear {
                    drawLatestDot(context: context, size: size)
                }
            }
            .mask(alignment: .leading) {
                // Native SwiftUI `.frame`/`.scaleEffect` changes interpolate
                // smoothly under `withAnimation`; a `Canvas`'s own draw
                // calls do not (there's no `Animatable` here), so the
                // "draws in" reveal is a wipe mask over the whole canvas
                // rather than a per-frame redraw.
                Rectangle().scaleEffect(x: revealFraction, y: 1, anchor: .leading)
            }

            if animatesOnAppear, showsLatestDot, nonNilCount >= 3 {
                GeometryReader { proxy in
                    latestDotOverlay(size: proxy.size)
                }
            }
        }
        .frame(height: height)
        .onAppear(perform: startRevealIfNeeded)
    }

    private func startRevealIfNeeded() {
        guard animatesOnAppear, !reduceMotion else {
            revealFraction = 1
            dotRevealed = true
            return
        }
        revealFraction = 0
        dotRevealed = false
        withAnimation(.easeOut(duration: 0.6)) { revealFraction = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            withAnimation(.spring(response: 0.15, dampingFraction: 0.8)) { dotRevealed = true }
        }
    }

    @ViewBuilder
    private func latestDotOverlay(size: CGSize) -> some View {
        if let point = latestDotPosition(size: size) {
            Circle()
                .fill(tint)
                .frame(width: 5.5, height: 5.5)
                .position(point)
                .scaleEffect(dotRevealed ? 1 : 0.6)
                .opacity(dotRevealed ? 1 : 0)
        }
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

    private func latestDotPosition(size: CGSize) -> CGPoint? {
        guard let lastIndex = values.lastIndex(where: { $0 != nil }), let value = values[lastIndex] else { return nil }
        let count = values.count
        let x = (CGFloat(lastIndex) + 0.5) / CGFloat(max(count, 1)) * size.width
        let y = yPosition(value, size: size)
        return CGPoint(x: x, y: y)
    }

    private func drawLatestDot(context: GraphicsContext, size: CGSize) {
        guard let point = latestDotPosition(size: size) else { return }
        let radius: CGFloat = 2.75
        let dot = Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2))
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
