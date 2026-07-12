import SwiftUI

/// The v3 card idiom: a flat `Theme.Colors.card` surface with a soft hairline
/// shadow (light mode) or a subtle border (dark mode, where the shadow is
/// invisible against the dark canvas). Mirrors the mock's
/// `rounded-3xl bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]` class.
///
/// This is the v3 replacement for `GlassCard`. `GlassCard` is not deleted —
/// call sites migrate incrementally — but new v3 surfaces should use this.
struct VitalCard<Content: View>: View {
    var padding: CGFloat = Theme.Spacing.xl
    var cornerRadius: CGFloat = Theme.Radius.xl
    @ViewBuilder var content: () -> Content

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        content()
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Theme.Colors.card)
                    .overlay(
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .strokeBorder(
                                colorScheme == .dark ? Color.white.opacity(0.08) : .clear,
                                lineWidth: 0.5
                            )
                    )
            )
            .shadow(color: Theme.Colors.cardShadow, radius: 2, x: 0, y: 1)
    }
}
