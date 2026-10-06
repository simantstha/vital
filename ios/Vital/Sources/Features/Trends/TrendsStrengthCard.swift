import SwiftUI

/// Trends' "Strength" card (roadmap v5 item B): the top lifts' current
/// estimated 1RM, an 8-week sparkline and a plain-English progress chip, plus
/// the weekly volume line. All copy/logic lives in `TrendsStrengthLogic`; this
/// view only lays out a `TrendsStrengthLogic.Card`. Rendered by `TrendsView`
/// only when the card exists (the summary has logged sets) — never an empty or
/// zeroed card.
struct TrendsStrengthCard: View {
    let card: TrendsStrengthLogic.Card

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                Text("Strength")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                Text("est. 1RM")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(card.lifts.enumerated()), id: \.element.id) { index, lift in
                        liftRow(lift)
                        if index < card.lifts.count - 1 {
                            Divider().overlay(Theme.Colors.glassBorder)
                        }
                    }
                    if !card.lifts.isEmpty {
                        Divider().overlay(Theme.Colors.glassBorder)
                    }
                    volumeRow
                }
            }
        }
    }

    private func liftRow(_ lift: TrendsStrengthLogic.Lift) -> some View {
        HStack(alignment: .center, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(lift.name)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                Text(lift.currentText)
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .monospacedDigit()
            }
            Spacer(minLength: Theme.Spacing.sm)
            VStack(alignment: .trailing, spacing: Theme.Spacing.xs) {
                Sparkline(values: lift.sparkline, style: .line, tint: tint(for: lift.status.tone), height: 28, showsLatestDot: true)
                    .frame(width: 96)
                Chip(text: lift.status.text, tint: tint(for: lift.status.tone))
            }
        }
        .padding(.vertical, Theme.Spacing.md)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(lift.accessibilityLabel)
    }

    private var volumeRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(card.volume.thisWeek)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
                .monospacedDigit()
            if let comparison = card.volume.comparison {
                Text(comparison)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .monospacedDigit()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, card.lifts.isEmpty ? 0 : Theme.Spacing.md)
        .padding(.bottom, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("trends.strengthCard.volume")
    }

    private func tint(for tone: TrendsStrengthLogic.Tone) -> Color {
        switch tone {
        case .good:    return Theme.Colors.positive
        case .watch:   return Theme.Colors.caution
        case .neutral: return Theme.Colors.textSecondary
        }
    }
}
