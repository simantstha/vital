import SwiftUI

/// The coach's note on Today: plain markdown text with a 2pt accent rule on
/// its leading edge and no fill. The accent marks it as the live, "now"
/// guidance. Used on Today only; `CoachBubble` stays for the meal-log reaction.
struct CoachNote: View {
    let message: String

    /// `true` when there's nothing to show — callers skip the view entirely so
    /// an empty brief leaves no rule or gap behind.
    static func isEmpty(_ message: String) -> Bool {
        message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        if Self.isEmpty(message) {
            EmptyView()
        } else {
            Text(message.asMarkdown)
                .scaledFont(size: 16, weight: .regular)
                .foregroundStyle(Theme.Colors.textPrimary)
                .lineSpacing(6.4) // ~1.4x line height at 16pt
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, Theme.Spacing.lg)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(Theme.Colors.accent)
                        .frame(width: 2)
                }
                .accessibilityIdentifier("today.coachNote")
        }
    }
}
