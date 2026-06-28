import SwiftUI

/// A floating Liquid Glass surface — the primary container of the app.
///
/// Uses the real iOS 26 `.glassEffect()` (not a faux `.ultraThinMaterial`),
/// so it refracts the content behind it and carries its own adaptive
/// elevation in both light and dark mode. The effect is applied *after*
/// padding so the glass hugs the content, per Apple's adoption guidance.
struct GlassCard<Content: View>: View {
    var padding: CGFloat = Theme.Spacing.xl
    var cornerRadius: CGFloat = Theme.Radius.lg
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .glassEffect(
                .regular,
                in: .rect(cornerRadius: cornerRadius, style: .continuous)
            )
    }
}
