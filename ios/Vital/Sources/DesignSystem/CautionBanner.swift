import SwiftUI

/// Guidance banner for something the user should read but that isn't a
/// failure (e.g. a diet target at/under the low-energy-availability floor —
/// see `LowEnergyWarning` in APIClient.swift). Distinct from `ErrorCard`,
/// which uses `Theme.Colors.alert` (red) for a load failure; this uses the
/// `caution` (amber) family, which reads as guidance rather than "something
/// broke". Purely presentational — callers that need actions (e.g.
/// `DietBudgetEditorView`'s "Use {threshold}" / "Keep {value}" pair) render
/// their own buttons below this view.
///
/// Visual weight matches `FuelStripView`: same padding/radius scale, but a
/// `cautionSoft` fill + hairline `cautionLine` border instead of a card
/// surface + drop shadow, since there's no shadow contrast against the
/// canvas for a semi-transparent tinted fill.
struct CautionBanner: View {
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.Colors.caution)
                // Decorative — the title + body already say everything;
                // VoiceOver shouldn't stop on it separately.
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(title)
                    .font(Theme.Typography.bodyMedium)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(message)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.md + 2)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Colors.cautionSoft)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                        .strokeBorder(Theme.Colors.cautionLine, lineWidth: 1)
                )
        )
        // A single combined VoiceOver stop — "We eased your deficit. This is
        // below the ~1,200 kcal ..." — instead of exposing the title and body
        // as two separate nodes.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(message)")
    }
}

extension CautionBanner {
    /// Today's low-energy banner title flips on whether the server eased
    /// (floored) an auto-calculated deficit vs. is only flagging a
    /// user-pinned number that's already low — see `LowEnergyWarning` in
    /// APIClient.swift. Pulled out as a pure function so the flip is
    /// unit-testable without rendering SwiftUI.
    static func lowEnergyTitle(appliedFloor: Bool) -> String {
        appliedFloor ? "We eased your deficit" : "Below the safe floor"
    }
}
