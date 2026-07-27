import SwiftUI

/// A persistent, recoverable-load-error surface: an `exclamationmark.triangle`
/// icon, a bold title naming what failed, a two-line detail message, and a
/// trailing action. Use this wherever a screen's `errorMessage` should replace
/// (or sit above) its content instead of failing silently — never as a toast,
/// since load errors are persistent state, not a one-off event.
///
/// The action defaults to "Retry" because most callers are re-running an
/// idempotent read. **Callers whose failure is not safely repeatable must pass
/// a dismiss action instead** (`actionLabel: "Dismiss"`, `actionIcon: "xmark"`,
/// with a closure that just clears `errorMessage`). The trap: a request that
/// failed may still have committed a non-idempotent server write before it
/// failed. Coach is the live example — `runCoach` in `lib/brain/coach.ts`
/// persists the user's message to the `messages` table as step 1, before any
/// model call, and that path has no idempotency key. Every failure worth
/// retrying (model error, tool failure, timeout) happens *after* that insert,
/// so replaying the turn would write a second row, and the next launch would
/// restore the user's question twice — permanently. When unsure whether the
/// failed operation wrote anything, offer dismiss and let the user re-trigger
/// deliberately.
struct ErrorCard: View {
    let title: String
    let message: String
    let actionLabel: String
    let actionIcon: String
    let onAction: () -> Void

    init(
        title: String,
        message: String,
        actionLabel: String = "Retry",
        actionIcon: String = "arrow.clockwise",
        onAction: @escaping () -> Void
    ) {
        self.title = title
        self.message = message
        self.actionLabel = actionLabel
        self.actionIcon = actionIcon
        self.onAction = onAction
    }

    var body: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.md) {
            HStack(alignment: .center, spacing: Theme.Spacing.md) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Colors.alert)

                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(title)
                        .font(Theme.Typography.bodySmall)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(message)
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .lineLimit(2)
                }

                Spacer(minLength: Theme.Spacing.sm)

                Button(action: onAction) {
                    Label(actionLabel, systemImage: actionIcon)
                        .font(Theme.Typography.labelMedium)
                        .foregroundStyle(Theme.Colors.accentContent)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
