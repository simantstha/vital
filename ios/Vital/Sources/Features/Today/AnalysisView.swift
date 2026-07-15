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
                if let metrics = value.metrics {
                    AnalysisMetricsCard(kind: kind, metrics: metrics)
                }
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

// MARK: - Metrics card

/// Raw HealthKit numbers above the narrative — workout hero + tile grid, or
/// sleep hero + stage bar. Hidden entirely when the response has no metrics.
private struct AnalysisMetricsCard: View {
    let kind: String
    let metrics: AnalysisMetrics

    var body: some View {
        GlassCard {
            Group {
                if kind == "workout" { workout } else { sleep }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Workout

    private var workout: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(workoutKicker)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.Colors.textSecondary)
            if !workoutHero.isEmpty {
                Text(workoutHero)
                    .font(Theme.Typography.numericLarge())
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            if !workoutTiles.isEmpty {
                LazyVGrid(
                    columns: [GridItem(.flexible()), GridItem(.flexible())],
                    spacing: Theme.Spacing.sm
                ) {
                    ForEach(workoutTiles, id: \.label) { tile in
                        metricTile(value: tile.value, label: tile.label)
                    }
                }
            }
        }
    }

    /// "RUNNING · SAT 7:41 AM" — type plus local weekday+time from startTime.
    private var workoutKicker: String {
        var parts = [metrics.type ?? "Workout"]
        if let start = metrics.startTime.flatMap(Self.parseISO) {
            parts.append(Self.weekdayTimeFormatter.string(from: start))
        }
        return parts.joined(separator: " · ").uppercased()
    }

    /// "59 min · 97 kcal" from whichever of duration/kcal are present.
    private var workoutHero: String {
        var parts: [String] = []
        if let minutes = metrics.durationMin { parts.append("\(Int(minutes.rounded())) min") }
        if let kcal = metrics.kcal { parts.append("\(Int(kcal.rounded())) kcal") }
        return parts.joined(separator: " · ")
    }

    private var workoutTiles: [(value: String, label: String)] {
        var tiles: [(value: String, label: String)] = []
        if let avgHr = metrics.avgHr { tiles.append(("\(Int(avgHr.rounded())) bpm", "Avg HR")) }
        if let maxHr = metrics.maxHr { tiles.append(("\(Int(maxHr.rounded())) bpm", "Max HR")) }
        if let distanceM = metrics.distanceM {
            tiles.append((String(format: "%.1f km", distanceM / 1000), "Distance"))
        }
        if let pace = metrics.paceMinPerKm { tiles.append((Self.paceLabel(pace), "Pace /km")) }
        return tiles
    }

    private func metricTile(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text(value)
                .font(Theme.Typography.numericSmall())
                .foregroundStyle(Theme.Colors.textPrimary)
            Text(label)
                .font(Theme.Typography.labelSmall)
                .foregroundStyle(Theme.Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.md)
        .background(
            Theme.Colors.glassFill,
            in: .rect(cornerRadius: Theme.Radius.md, style: .continuous)
        )
    }

    // MARK: Sleep

    private struct StageSegment {
        let name: String
        let minutes: Double
        let color: Color
    }

    private var sleep: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if let minutes = metrics.minutes {
                Text("\(Self.hoursMinutes(minutes)) asleep")
                    .font(Theme.Typography.numericLarge())
                    .foregroundStyle(Theme.Colors.textPrimary)
            }
            let segments = stageSegments
            if !segments.isEmpty {
                stageBar(segments)
                stageLegend(segments)
            }
        }
    }

    private var stageSegments: [StageSegment] {
        guard let stages = metrics.stages else { return [] }
        let all: [(String, Double?, Color)] = [
            ("Core", stages.core, Theme.Colors.indigo),
            ("Deep", stages.deep, Color(red: 0.318, green: 0.345, blue: 0.788)),
            ("REM", stages.rem, Color(red: 0.725, green: 0.745, blue: 1.0)),
            ("Awake", stages.awake, Theme.Colors.chartMuted),
        ]
        return all.compactMap { name, minutes, color in
            guard let minutes, minutes > 0 else { return nil }
            return StageSegment(name: name, minutes: minutes, color: color)
        }
    }

    private func stageBar(_ segments: [StageSegment]) -> some View {
        let total = segments.reduce(0) { $0 + $1.minutes }
        return GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(segments, id: \.name) { segment in
                    Rectangle()
                        .fill(segment.color)
                        .frame(width: geo.size.width * segment.minutes / total)
                }
            }
        }
        .frame(height: 14)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    private func stageLegend(_ segments: [StageSegment]) -> some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 96), alignment: .leading)],
            alignment: .leading,
            spacing: Theme.Spacing.xs
        ) {
            ForEach(segments, id: \.name) { segment in
                HStack(spacing: Theme.Spacing.xs) {
                    Circle().fill(segment.color).frame(width: 8, height: 8)
                    Text("\(segment.name) \(Self.hoursMinutes(segment.minutes))")
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }

    // MARK: Formatting

    private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoParserNF: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let weekdayTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE h:mm a"
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    private static func parseISO(_ value: String) -> Date? {
        isoParser.date(from: value) ?? isoParserNF.date(from: value)
    }

    /// 312 → "5h 12m"
    private static func hoursMinutes(_ minutes: Double) -> String {
        let total = Int(minutes.rounded())
        return "\(total / 60)h \(total % 60)m"
    }

    /// 5.78 → "5′47″"
    private static func paceLabel(_ minutesPerKm: Double) -> String {
        var wholeMinutes = Int(minutesPerKm)
        var seconds = Int(((minutesPerKm - Double(wholeMinutes)) * 60).rounded())
        if seconds == 60 { wholeMinutes += 1; seconds = 0 }
        return "\(wholeMinutes)′\(String(format: "%02d", seconds))″"
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
