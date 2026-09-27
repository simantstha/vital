import SwiftUI

struct AnalysisView: View {
    let kind: AnalysisKind
    let id: String
    @EnvironmentObject private var router: AppRouter
    @Environment(\.dismiss) private var dismiss
    @State private var analysis: AnalysisResponse?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        ZStack {
            Theme.Colors.canvas.ignoresSafeArea()
            Group {
                if loading {
                    ProgressView().motionTransition(.fade)
                } else if let analysis {
                    content(analysis).motionTransition(.fade)
                } else {
                    VStack {
                        doneRow
                        Spacer()
                        ContentUnavailableView(
                            "\(kind.title) unavailable",
                            systemImage: "chart.line.downtrend.xyaxis",
                            description: Text(error ?? "This analysis is no longer available.")
                        )
                        Spacer()
                    }
                    .padding(Theme.Spacing.xl)
                    .motionTransition(.fade)
                }
            }
        }
        .task { await load() }
    }

    private var doneRow: some View {
        HStack {
            Spacer()
            Button("Done") { dismiss() }
                .buttonStyle(.plain)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
                .padding(.horizontal, Theme.Spacing.lg)
                .frame(minHeight: 44)
                .background(Theme.Colors.glassFill, in: Capsule())
                .accessibilityIdentifier("analysis.done")
        }
    }

    @ViewBuilder
    private func content(_ value: AnalysisResponse) -> some View {
        switch kind.metrics {
        case "workout":
            WorkoutAnalysisContent(value: value, doneAction: { dismiss() }, kind: kind)
        case "sleep":
            SleepAnalysisContent(value: value, doneAction: { dismiss() }, kind: kind)
        default:
            genericContent(value)
        }
    }

    /// Morning briefs (`kind.metrics == nil`) keep the pre-v2 layout — this
    /// rewrite is scoped to workout/sleep analyses only (analysis-v2-contract.md §2).
    private func genericContent(_ value: AnalysisResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                HStack {
                    Text(kind.title).font(Theme.Typography.titleMedium)
                    Spacer()
                    Button("Done") { dismiss() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("analysis.done")
                }
                GlassCard { VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text(value.result.headline).font(Theme.Typography.titleMedium)
                    Text(value.result.narrative)
                }}
                analysisList("What stood out", value.result.observations)
                analysisList("Next steps", value.result.nextSteps)
                Button("Discuss with Coach") {
                    router.coachContext = "Let's discuss my \(kind.subject) from \(value.date): \(value.result.headline). \(value.result.shortInsight)"
                    router.route = nil
                }
                .buttonStyle(.borderedProminent).tint(Theme.Colors.accent).frame(maxWidth: .infinity)
            }.padding(Theme.Spacing.xl)
        }
    }

    @ViewBuilder
    private func analysisList(_ title: String, _ rows: [String]) -> some View {
        if rows.isEmpty {
            EmptyView()
        } else {
            GlassCard { VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(title).font(Theme.Typography.bodyMedium).fontWeight(.semibold)
                ForEach(rows, id: \.self) { Text("• \($0)").foregroundStyle(Theme.Colors.textSecondary) }
            }}
        }
    }

    private func load() async {
        do { analysis = try await APIClient.shared.fetchAnalysis(resource: kind.resource, id: id) }
        catch APIError.serverError(404) {
            // Genuinely gone (deleted or never had a result) — leave `error` nil so the
            // view falls back to its "This analysis is no longer available." copy
            // instead of a generic "Couldn't load — try again." Still log for production
            // visibility; discard the copy since we don't show it here.
            _ = UserFacingError.message(for: APIError.serverError(404), context: .read, tag: "fetchAnalysis")
        }
        catch { self.error = UserFacingError.message(for: error, context: .read, tag: "fetchAnalysis") }
        withAnimation(Theme.Motion.appear) { loading = false }
    }
}

// MARK: - Shared header / chip / section primitives

/// The "RUN · SAT 7:41 AM" / "LAST NIGHT · SAT → SUN" kicker row, plus the
/// pill "Done" button — analysis-v2-contract.md §2's header.
private struct AnalysisHeader: View {
    let iconSystemName: String
    let kickerText: String
    let title: String
    let subline: String
    let doneAction: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack {
                HStack(spacing: Theme.Spacing.sm) {
                    IconBadge(systemName: iconSystemName, style: .soft, size: 28, cornerRadius: 14)
                    Text(kickerText)
                        .font(.system(size: 12, weight: .bold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                .accessibilityIdentifier("analysis.kicker")
                Spacer()
                Button("Done", action: doneAction)
                    .buttonStyle(.plain)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .padding(.horizontal, Theme.Spacing.lg)
                    .frame(minHeight: 44)
                    .background(Theme.Colors.glassFill, in: Capsule())
                    .accessibilityIdentifier("analysis.done")
            }
            Text(title)
                .font(.system(size: 28, weight: .bold))
                .tracking(-0.3)
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Text(subline)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct SectionHeader: View {
    let title: String
    var trailing: String = ""

    var body: some View {
        HStack(alignment: .lastTextBaseline) {
            Text(title)
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            if !trailing.isEmpty {
                Text(trailing)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
    }
}

private struct ChipView: View {
    let chip: AnalysisLogic.Chip

    private var foreground: Color {
        switch chip.tone {
        case .good: Theme.Colors.positive
        case .watch: Theme.Colors.caution
        case .neutral: Theme.Colors.textSecondary
        }
    }

    private var background: Color {
        switch chip.tone {
        case .good: Theme.Colors.positive.opacity(0.14)
        case .watch: Theme.Colors.cautionSoft
        case .neutral: Theme.Colors.glassFill
        }
    }

    var body: some View {
        Text(chip.text)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(foreground)
            .lineLimit(1)
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, 3)
            .background(background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// One icon + label + trailing chip row — "Going in" / "Before bed" /
/// "This morning" all use this shape.
private struct DataRow: View {
    let icon: String
    let label: String
    let chip: AnalysisLogic.Chip
    var isFirst: Bool = false

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 20)
            Text(label)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textPrimary)
            Spacer()
            ChipView(chip: chip)
        }
        .padding(.vertical, Theme.Spacing.sm + 1)
        .overlay(alignment: .top) {
            if !isFirst {
                Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5)
            }
        }
        .frame(minHeight: 44)
    }
}

/// "Coach's take" card — the model's narrative plus its observations as
/// accent-rule lines (analysis-v2-contract.md §2).
private struct CoachTakeCard: View {
    let narrative: String
    let observations: [String]

    var body: some View {
        VitalCard {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.sm) {
                    ZStack {
                        Circle().fill(Theme.Colors.accent).frame(width: 26, height: 26)
                        Image(systemName: "bubble.left.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.Colors.onAccent)
                    }
                    Text("Coach's take")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                Text(narrative)
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(observations, id: \.self) { observation in
                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                        RoundedRectangle(cornerRadius: 2).fill(Theme.Colors.accentContent).frame(width: 3)
                        Text(observation)
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.Colors.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}

/// "NEXT" card — the first next step, a "Plan it with coach" primary button
/// wired to the existing `router.coachContext` behaviour, and "Not now".
private struct NextStepCard: View {
    let step: String
    let planLabel: String
    let onPlan: () -> Void
    @State private var dismissed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if dismissed {
            EmptyView()
        } else {
            VitalCard {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("NEXT")
                        .font(.system(size: 12, weight: .bold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.Colors.textSecondary)
                    Text(step)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: Theme.Spacing.sm) {
                        Button(planLabel, action: onPlan)
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.Colors.accent)
                            .foregroundStyle(Theme.Colors.onAccent)
                            .frame(maxWidth: .infinity, minHeight: 44)
                        Button("Not now") { withAnimation(reduceMotion ? nil : Theme.Motion.standard) { dismissed = true } }
                            .buttonStyle(.bordered)
                            .frame(minHeight: 44)
                    }
                    .padding(.top, Theme.Spacing.xs)
                }
            }
        }
    }
}

/// "Ask coach about …" link at the bottom of every analysis screen.
private struct AskCoachLink: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "bubble.left.fill")
                Text(label)
            }
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Theme.Colors.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(Theme.Colors.card, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("analysis.askCoach")
    }
}

// MARK: - Workout content

private struct WorkoutAnalysisContent: View {
    let value: AnalysisResponse
    let doneAction: () -> Void
    let kind: AnalysisKind
    @EnvironmentObject private var router: AppRouter
    @ObservedObject private var unitPref = UnitPreference.shared

    private var metrics: AnalysisMetrics? { value.metrics }
    private var context: AnalysisContext? { value.context }
    private var type: String { metrics?.type ?? "Workout" }
    private var startDate: Date? { metrics?.startTime.flatMap(AnalysisView.parseISO) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxl) {
                AnalysisHeader(
                    iconSystemName: "figure.run",
                    kickerText: startDate.map { AnalysisLogic.workoutKicker(type: type, startTime: $0) } ?? type.uppercased(),
                    title: value.result.headline,
                    subline: value.result.shortInsight,
                    doneAction: doneAction
                )
                .accessibilityIdentifier("analysisWorkout.header")

                statsRow

                if let paceHistory = context?.paceHistory, let metrics, metrics.paceMinPerKm != nil {
                    paceHistorySection(paceHistory)
                }

                if let effort = context?.effort {
                    effortSection(effort)
                }

                if let goingIn = context?.goingIn, hasGoingInData(goingIn) {
                    goingInSection(goingIn)
                }

                if !value.result.narrative.isEmpty {
                    CoachTakeCard(narrative: value.result.narrative, observations: value.result.observations)
                }

                howYourBodyTookIt

                if let nextStep = value.result.nextSteps.first {
                    NextStepCard(step: nextStep, planLabel: "Plan it with coach") {
                        router.coachContext = "Let's plan around my workout from \(value.date): \(value.result.headline). \(nextStep)"
                        router.route = nil
                    }
                }

                AskCoachLink(label: "Ask coach about this run") {
                    router.coachContext = "Let's discuss my \(kind.subject) from \(value.date): \(value.result.headline). \(value.result.shortInsight)"
                    router.route = nil
                }
            }
            .padding(Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.xxl)
        }
    }

    private func hasGoingInData(_ goingIn: AnalysisContext.GoingIn) -> Bool {
        goingIn.sleepMinutes != nil || goingIn.hrv != nil || goingIn.daysSinceLastSameType != nil
    }

    // MARK: Stats row

    private struct Stat { let value: String; let unit: String; let label: String; let chip: AnalysisLogic.Chip? }

    private var stats: [Stat] {
        guard let metrics else { return [] }
        let usual = context?.usual
        if let distanceM = metrics.distanceM {
            var list: [Stat] = [Stat(
                value: UnitFormat.distance(metres: distanceM, unitPref.current),
                unit: "", label: "distance",
                chip: usual?.distanceM.map { AnalysisLogic.distanceChip(distanceM: distanceM, usualDistanceM: $0, unit: unitPref.current) }
            )]
            if let durationMin = metrics.durationMin {
                list.append(Stat(value: Self.durationLabel(durationMin), unit: "", label: "time", chip: nil))
            }
            if let pace = metrics.paceMinPerKm {
                list.append(Stat(
                    value: UnitFormat.pace(minPerKm: pace, unitPref.current), unit: unitPref.current.paceUnit, label: "pace",
                    chip: usual?.paceMinPerKm.map { AnalysisLogic.paceChip(paceMinPerKm: pace, usualPaceMinPerKm: $0) }
                ))
            }
            return list
        }
        var list: [Stat] = []
        if let durationMin = metrics.durationMin {
            list.append(Stat(value: Self.durationLabel(durationMin), unit: "", label: "time", chip: nil))
        }
        if let kcal = metrics.kcal {
            list.append(Stat(value: "\(Int(kcal.rounded()))", unit: "kcal", label: "energy", chip: nil))
        }
        if let avgHr = metrics.avgHr {
            list.append(Stat(
                value: "\(Int(avgHr.rounded()))", unit: "bpm", label: "avg HR",
                chip: usual?.avgHr.map { AnalysisLogic.avgHrChip(avgHr: avgHr, usualAvgHr: $0) }
            ))
        }
        return list
    }

    private static func durationLabel(_ minutes: Double) -> String {
        let total = Int(minutes.rounded())
        return "\(total / 60):\(String(format: "%02d", total % 60))"
    }

    @ViewBuilder
    private var statsRow: some View {
        if !stats.isEmpty {
            VitalCard {
                HStack(alignment: .top, spacing: Theme.Spacing.md) {
                    ForEach(Array(stats.enumerated()), id: \.offset) { _, stat in
                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                            HStack(alignment: .lastTextBaseline, spacing: 3) {
                                Text(stat.value).font(Theme.Typography.numericLarge(26)).foregroundStyle(Theme.Colors.textPrimary)
                                if !stat.unit.isEmpty {
                                    Text(stat.unit).font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }
                            Text(stat.label).font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                            if let chip = stat.chip {
                                ChipView(chip: chip).padding(.top, Theme.Spacing.xxs)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(stats.map { "\($0.label) \($0.value) \($0.unit)" }.joined(separator: ", "))
        }
    }

    // MARK: Pace history

    private func paceHistorySection(_ paceHistory: AnalysisContext.PaceHistory) -> some View {
        let total = paceHistory.previous.count + 1
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Compared to your last \(total) runs", trailing: "pace")
            VitalCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    PaceHistoryStrip(previous: paceHistory.previous, current: value.metrics?.paceMinPerKm ?? 0)
                        .frame(height: 40)
                        .accessibilityLabel(AnalysisLogic.paceRankPhrase(rank: paceHistory.rank, previousCount: paceHistory.previous.count))
                    HStack {
                        Text("slower").font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                        Spacer()
                        Text("faster").font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    Text(AnalysisLogic.paceRankPhrase(rank: paceHistory.rank, previousCount: paceHistory.previous.count))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }

    // MARK: Effort

    private func effortSection(_ effort: AnalysisContext.Effort) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Effort")
            VitalCard {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    HStack(alignment: .lastTextBaseline) {
                        Text(AnalysisLogic.effortZoneLabel(effort.zone))
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Spacer()
                        if let avgHr = metrics?.avgHr, let maxHr = metrics?.maxHr {
                            Text("avg \(Int(avgHr.rounded())) · max \(Int(maxHr.rounded())) bpm")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    EffortZoneBar(
                        avgFraction: effort.avgPct,
                        markerFraction: metrics?.maxHr.map { AnalysisLogic.heartRateRangeFraction($0, restingHr: effort.restingHr, maxHr: effort.maxHr) }
                    )
                    .frame(height: 44)
                    .accessibilityLabel("Effort \(Int((effort.avgPct * 100).rounded()))% of your heart rate range, \(AnalysisLogic.effortZoneLabel(effort.zone).lowercased())")
                    HStack {
                        Text("resting \(Int(effort.restingHr.rounded()))").font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                        Spacer()
                        Text("highest recorded \(Int(effort.maxHr.rounded()))").font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    Text("\(Int((effort.avgPct * 100).rounded()))% of your heart-rate range for most of the run.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }

    // MARK: Going in

    private func goingInSection(_ goingIn: AnalysisContext.GoingIn) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Going in")
            VitalCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: 0) {
                    if let sleepMinutes = goingIn.sleepMinutes {
                        DataRow(icon: "bed.double.fill", label: "Sleep last night",
                                chip: .init(text: AnalysisLogic.formatDuration(sleepMinutes), tone: .neutral), isFirst: true)
                    }
                    if let hrv = goingIn.hrv {
                        DataRow(icon: "heart.fill", label: "HRV this morning",
                                chip: AnalysisLogic.recoveryChip(value: hrv.value, unit: hrv.unit, vsNormal: hrv.vsNormal, metric: .hrv),
                                isFirst: goingIn.sleepMinutes == nil)
                    }
                    if let days = goingIn.daysSinceLastSameType {
                        DataRow(icon: "clock.fill", label: "Since your last hard run",
                                chip: .init(text: "\(days) day\(days == 1 ? "" : "s")", tone: .neutral),
                                isFirst: goingIn.sleepMinutes == nil && goingIn.hrv == nil)
                    }
                    Text("From your data before the run started.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.xs)
                }
            }
        }
    }

    // MARK: How your body took it

    @ViewBuilder
    private var howYourBodyTookIt: some View {
        if let nextMorning = context?.nextMorning, nextMorning.hrv != nil || nextMorning.restingHr != nil {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionHeader(title: "How your body took it")
                VitalCard(padding: Theme.Spacing.lg) {
                    VStack(alignment: .leading, spacing: 0) {
                        if let hrv = nextMorning.hrv {
                            DataRow(icon: "heart.fill", label: "HRV",
                                    chip: AnalysisLogic.recoveryChip(value: hrv.value, unit: hrv.unit, vsNormal: hrv.vsNormal, metric: .hrv),
                                    isFirst: true)
                        }
                        if let restingHr = nextMorning.restingHr {
                            DataRow(icon: "heart.fill", label: "Resting heart rate",
                                    chip: AnalysisLogic.recoveryChip(value: restingHr.value, unit: restingHr.unit, vsNormal: restingHr.vsNormal, metric: .restingHr),
                                    isFirst: nextMorning.hrv == nil)
                        }
                    }
                }
            }
        } else {
            VitalCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: "sparkles").foregroundStyle(Theme.Colors.accentContent)
                        Text("How your body took it").font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.Colors.textPrimary)
                    }
                    Text("Check back tomorrow morning. I'll compare your HRV and resting heart rate to your normal and tell you if you're ready to go hard again.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .strokeBorder(Theme.Colors.glassBorder, style: StrokeStyle(lineWidth: 1.5, dash: [5]))
            )
            .background(Color.clear)
        }
    }
}

/// Dot strip for "Compared to your last N runs" — previous runs as small
/// muted dots on a baseline, today's run highlighted, left→right = slower→faster.
private struct PaceHistoryStrip: View {
    let previous: [Double] // min/km
    let current: Double

    var body: some View {
        GeometryReader { geo in
            strip(in: geo.size)
        }
    }

    /// Ordinary (non-`@ViewBuilder`) helper — the `let`/`guard`/nested-`func`
    /// here are plain Swift statements, kept out of the `GeometryReader`
    /// closure above so that closure stays a single view expression.
    private func strip(in size: CGSize) -> some View {
        let all = previous + [current]
        // Faster (lower pace) is on the right — invert so the fastest
        // value maps to the largest x.
        guard let minPace = all.min(), let maxPace = all.max(), maxPace > minPace else {
            return AnyView(
                Circle().fill(Theme.Colors.accent).frame(width: 12, height: 12)
                    .position(x: size.width / 2, y: size.height / 2)
            )
        }
        let usableWidth = size.width - 20
        func x(for pace: Double) -> CGFloat {
            let fraction = (maxPace - pace) / (maxPace - minPace)
            return 10 + CGFloat(fraction) * usableWidth
        }
        return AnyView(
            ZStack {
                Rectangle().fill(Theme.Colors.glassBorder).frame(height: 2)
                    .position(x: size.width / 2, y: size.height / 2)
                ForEach(Array(previous.enumerated()), id: \.offset) { _, pace in
                    Circle().fill(Theme.Colors.textTertiary.opacity(0.6)).frame(width: 8, height: 8)
                        .position(x: x(for: pace), y: size.height / 2)
                }
                Circle().fill(Theme.Colors.accent).frame(width: 14, height: 14)
                    .position(x: x(for: current), y: size.height / 2)
            }
        )
    }
}

/// Resting→max heart-rate zone bar with an avg marker (vertical tick) and an
/// optional second marker for this specific workout's own recorded max HR.
private struct EffortZoneBar: View {
    let avgFraction: Double
    let markerFraction: Double?

    private var bandColors: [Color] {
        [Theme.Colors.glassFill, Theme.Colors.accentSoft, Theme.Colors.accent, Theme.Colors.caution]
    }
    private var bandLabels: [String] { ["Easy", "Steady", "Hard", "Max"] }
    /// [0, 0.60, 0.75, 0.90, 1] — the four band edges as fractions of the
    /// full width. A stored computed property (not a local `let`) so the
    /// `GeometryReader` closure below stays a single expression.
    private var bandBounds: [Double] { [0] + AnalysisLogic.effortZoneBoundaries + [1] }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                HStack(spacing: 2) {
                    ForEach(0..<4, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(bandColors[i])
                            .frame(width: max(0, geo.size.width * CGFloat(bandBounds[i + 1] - bandBounds[i]) - 2))
                    }
                }
                .frame(height: 10)
                .offset(y: 6)

                Rectangle()
                    .fill(Theme.Colors.textPrimary)
                    .frame(width: 2.5, height: 22)
                    .position(x: geo.size.width * CGFloat(avgFraction), y: 12)

                if let markerFraction {
                    Circle()
                        .strokeBorder(Theme.Colors.textPrimary, lineWidth: 2)
                        .background(Circle().fill(Theme.Colors.card))
                        .frame(width: 9, height: 9)
                        .position(x: geo.size.width * CGFloat(markerFraction), y: 11)
                }

                HStack(spacing: 2) {
                    ForEach(0..<4, id: \.self) { i in
                        Text(bandLabels[i])
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .frame(width: geo.size.width * CGFloat(bandBounds[i + 1] - bandBounds[i]))
                    }
                }
                .offset(y: 30)
            }
        }
    }
}

// MARK: - Sleep content

private struct SleepAnalysisContent: View {
    let value: AnalysisResponse
    let doneAction: () -> Void
    let kind: AnalysisKind
    @EnvironmentObject private var router: AppRouter

    private var metrics: AnalysisMetrics? { value.metrics }
    private var context: AnalysisContext? { value.context }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxl) {
                AnalysisHeader(
                    iconSystemName: "moon.stars.fill",
                    kickerText: context?.timing.map { AnalysisLogic.sleepKicker(bedTime: $0.bedTime, wakeTime: $0.wakeTime) } ?? "LAST NIGHT",
                    title: value.result.headline,
                    subline: value.result.shortInsight,
                    doneAction: doneAction
                )
                .accessibilityIdentifier("analysisSleep.header")

                hero

                stages

                if let beforeBed = context?.beforeBed, beforeBed.lastWorkoutEndedAt != nil || beforeBed.lastMealAt != nil,
                   let bedTime = context?.timing?.bedTime {
                    beforeBedSection(beforeBed, bedTime: bedTime)
                }

                if let thisMorning = context?.thisMorning, thisMorning.hrv != nil || thisMorning.restingHr != nil {
                    thisMorningSection(thisMorning)
                }

                if !value.result.narrative.isEmpty {
                    CoachTakeCard(narrative: value.result.narrative, observations: value.result.observations)
                }

                if let nextStep = value.result.nextSteps.first {
                    NextStepCard(step: nextStep, planLabel: "Update today's plan") {
                        router.coachContext = "Let's plan around last night's sleep from \(value.date): \(value.result.headline). \(nextStep)"
                        router.route = nil
                    }
                }

                if let week = context?.week, !week.isEmpty, let goalMinutes = context?.goalMinutes {
                    weekSection(week, goalMinutes: Double(goalMinutes))
                }

                AskCoachLink(label: "Ask coach about last night") {
                    router.coachContext = "Let's discuss my \(kind.subject) from \(value.date): \(value.result.headline). \(value.result.shortInsight)"
                    router.route = nil
                }
            }
            .padding(Theme.Spacing.xl)
            .padding(.bottom, Theme.Spacing.xxl)
        }
    }

    // MARK: Hero

    @ViewBuilder
    private var hero: some View {
        if let minutes = metrics?.minutes {
            VitalCard {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack(alignment: .lastTextBaseline, spacing: 6) {
                        Text(AnalysisLogic.formatDuration(minutes))
                            .font(Theme.Typography.numericHero(34))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("asleep").font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                    }
                    if let timing = context?.timing {
                        HStack(spacing: Theme.Spacing.sm) {
                            Image(systemName: "moon.fill").font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                            Text(AnalysisLogic.clockTime(timing.bedTime)).font(.system(size: 13)).foregroundStyle(Theme.Colors.textSecondary)
                            Image(systemName: "arrow.right").font(.system(size: 10)).foregroundStyle(Theme.Colors.textTertiary)
                            Image(systemName: "alarm.fill").font(.system(size: 12)).foregroundStyle(Theme.Colors.textSecondary)
                            Text(AnalysisLogic.clockTime(timing.wakeTime)).font(.system(size: 13)).foregroundStyle(Theme.Colors.textSecondary)
                        }
                    }
                    if let usual = context?.sleepUsual {
                        ChipView(chip: AnalysisLogic.sleepUsualChip(minutes: minutes, usualMinutes: usual.minutes))
                    }
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Stages

    @ViewBuilder
    private var stages: some View {
        if let hkStages = metrics?.stages, let usualStages = context?.sleepUsual?.stages {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionHeader(title: "Stages", trailing: "bar = last night · tick = your usual")
                VitalCard(padding: Theme.Spacing.md) {
                    VStack(alignment: .leading, spacing: 0) {
                        stageRow("Deep", minutes: hkStages.deep, usual: usualStages.deep, kind: .deep, isFirst: true)
                        stageRow("REM", minutes: hkStages.rem, usual: usualStages.rem, kind: .rem, isFirst: false)
                        stageRow("Core", minutes: hkStages.core, usual: usualStages.core, kind: .core, isFirst: false)
                        stageRow("Awake", minutes: hkStages.awake, usual: usualStages.awake, kind: .awake, isFirst: false)
                    }
                }
            }
        } else if let hkStages = metrics?.stages {
            stackedStageBar(hkStages)
        }
    }

    private func stageToneColor(_ kind: AnalysisLogic.SleepStageKind, minutes: Double, usual: Double) -> Color {
        AnalysisLogic.sleepStageTone(kind, minutes: minutes, usualMinutes: usual) == .watch
            ? Theme.Colors.caution
            : Theme.Colors.textSecondary
    }

    @ViewBuilder
    private func stageRow(_ label: String, minutes: Double?, usual: Double?, kind: AnalysisLogic.SleepStageKind, isFirst: Bool) -> some View {
        if let minutes, let usual {
            HStack(spacing: Theme.Spacing.md) {
                Text(label).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.Colors.textPrimary).frame(width: 54, alignment: .leading)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(stageColor(kind))
                            .frame(width: geo.size.width * CGFloat(AnalysisLogic.sleepStageBarFraction(minutes: minutes, usualMinutes: usual)), height: 10)
                        Rectangle()
                            .fill(Theme.Colors.textPrimary.opacity(0.55))
                            .frame(width: 2, height: 18)
                            .offset(x: geo.size.width * CGFloat(AnalysisLogic.sleepStageUsualTickFraction(minutes: minutes, usualMinutes: usual)) - 1)
                    }
                }
                .frame(height: 18)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(AnalysisLogic.formatDuration(minutes)).font(Theme.Typography.numericSmall(15)).foregroundStyle(Theme.Colors.textPrimary)
                    Text("usual \(AnalysisLogic.formatDuration(usual))")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(stageToneColor(kind, minutes: minutes, usual: usual))
                }
            }
            .padding(.vertical, Theme.Spacing.sm + 2)
            .frame(minHeight: 44)
            .overlay(alignment: .top) { if !isFirst { Rectangle().fill(Theme.Colors.glassBorder).frame(height: 0.5) } }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(label) \(AnalysisLogic.formatDuration(minutes)), usual \(AnalysisLogic.formatDuration(usual))")
        }
    }

    private func stageColor(_ kind: AnalysisLogic.SleepStageKind) -> Color {
        switch kind {
        case .deep: Color(red: 0.318, green: 0.345, blue: 0.788)
        case .rem: Color(red: 0.725, green: 0.745, blue: 1.0)
        case .core: Theme.Colors.indigo
        case .awake: Theme.Colors.chartMuted
        }
    }

    /// No `usual` baseline: fall back to a single stacked stage bar + legend
    /// (analysis-v2-contract.md §2).
    private func stackedStageBar(_ stages: AnalysisMetrics.SleepStages) -> some View {
        let segments: [(String, Double, Color)] = [
            ("Deep", stages.deep ?? 0, stageColor(.deep)),
            ("REM", stages.rem ?? 0, stageColor(.rem)),
            ("Core", stages.core ?? 0, stageColor(.core)),
            ("Awake", stages.awake ?? 0, stageColor(.awake)),
        ].filter { $0.1 > 0 }
        let total = segments.reduce(0) { $0 + $1.1 }
        guard total > 0 else { return AnyView(EmptyView()) }
        return AnyView(
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionHeader(title: "Stages")
                VitalCard {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        GeometryReader { geo in
                            HStack(spacing: 2) {
                                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                                        .fill(segment.2)
                                        .frame(width: geo.size.width * CGFloat(segment.1 / total))
                                }
                            }
                        }
                        .frame(height: 14)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(segments.map { "\($0.0) \(AnalysisLogic.formatDuration($0.1))" }.joined(separator: ", "))
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), alignment: .leading)], alignment: .leading, spacing: Theme.Spacing.xs) {
                            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                                HStack(spacing: Theme.Spacing.xs) {
                                    Circle().fill(segment.2).frame(width: 8, height: 8)
                                    Text("\(segment.0) \(AnalysisLogic.formatDuration(segment.1))")
                                        .font(.system(size: 11))
                                        .foregroundStyle(Theme.Colors.textSecondary)
                                }
                            }
                        }
                    }
                }
            }
        )
    }

    // MARK: Before bed

    private func beforeBedSection(_ beforeBed: AnalysisContext.BeforeBed, bedTime: Date) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Before bed")
            VitalCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: 0) {
                    if let workoutEnd = beforeBed.lastWorkoutEndedAt {
                        DataRow(icon: "figure.run", label: "Hard run ended",
                                chip: .init(text: AnalysisLogic.clockTime(workoutEnd), tone: .watch), isFirst: true)
                    }
                    if let mealAt = beforeBed.lastMealAt {
                        DataRow(icon: "fork.knife", label: "Last meal logged",
                                chip: .init(text: AnalysisLogic.clockTime(mealAt), tone: .watch),
                                isFirst: beforeBed.lastWorkoutEndedAt == nil)
                    }
                    Text("What I saw in your logs. These often go with lighter sleep — not proof they caused it.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.top, Theme.Spacing.xs)
                }
            }
        }
    }

    // MARK: This morning

    private func thisMorningSection(_ thisMorning: AnalysisContext.ThisMorning) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "This morning")
            VitalCard(padding: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: 0) {
                    if let hrv = thisMorning.hrv {
                        DataRow(icon: "heart.fill", label: "HRV",
                                chip: AnalysisLogic.recoveryChip(value: hrv.value, unit: hrv.unit, vsNormal: hrv.vsNormal, metric: .hrv),
                                isFirst: true)
                    }
                    if let restingHr = thisMorning.restingHr {
                        DataRow(icon: "heart.fill", label: "Resting heart rate",
                                chip: AnalysisLogic.recoveryChip(value: restingHr.value, unit: restingHr.unit, vsNormal: restingHr.vsNormal, metric: .restingHr),
                                isFirst: thisMorning.hrv == nil)
                    }
                }
            }
        }
    }

    // MARK: Week strip

    private static let weekBarWidth: CGFloat = 22
    private static let weekChartHeight: CGFloat = 100

    private func weekSection(_ week: [AnalysisContext.WeekNight], goalMinutes: Double) -> some View {
        let today = week.last?.date ?? ""
        let layout = AnalysisLogic.weekStripLayout(
            nights: week.map { ($0.date, $0.minutes) },
            goalMinutes: goalMinutes,
            today: today
        )
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader(title: "Last 7 nights", trailing: "goal \(AnalysisLogic.formatDuration(goalMinutes))")
            VitalCard {
                GeometryReader { geo in
                    ZStack(alignment: .bottomLeading) {
                        Rectangle()
                            .fill(Theme.Colors.textTertiary)
                            .frame(height: 1.5)
                            .offset(y: -Self.weekChartHeight * CGFloat(layout.goalLineFraction))
                        HStack(alignment: .bottom, spacing: (geo.size.width - CGFloat(layout.bars.count) * Self.weekBarWidth) / CGFloat(max(layout.bars.count - 1, 1))) {
                            ForEach(Array(layout.bars.enumerated()), id: \.offset) { _, bar in
                                VStack(spacing: Theme.Spacing.xs) {
                                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                                        .fill(bar.isToday ? Theme.Colors.indigo : Theme.Colors.indigo.opacity(0.85))
                                        .frame(width: Self.weekBarWidth, height: max(4, Self.weekChartHeight * CGFloat(bar.heightFraction)))
                                    Text(bar.dayLabel)
                                        .font(.system(size: 11, weight: bar.isToday ? .bold : .medium))
                                        .foregroundStyle(bar.isToday ? Theme.Colors.textPrimary : Theme.Colors.textTertiary)
                                }
                            }
                        }
                    }
                }
                .frame(height: 128)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Last 7 nights: " + week.map { "\($0.date) \(AnalysisLogic.formatDuration($0.minutes))" }.joined(separator: ", "))
            }
        }
    }
}

// MARK: - Shared date parsing

extension AnalysisView {
    fileprivate static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    fileprivate static let isoParserNF: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    fileprivate static func parseISO(_ value: String) -> Date? {
        isoParser.date(from: value) ?? isoParserNF.date(from: value)
    }
}

struct WorkoutAnalysisView: View {
    let id: String
    var body: some View { AnalysisView(kind: .workout, id: id) }
}

struct SleepAnalysisView: View {
    let id: String
    var body: some View { AnalysisView(kind: .sleep, id: id) }
}

struct MorningBriefView: View {
    let id: String
    var body: some View { AnalysisView(kind: .morningBrief, id: id) }
}
