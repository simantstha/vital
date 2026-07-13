import SwiftUI

struct AnalysisView: View {
    let kind: String
    let id: String
    @EnvironmentObject private var router: AppRouter
    @Environment(\.dismiss) private var dismiss
    @State private var analysis: AnalysisResponse?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Colors.canvas.ignoresSafeArea()
                Group {
                    if loading { ProgressView() }
                    else if let analysis { content(analysis) }
                    else { ContentUnavailableView("Analysis unavailable", systemImage: "chart.line.downtrend.xyaxis", description: Text(error ?? "This analysis is no longer available.")) }
                }
            }
            .navigationTitle(kind == "workout" ? "Workout Analysis" : "Sleep Analysis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .task { await load() }
    }

    private func content(_ value: AnalysisResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                GlassCard { VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text(value.result.headline).font(Theme.Typography.titleMedium)
                    Text(value.result.shortInsight).foregroundStyle(Theme.Colors.textSecondary)
                    Text(value.result.narrative)
                }}
                analysisList("What stood out", value.result.observations)
                analysisList("Next steps", value.result.nextSteps)
                Button("Discuss with Coach") {
                    router.coachContext = "Let's discuss my \(kind) analysis from \(value.date): \(value.result.headline). \(value.result.shortInsight)"
                    router.route = nil
                }
                .buttonStyle(.borderedProminent).tint(Theme.Colors.accent).frame(maxWidth: .infinity)
            }.padding(Theme.Spacing.xl)
        }
    }

    private func analysisList(_ title: String, _ rows: [String]) -> some View {
        GlassCard { VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title).font(Theme.Typography.bodyMedium).fontWeight(.semibold)
            ForEach(rows, id: \.self) { Text("• \($0)").foregroundStyle(Theme.Colors.textSecondary) }
        }}
    }

    private func load() async {
        do { analysis = try await APIClient.shared.fetchAnalysis(kind: kind, id: id) }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}

struct WorkoutAnalysisView: View {
    let id: String
    var body: some View { AnalysisView(kind: "workout", id: id) }
}

struct SleepAnalysisView: View {
    let id: String
    var body: some View { AnalysisView(kind: "sleep", id: id) }
}
