import SwiftUI

/// A one-line coach insight presented in a lime-tinted glass bubble.
struct CoachBubble: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            // Avatar dot
            Circle()
                .fill(Theme.Colors.accent)
                .frame(width: 36, height: 36)
                .overlay(
                    Image(systemName: "message.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.canvas)
                )

            Text(message.asMarkdown)
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.Spacing.lg)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Colors.accent.opacity(0.10))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .strokeBorder(Theme.Colors.accent.opacity(0.20), lineWidth: 0.5)
                )
        )
    }
}
