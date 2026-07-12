import SwiftUI

/// A small pill-shaped tag, optionally tinted with the lime accent.
struct Chip: View {
    let text: String
    var icon: String? = nil
    var isAccent: Bool = false

    private var fillColor: Color {
        isAccent ? Theme.Colors.accentSoft : Theme.Colors.glassFill
    }
    private var foreground: Color {
        isAccent ? Theme.Colors.accentContent : Theme.Colors.textSecondary
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
            }
            Text(text)
                .font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            Capsule()
                .fill(fillColor)
        )
    }
}
