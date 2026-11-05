import SwiftUI

struct StatBadge: View {
    let label: String
    let value: String
    /// Stretch the card to the row's height (content pinned top-leading).
    var fillsHeight: Bool = false

    var body: some View {
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(label.uppercased())
                    .scaledFont(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .tracking(0.5)
                Text(value)
                    .scaledFont(Theme.Typography.numericSmall(13))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, maxHeight: fillsHeight ? .infinity : nil, alignment: .topLeading)
        }
    }
}
