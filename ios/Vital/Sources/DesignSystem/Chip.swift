import SwiftUI

/// A small pill-shaped tag, optionally tinted with the lime accent.
struct Chip: View {
    let text: String
    var icon: String? = nil
    var isAccent: Bool = false

    private var fillColor: Color {
        isAccent ? Theme.Colors.accent.opacity(0.15) : Theme.Colors.glassFill
    }
    private var borderColor: Color {
        isAccent ? Theme.Colors.accent.opacity(0.30) : Theme.Colors.glassBorder
    }
    private var foreground: Color {
        isAccent ? Theme.Colors.accent : Theme.Colors.textSecondary
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
            }
            Text(text)
                .font(Theme.Typography.labelSmall)
                .fontWeight(.medium)
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            Capsule()
                .fill(fillColor)
                .overlay(
                    Capsule()
                        .strokeBorder(borderColor, lineWidth: 0.5)
                )
        )
    }
}
