import SwiftUI

/// The card the Coach transcript shows for every `log_*` tool result —
/// icon, title, a detail line ("520 kcal · 32 g protein", "82.4 kg"), a
/// timestamp, and Undo/Edit. §5.5: "Undo stays available for 10 minutes."
/// Pure view — no networking, no state beyond what's passed in; the caller
/// owns the underlying log entry and supplies `onUndo`/`onEdit`.
struct LogReceiptCard: View {
    enum State: Equatable {
        /// The normal, actionable state — Undo/Edit both shown (`onEdit`
        /// only if the caller passed one).
        case normal
        /// Undo fired — struck-through, faded, "Undone" replaces the buttons.
        case undone
        /// Analyzing (e.g. a photo meal still awaiting the AI estimate) —
        /// static redacted placeholder, no shimmer/loop (see
        /// `SkeletonView`'s doc comment: the motion policy forbids
        /// `repeatForever` loops, even for loading states).
        case pending
    }

    let icon: String
    let title: String
    /// e.g. "520 kcal · 32 g protein" or "82.4 kg".
    let detail: String
    /// Preformatted, e.g. "2:14 PM" — callers own locale/relative-time
    /// formatting rather than this view guessing at it.
    let timestamp: String
    var state: State = .normal
    var onUndo: (() -> Void)?
    var onEdit: (() -> Void)?

    var body: some View {
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            HStack(spacing: Theme.Spacing.md) {
                IconBadge(systemName: icon, style: state == .undone ? .neutral : .soft)

                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .strikethrough(state == .undone)
                        .lineLimit(1)

                    Text(state == .pending ? "Analyzing…" : detail)
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(1)

                    Text(timestamp)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Spacer(minLength: Theme.Spacing.sm)

                trailing
            }
        }
        .opacity(state == .undone ? 0.55 : 1.0)
        .redacted(reason: state == .pending ? .placeholder : [])
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var trailing: some View {
        switch state {
        case .pending:
            EmptyView()

        case .undone:
            Text("Undone")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textTertiary)

        case .normal:
            HStack(spacing: Theme.Spacing.sm) {
                if let onEdit {
                    Button("Edit", action: onEdit)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                if let onUndo {
                    Button("Undo", action: onUndo)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.accentContent)
                }
            }
            .buttonStyle(.vital(scale: 1.0))
        }
    }

    private var accessibilityLabel: String {
        switch state {
        case .pending: return "\(title), analyzing"
        case .undone:  return "\(title), \(detail), undone"
        case .normal:  return "\(title), \(detail), logged \(timestamp)"
        }
    }
}

#Preview("LogReceiptCard — light") {
    LogReceiptCardPreviewList()
        .preferredColorScheme(.light)
}

#Preview("LogReceiptCard — dark") {
    LogReceiptCardPreviewList()
        .preferredColorScheme(.dark)
}

private struct LogReceiptCardPreviewList: View {
    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                LogReceiptCard(
                    icon: "fork.knife",
                    title: "Chicken bowl",
                    detail: "520 kcal · 32 g protein",
                    timestamp: "2:14 PM",
                    onUndo: {},
                    onEdit: {}
                )
                LogReceiptCard(
                    icon: "scalemass",
                    title: "Weigh-in",
                    detail: "82.4 kg",
                    timestamp: "7:02 AM",
                    onUndo: {}
                )
                LogReceiptCard(
                    icon: "fork.knife",
                    title: "Greek yogurt",
                    detail: "180 kcal · 18 g protein",
                    timestamp: "9:40 AM",
                    state: .undone
                )
                LogReceiptCard(
                    icon: "camera",
                    title: "Analyzing your meal…",
                    detail: "",
                    timestamp: "12:01 PM",
                    state: .pending
                )
            }
            .padding()
        }
        .background(Theme.Colors.canvas)
    }
}
