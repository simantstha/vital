import SwiftUI

/// A 40×40 rounded-16 icon square used by plan rows, log rows, sheets, and
/// settings rows. Mirrors the mock's `w-10 h-10 rounded-2xl` icon containers.
struct IconBadge: View {
    enum Style {
        /// Lime fill, near-black icon — used for the "now" / primary state.
        case accent
        /// Pale-lime fill, olive icon — the most common resting state.
        case soft
        /// Neutral glass-style fill, secondary-text icon — e.g. calendar items.
        case neutral
    }

    let systemName: String
    var style: Style = .soft
    var size: CGFloat = 40
    var cornerRadius: CGFloat = 16

    private var fillColor: Color {
        switch style {
        case .accent:  return Theme.Colors.accent
        case .soft:    return Theme.Colors.accentSoft
        case .neutral: return Theme.Colors.glassFill
        }
    }

    private var iconColor: Color {
        switch style {
        case .accent:  return Theme.Colors.onAccent
        case .soft:    return Theme.Colors.accentContent
        case .neutral: return Theme.Colors.textSecondary
        }
    }

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(fillColor)
            .frame(width: size, height: size)
            .overlay(
                Image(systemName: systemName)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(iconColor)
            )
    }
}
