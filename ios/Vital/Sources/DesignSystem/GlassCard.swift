import SwiftUI

/// A frosted-glass card with a subtle border — the iOS 26 Liquid Glass look.
struct GlassCard<Content: View>: View {
    var padding: CGFloat = Theme.Spacing.xl
    var cornerRadius: CGFloat = Theme.Radius.lg
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.5)
                    )
            )
            .shadow(color: .black.opacity(0.20), radius: 12, x: 0, y: 6)
    }
}
