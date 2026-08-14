import SwiftUI

struct StatBadge: View {
    let label: String
    let value: String

    var body: some View {
        VitalCard(padding: Theme.Spacing.md, cornerRadius: Theme.Radius.md) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(label.uppercased())
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .tracking(0.5)
                Text(value)
                    .font(Theme.Typography.numericSmall(13))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
