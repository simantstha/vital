import SwiftUI

/// Stub destination for a Trends grid tile tap. PR5 replaces this with the
/// full scrubbable detail chart, ±1σ band, and distribution histogram — this
/// placeholder exists only so PR4 can ship the grid index (and prove
/// navigation actually works end to end) without blocking on that chart
/// work.
struct MetricDetailView: View {
    let metricKey: String

    private var spec: MetricSpec? { MetricCatalog.spec(for: metricKey) }

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()
            VStack(spacing: Theme.Spacing.md) {
                Image(systemName: "chart.xyaxis.line")
                    .font(.system(size: 32))
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text(spec?.displayName ?? metricKey)
                    .font(Theme.Typography.titleMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("Detail view coming soon")
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .navigationTitle(spec?.displayName ?? metricKey)
        .navigationBarTitleDisplayMode(.inline)
    }
}
