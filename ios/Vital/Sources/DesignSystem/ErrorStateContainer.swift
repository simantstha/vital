import SwiftUI

/// The shared "whole screen failed to load" layout: a calm SF Symbol above
/// one or more `ErrorCard`s, positioned in the upper-middle third of the
/// available space rather than pinned directly under the screen's header
/// with a void below. Use this wherever a screen has **no** other content to
/// show alongside the error (see `ErrorCard`'s own doc comment for when a
/// card should sit inline with partially-loaded content instead — that case
/// stays a bare `ErrorCard`, not this container).
///
/// Today, Trends, Logs and Profile's full-screen failures all wrap their
/// `ErrorCard`(s) in this. `content` is `@ViewBuilder` so a caller with two
/// related errors (Trends' weekly-summary + grid failures firing together)
/// can stack them as one `VStack` and still get a single, centered
/// treatment instead of two cards independently pinned to the top.
struct ErrorStateContainer<Content: View>: View {
    /// A calm, non-alarming glyph — never `exclamationmark.triangle` (that's
    /// `ErrorCard`'s own icon, reserved for the card itself) and never a
    /// literal "broken" symbol. `wifi.exclamationmark` reads correctly for
    /// the overwhelming majority of these failures (a network read), and
    /// `exclamationmark.icloud` is the other sanctioned choice for a
    /// specifically sync-flavored failure.
    var icon: String = "wifi.exclamationmark"
    @ViewBuilder var content: () -> Content

    /// Roughly centers the icon+card(s) group in the screen's upper-middle
    /// third: a bit more room below than above so the group doesn't read as
    /// glued to the header, while still leaving the bulk of the screen open
    /// rather than centering dead in the middle (which would fight the
    /// header above it). `minHeight` gives the two `Spacer`s something to
    /// actually distribute — inside a `ScrollView` a bare `VStack` sizes to
    /// its content and the spacers would collapse to zero.
    private static var minHeight: CGFloat { 460 }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: Theme.Spacing.xxxl)

            VStack(spacing: Theme.Spacing.lg) {
                Image(systemName: icon)
                    .font(.system(size: 44, weight: .regular))
                    .foregroundStyle(Theme.Colors.textSecondary)

                content()
            }
            .frame(maxWidth: .infinity)

            Spacer(minLength: Theme.Spacing.xxxl * 3)
        }
        .frame(maxWidth: .infinity, minHeight: Self.minHeight)
        .motionTransition(.fade)
    }
}
