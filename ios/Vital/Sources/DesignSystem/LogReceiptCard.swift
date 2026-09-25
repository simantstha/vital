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
        /// Undo tapped, request in flight — the button becomes non-tappable
        /// text so a second tap can't fire a second delete.
        case undoing
        /// The Undo request failed — an inline message replaces the detail
        /// line and the card keeps its Undo button so the user can retry.
        case undoFailed(String)
    }

    /// One quick portion-correction chip — ½×, 1×, 1.5×, or 2× the logged
    /// amount. `POST /api/meals/scale` (see `CoachViewModel.scaleMealLog`)
    /// applies the multiplier and remembers the resulting portion for next
    /// time (see that endpoint's doc comment). `1×` is shown but disabled
    /// (nothing to change) so the row always reads as a complete ½·1·1.5·2
    /// scale rather than three unexplained buttons.
    static let scaleFactors: [Double] = [0.5, 1.0, 1.5, 2.0]

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
    /// Portion-chip action: `nil` hides the chip row entirely (e.g. a
    /// weigh-in receipt, or once the card is `.undone`). Non-nil shows the
    /// ½×/1×/1.5×/2× row in `.normal` state only.
    var onScale: ((Double) -> Void)?

    var body: some View {
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.md) {
                    IconBadge(systemName: icon, style: state == .undone ? .neutral : .soft)

                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text(title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .strikethrough(state == .undone)
                            .lineLimit(1)

                        Text(detailText)
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(isUndoError ? Theme.Colors.alert : Theme.Colors.textSecondary)
                            .lineLimit(1)

                        Text(timestamp)
                            .font(Theme.Typography.labelSmall)
                            .foregroundStyle(Theme.Colors.textTertiary)
                    }

                    Spacer(minLength: Theme.Spacing.sm)

                    trailing
                }

                if state == .normal, let onScale {
                    scaleChips(onScale)
                }
            }
        }
        .opacity(state == .undone ? 0.55 : 1.0)
        .redacted(reason: state == .pending ? .placeholder : [])
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private func scaleChips(_ onScale: @escaping (Double) -> Void) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            ForEach(Self.scaleFactors, id: \.self) { factor in
                Button {
                    onScale(factor)
                } label: {
                    Text(Self.scaleLabel(factor))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(factor == 1.0 ? Theme.Colors.textTertiary : Theme.Colors.textSecondary)
                        .padding(.horizontal, Theme.Spacing.sm)
                        .padding(.vertical, Theme.Spacing.xxs)
                        .background(Capsule().fill(Theme.Colors.glassFill))
                }
                .disabled(factor == 1.0)
                .accessibilityLabel("Scale portion to \(Self.scaleLabel(factor))")
            }
        }
        .buttonStyle(.plain)
    }

    private static func scaleLabel(_ factor: Double) -> String {
        factor == factor.rounded() ? "\(Int(factor))×" : "\(factor)×"
    }

    /// The detail line's text: the analyzing placeholder, the failed-Undo
    /// message, or the normal macro summary.
    private var detailText: String {
        switch state {
        case .pending: return "Analyzing…"
        case .undoFailed(let message): return message
        default: return detail
        }
    }

    private var isUndoError: Bool {
        if case .undoFailed = state { return true }
        return false
    }

    @ViewBuilder
    private var trailing: some View {
        switch state {
        case .pending:
            EmptyView()

        case .undone:
            Text("Removed")
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textTertiary)

        case .undoing:
            ProgressView()
                .controlSize(.mini)

        case .normal, .undoFailed:
            HStack(spacing: Theme.Spacing.sm) {
                if let onEdit {
                    Button("Edit", action: onEdit)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                if let onUndo {
                    Button("Undo", action: onUndo)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(state == .normal ? Theme.Colors.accentContent : Theme.Colors.alert)
                }
            }
            .buttonStyle(.vital(scale: 1.0))
        }
    }

    private var accessibilityLabel: String {
        switch state {
        case .pending: return "\(title), analyzing"
        case .undone:  return "\(title), \(detail), undone"
        case .undoing: return "\(title), \(detail), removing"
        case .undoFailed(let message): return "\(title), \(detail), \(message)"
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
                    onEdit: {},
                    onScale: { _ in }
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
