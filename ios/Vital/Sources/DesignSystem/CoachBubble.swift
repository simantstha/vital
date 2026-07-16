import SwiftUI

/// A one-line coach insight presented in a pale-lime (`accentSoft`) bubble,
/// matching the v3 mock's coach message idiom.
struct CoachBubble: View {
    let message: String

    var body: some View {
        Text(message.asMarkdown)
            .font(.system(size: 16, weight: .regular))
            .foregroundStyle(Theme.Colors.textPrimary)
            .lineSpacing(6.4) // ~1.4x line height at 16pt
            .fixedSize(horizontal: false, vertical: true)
            .padding(Theme.Spacing.lg)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.Colors.accentSoft)
            )
    }
}
