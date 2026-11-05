import SwiftUI

/// Today's endurance recovery strip: HRV / Resting HR / Sleep as three quiet
/// columns — label, value, a range bar sitting on the user's own normal, and
/// a one-line delta. Replaces the three `MetricTile` cards for the endurance
/// goal. All numbers and copy come from `RecoveryStripLogic`; a metric
/// without a gated verdict shows its value alone (never an invented range).
struct RecoveryStripView: View {
    let items: [RecoveryStripLogic.Item]

    var body: some View {
        if !items.isEmpty {
            AccessibilityAdaptiveStack(
                alignment: .top, spacing: Theme.Spacing.lg, stackedSpacing: Theme.Spacing.lg
            ) {
                ForEach(items) { item in
                    RecoveryStripColumn(item: item)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("today.recoveryStrip")
        }
    }
}

private struct RecoveryStripColumn: View {
    let item: RecoveryStripLogic.Item

    private var toneColor: Color {
        switch item.tone {
        case .positive: return Theme.Colors.positive
        case .caution: return Theme.Colors.caution
        case .neutral: return Theme.Colors.textPrimary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: 2) {
                Text(item.label)
                    .scaledFont(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .layoutPriority(1)
                if let explanation = MetricExplainer.explanation(for: item.explanationKey) {
                    WhatIsThisButton(title: item.label, text: explanation)
                }
                Spacer(minLength: 0)
            }

            // Value, bar and delta read as one element ("58 ms, +6 vs
            // normal"); the bar itself is decorative.
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                HStack(alignment: .lastTextBaseline, spacing: 3) {
                    Text(item.valueText)
                        .scaledFont(size: 28, weight: .bold, design: .rounded)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .contentTransition(.numericText())
                    if !item.unit.isEmpty {
                        Text(item.unit)
                            .scaledFont(Theme.Typography.bodySmall)
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }

                if let range = item.range {
                    RecoveryRangeBar(range: range, markerColor: toneColor)
                        .accessibilityHidden(true)
                }

                if let delta = item.deltaText {
                    Text(delta)
                        .scaledFont(Theme.Typography.bodySmall.weight(.medium))
                        .foregroundStyle(item.tone == .neutral ? Theme.Colors.textSecondary : toneColor)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Hairline track, a thicker pill for the normal range, and a tick for today.
private struct RecoveryRangeBar: View {
    let range: RecoveryStripLogic.Range
    let markerColor: Color

    private let height: CGFloat = 14
    private let markerWidth: CGFloat = 3

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let bandX = width * range.bandStart
            let bandWidth = max(0, width * (range.bandEnd - range.bandStart))
            // Keep the whole tick inside the bar when the marker is pinned to an end.
            let markerX = min(max(width * range.marker - markerWidth / 2, 0), max(0, width - markerWidth))
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Theme.Colors.progressTrack)
                    .frame(height: 2)
                Capsule()
                    .fill(Theme.Colors.textTertiary.opacity(0.55))
                    .frame(width: bandWidth, height: 6)
                    .offset(x: bandX)
                RoundedRectangle(cornerRadius: markerWidth / 2, style: .continuous)
                    .fill(markerColor)
                    .frame(width: markerWidth, height: height)
                    .offset(x: markerX)
            }
            .frame(maxHeight: .infinity, alignment: .leading)
        }
        .frame(height: height)
    }
}
