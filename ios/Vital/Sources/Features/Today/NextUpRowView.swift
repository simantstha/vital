import SwiftUI

/// Replaces the full plan timeline on Today (owner decision, 2026-09-23): a
/// single "Next up" row — the next not-done item by time — plus a "See full
/// plan ›" footer that opens the existing `PlanTimelineView` in a sheet.
/// Applies to every goal, not just weight_loss.
struct NextUpRowView: View {
    let item: PlanItem
    var onTap: () -> Void
    var onSeeFullPlan: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Next up")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
                .padding(.horizontal, Theme.Spacing.xxs)

            Button(action: onTap) {
                HStack(spacing: Theme.Spacing.md + 2) {
                    IconBadge(systemName: item.sfSymbol, style: item.status == .now ? .accent : .soft)

                    VStack(alignment: .leading, spacing: 2) {
                        // 2 lines allowed (task brief: "never truncated to
                        // uselessness") — unlike the full timeline's rows,
                        // which are single-line since there are several at once.
                        Text(item.title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .lineLimit(2)
                        if !item.subtitle.isEmpty {
                            Text(item.subtitle.asMarkdown)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.Colors.textSecondary)
                                .lineLimit(2)
                        }
                    }

                    Spacer(minLength: Theme.Spacing.sm)

                    Text(item.timeLabel)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textTertiary)
                        .monospacedDigit()
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.md + 2)
            }
            .buttonStyle(.vital)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.Colors.card)
                    .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
            )

            Button(action: onSeeFullPlan) {
                HStack(spacing: Theme.Spacing.xs) {
                    Text("See full plan")
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.accentContent)
                .padding(.horizontal, Theme.Spacing.xxs)
            }
            .buttonStyle(.plain)
        }
    }
}
