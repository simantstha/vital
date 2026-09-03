import SwiftUI

/// A one-line coach insight presented in a pale-lime (`accentSoft`) bubble,
/// matching the v3 mock's coach message idiom.
struct CoachBubble: View {
    let message: String

    /// `true` when there's nothing to show — e.g. the brief cache missed and
    /// `/api/today` returned `insight: ''`. Exposed so callers embedding this
    /// view in a spaced stack (see `TodayView`) can skip it entirely instead
    /// of leaving a blank pale-lime shell (or a floating gap where one would
    /// have been).
    static func isEmpty(_ message: String) -> Bool {
        message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        if Self.isEmpty(message) {
            EmptyView()
        } else {
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
}
