import SwiftUI

/// Generic centered empty state — icon + message, optionally pinned to a
/// fixed height (e.g. to match the chart it replaces). Generalized from
/// `TrendsView.emptyChartPlaceholder`.
struct EmptyStateView: View {
    let icon: String
    let message: String
    var height: CGFloat? = nil

    var body: some View {
        HStack {
            Spacer()
            VStack(spacing: Theme.Spacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 28))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text(message)
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            Spacer()
        }
        .frame(height: height)
    }
}

#Preview {
    EmptyStateView(icon: "chart.line.uptrend.xyaxis", message: "No data yet", height: 180)
        .padding()
        .background(Theme.Colors.canvas)
}
