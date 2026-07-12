import SwiftUI

/// Hand-drawn 7-point line+dot chart for the HRV / Resting HR summary cards
/// (v3 mock's `LineDots` component). Points sit centered per column
/// (x = (i+0.5)/7); the y-scale is the available values' min/max padded by
/// `max((max-min)*0.4, 2)` so a near-flat week doesn't fill the frame edge
/// to edge. The polyline connects available points only, skipping (but
/// visually bridging) missing days, matching the mock.
///
/// Values are the metric's native unit (ms for HRV, bpm for resting HR).
/// Both this and `TrendBarChart` take `values: [Double?]` (exactly 7,
/// oldest → newest) + `dayLabels: [String]`.
struct TrendLineChart: View {
    let values: [Double?]
    let dayLabels: [String]

    private let chartHeight: CGFloat = 62

    private var available: [Double] { values.compactMap { $0 } }

    private var scale: (lo: Double, hi: Double) {
        guard let lo = available.min(), let hi = available.max() else { return (0, 1) }
        let pad = Swift.max((hi - lo) * 0.4, 2)
        return (lo - pad, hi + pad)
    }

    private func xPosition(_ index: Int, width: CGFloat) -> CGFloat {
        (CGFloat(index) + 0.5) / CGFloat(max(values.count, 1)) * width
    }

    private func yPosition(_ value: Double) -> CGFloat {
        let (lo, hi) = scale
        guard hi > lo else { return chartHeight / 2 }
        return chartHeight - CGFloat((value - lo) / (hi - lo)) * chartHeight
    }

    var body: some View {
        VStack(spacing: 4) {
            GeometryReader { geo in
                let width = geo.size.width
                let positions: [CGPoint?] = values.enumerated().map { index, value in
                    guard let value else { return nil }
                    return CGPoint(x: xPosition(index, width: width), y: yPosition(value))
                }
                let lastAvailableIndex = values.lastIndex(where: { $0 != nil })

                ZStack {
                    if positions.compactMap({ $0 }).count > 1 {
                        Path { path in
                            var started = false
                            for point in positions {
                                guard let point else { continue }
                                if started {
                                    path.addLine(to: point)
                                } else {
                                    path.move(to: point)
                                    started = true
                                }
                            }
                        }
                        .stroke(
                            Theme.Colors.accent,
                            style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round)
                        )
                    }

                    ForEach(Array(positions.enumerated()), id: \.offset) { index, point in
                        if let point {
                            let isLast = index == lastAvailableIndex
                            Circle()
                                .fill(Theme.Colors.accent)
                                .frame(width: isLast ? 11 : 9, height: isLast ? 11 : 9)
                                .overlay(
                                    Circle()
                                        .strokeBorder(
                                            Theme.Colors.accentContent.opacity(0.3),
                                            lineWidth: isLast ? 2 : 0
                                        )
                                )
                                .position(point)
                        } else {
                            Circle()
                                .strokeBorder(
                                    Theme.Colors.textTertiary.opacity(0.4),
                                    style: StrokeStyle(lineWidth: 1, dash: [2, 2])
                                )
                                .frame(width: 6, height: 6)
                                .position(x: xPosition(index, width: width), y: chartHeight / 2)
                        }
                    }
                }
            }
            .frame(height: chartHeight)

            HStack(spacing: 0) {
                ForEach(Array(dayLabels.enumerated()), id: \.offset) { _, label in
                    Text(label)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

#Preview {
    VStack(spacing: 24) {
        TrendLineChart(
            values: [nil, nil, nil, nil, nil, 58, 62],
            dayLabels: ["F", "S", "S", "M", "T", "W", "T"]
        )
        TrendLineChart(
            values: [47, 47, 48, 48, 49, 49, 49],
            dayLabels: ["F", "S", "S", "M", "T", "W", "T"]
        )
    }
    .padding()
    .background(Theme.Colors.canvas)
}
