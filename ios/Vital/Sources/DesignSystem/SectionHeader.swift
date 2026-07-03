import SwiftUI

/// A small uppercase section label with an optional trailing action link.
struct SectionHeader: View {
    let title: String
    var actionLabel: String? = nil
    var onAction: (() -> Void)? = nil

    var body: some View {
        HStack {
            Text(title.uppercased())
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
                .tracking(0.8)

            Spacer()

            if let actionLabel, let onAction {
                Button(action: onAction) {
                    Text(actionLabel)
                        .font(Theme.Typography.labelMedium)
                        .foregroundStyle(Theme.Colors.accent)
                }
            }
        }
    }
}
