import SwiftUI

/// A small pill-shaped tag, optionally tinted with the lime accent.
struct Chip: View {
    let text: String
    var icon: String? = nil
    var isAccent: Bool = false
    /// Explicit semantic tint (foreground + a matching translucent fill),
    /// for callers whose color isn't the binary accent/neutral `isAccent`
    /// covers — e.g. the Trends grid's verdict chips, tinted by
    /// `TrendDirection.resolve(...).color` (positive/alert/gray per metric
    /// polarity, never the lime accent). Takes precedence over `isAccent`
    /// when set; existing call sites that only pass `isAccent` are unaffected.
    var tint: Color? = nil

    private var fillColor: Color {
        if let tint { return tint.opacity(0.16) }
        return isAccent ? Theme.Colors.accentSoft : Theme.Colors.glassFill
    }
    private var foreground: Color {
        if let tint { return tint }
        return isAccent ? Theme.Colors.accentContent : Theme.Colors.textSecondary
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
