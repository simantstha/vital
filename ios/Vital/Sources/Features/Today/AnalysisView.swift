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
    /// Applied to the title `Text` alone, never to the header container —
    /// an identifier on a container propagates to (and silently replaces)
    /// its children's own identifiers, which previously clobbered the Done
    /// button's `analysis.done` and left the screenshot harness with
    /// nothing tappable to dismiss the sheet.
    var titleIdentifier: String? = nil

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
                .accessibilityIdentifier(titleIdentifier ?? "")
            Text(subline)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct AnalysisSectionHeader: View {
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
    /// `false` (default, every `DataRow` chip): the chip never truncates —
    /// `.fixedSize()` keeps it at its full intrinsic width and the row's
    /// label wraps instead if the row runs tight (see `DataRow`).
    /// `true` (the stats-row tiles, where the chip sits in a narrow fixed
    /// column with nothing that can wrap next to it): the chip may shrink
    /// its text down to `minimumScaleFactor`, but still never truncates
    /// with an ellipsis.
    var scalesToFit: Bool = false

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
        Group {
            if scalesToFit {
                label.minimumScaleFactor(0.85)
            } else {
                label.fixedSize()
            }
        }
    }

    private var label: some View {
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
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            // Never truncates (`ChipView`'s default `scalesToFit: false`) —
            // the label above wraps to a second line instead if the row
            // runs tight, so a chip like "50 bpm · below normal" is always
            // fully readable.
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

// MARK: - Device chip / switch (phase 2 "both devices" contract, PR C items 2/3)

/// Small "Apple Watch" / "WHOOP" pill — the source chips row under the
/// header, and the sleep screen's "<Primary> · primary for sleep" chip
/// (via `label`).
private struct DeviceSourceChip: View {
    let device: DevicesLogic.DeviceKind
    var label: String? = nil

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: device == .apple ? "applewatch" : "waveform.path.ecg")
                .font(.system(size: 11, weight: .semibold))
            Text(label ?? AnalysisLogic.deviceDisplayName(device))
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Theme.Colors.textSecondary)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, 5)
        .background(Theme.Colors.glassFill, in: Capsule())
        .fixedSize()
    }
}

/// The "Apple Watch | WHOOP" segmented control — defaults to the primary
/// device (set by the caller's `@State` initial value), identifiers
/// `analysis.deviceSwitch.apple` / `analysis.deviceSwitch.whoop` (contract).
/// Identifiers sit on the `Button`s themselves (leaves), never on the
/// container, per the #249/#253 review lesson that a container's identifier
/// overrides its children's.
private struct DeviceSwitchControl: View {
    @Binding var selected: DevicesLogic.DeviceKind
    let options: [DevicesLogic.DeviceKind]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.self) { option in
                segment(option)
            }
        }
        .padding(2)
        .background(Theme.Colors.glassFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func segment(_ option: DevicesLogic.DeviceKind) -> some View {
        let isOn = option == selected
        return Button {
            selected = option
        } label: {
            HStack(spacing: 6) {
                Image(systemName: option == .apple ? "applewatch" : "waveform.path.ecg")
                    .font(.system(size: 13, weight: .semibold))
                Text(AnalysisLogic.deviceDisplayName(option))
                    .font(.system(size: 14, weight: isOn ? .bold : .semibold))
                    .lineLimit(1)
                    .fixedSize()
            }
            .foregroundStyle(isOn ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 36)
            // `.buttonStyle(.plain)` + a `Spacer`-like `maxWidth: .infinity`
            // frame needs an explicit hit-testing shape (#249/#253 lesson) —
            // otherwise only the icon+text's own intrinsic size is tappable.
            .contentShape(Rectangle())
            .background {
                if isOn {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Theme.Colors.switcherThumb)
                        .shadow(color: Theme.Colors.cardShadow, radius: 3, y: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(option == .apple ? "analysis.deviceSwitch.apple" : "analysis.deviceSwitch.whoop")
    }
}

/// Plain 0...21 strain scale with a single marker at `value` — WHOOP's own
/// strain card. The mockup's richer scale (a suggested range, a running day
/// total) needs data `context.devices` doesn't carry per session, so this is
/// deliberately simpler: just where today's session strain sits on WHOOP's
/// 0-21 scale.
private struct StrainScaleView: View {
    let value: Double

    private var fraction: Double {
        min(max(value / 21, 0), 1)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Theme.Colors.glassFill)
                    .frame(height: 10)
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Theme.Colors.accent)
                    .frame(width: geo.size.width * CGFloat(fraction), height: 10)
            }
        }
    }
}

/// One `AnalysisLogic.ZoneBar` row: label, fill bar, mm:ss, percent.
private struct ZoneBarRow: View {
    let bar: AnalysisLogic.ZoneBar

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            Text(bar.label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 58, alignment: .leading)
                .lineLimit(1)
                .fixedSize()
            GeometryReader { geo in
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Theme.Colors.indigo)
                    .frame(width: max(geo.size.width * CGFloat(bar.fraction), 3), height: 10)
            }
            .frame(height: 10)
            Text(bar.timeLabel)
                .font(Theme.Typography.numericSmall(14))
                .foregroundStyle(Theme.Colors.textPrimary)
                .frame(width: 46, alignment: .trailing)
                .fixedSize()
            Text(bar.percentLabel)
                .font(.system(size: 11))
                .foregroundStyle(Theme.Colors.textSecondary)
                .frame(width: 32, alignment: .trailing)
                .fixedSize()
        }
        .padding(.vertical, 4)
    }
}

/// Draws a normalized heart-rate curve (`AnalysisLogic.hrCurvePoints`) as a
/// `Canvas`-hosted `Path` — the same approach `Sparkline` already uses
/// (never Swift Charts) for this app's line charts.
private struct HeartRateCurveView: View {
    let points: [AnalysisLogic.HRPoint]

    var body: some View {
        Canvas { context, size in
            guard points.count >= 2 else { return }
            var path = Path()
            for (index, point) in points.enumerated() {
                let cgPoint = CGPoint(x: point.x * size.width, y: (1 - point.y) * size.height * 0.85 + size.height * 0.08)
                if index == 0 {
                    path.move(to: cgPoint)
                } else {
                    path.addLine(to: cgPoint)
                }
            }
            context.stroke(path, with: .color(Theme.Colors.textPrimary), style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
        }
    }
}

// MARK: - Workout content

// Internal (not `private`) purely so `AnalysisFixtureRenderTests` can
// construct it directly from decoded fixture data and force a layout pass,
// without going through `AnalysisView`'s own network `load()` — no behavior
// or layout change, access only.
struct WorkoutAnalysisContent: View {
    let value: AnalysisResponse
    let doneAction: () -> Void
    let kind: AnalysisKind
    @EnvironmentObject private var router: AppRouter
    @ObservedObject private var unitPref = UnitPreference.shared
    /// Which device's tab is showing in "The data" — defaults to the
    /// primary device (contract) via the custom `init` below, kept in
    /// `@State` since the fixture/decoded `value` never changes after load.
    @State private var selectedDevice: DevicesLogic.DeviceKind

    init(value: AnalysisResponse, doneAction: @escaping () -> Void, kind: AnalysisKind) {
        self.value = value
        self.doneAction = doneAction
        self.kind = kind
        let primary = value.context?.devices?.primary ?? .apple
        _selectedDevice = State(initialValue: AnalysisLogic.defaultDeviceSelection(primary: primary))
    }

    private var metrics: AnalysisMetrics? { value.metrics }
    private var context: AnalysisContext? { value.context }
    private var type: String { metrics?.type ?? "Workout" }
    private var startDate: Date? { metrics?.startTime.flatMap(AnalysisView.parseISO) }

    // MARK: Devices

    private var hasBothDeviceSessions: Bool {
        (context?.devices?.sessions?.count ?? 0) >= 2
    }

    private func deviceSession(_ device: DevicesLogic.DeviceKind) -> AnalysisContext.DeviceSession? {
        context?.devices?.sessions?.first { $0.source == device }
    }

    private var devicesPrimary: DevicesLogic.DeviceKind {
        context?.devices?.primary ?? .apple
    }

    /// Fallback for a single-device (or no-`devices`) session — "the single
    /// session's own data" (contract): shown without the switch.
    private var singleDeviceFallbackSession: AnalysisContext.DeviceSession? {
        guard !hasBothDeviceSessions else { return nil }
        return context?.devices?.sessions?.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxl) {
                AnalysisHeader(
                    iconSystemName: "figure.run",
                    kickerText: startDate.map { AnalysisLogic.workoutKicker(type: type, startTime: $0) } ?? type.uppercased(),
                    title: value.result.headline,
                    subline: value.result.shortInsight,
                    doneAction: doneAction,
                    titleIdentifier: "analysisWorkout.header"
                )

                deviceSourceChipsRow

                statsRow

                devicesSection

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

    // MARK: Devices — "The data" (phase 2 "both devices" contract, PR C item 2)

    @ViewBuilder
    private var deviceSourceChipsRow: some View {
        if hasBothDeviceSessions, let sessions = context?.devices?.sessions {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(sessions.indices, id: \.self) { index in
                    if let source = sessions[index].source {
                        DeviceSourceChip(device: source)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var devicesSection: some View {
        if hasBothDeviceSessions {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                AnalysisSectionHeader(title: "The data", trailing: "both devices recorded this")
                DeviceSwitchControl(selected: $selectedDevice, options: [.apple, .whoop])
                if selectedDevice == .apple, let appleSession = deviceSession(.apple) {
                    appleDeviceCards(appleSession)
                }
                if selectedDevice == .whoop, let whoopSession = deviceSession(.whoop) {
                    whoopDeviceCards(whoopSession)
                }
            }
        } else if let session = singleDeviceFallbackSession {
            singleDeviceFallbackCards(session)
        }
    }

    /// Apple Watch tab: heart-rate curve, time in zones, running form —
    /// each shown only when its own data is present.
    private func appleDeviceCards(_ session: AnalysisContext.DeviceSession) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let hrSeries = session.hrSeries, hrSeries.count >= 2 {
                heartRateCurveCard(hrSeries: hrSeries, avgHr: session.avgHr, maxHr: session.maxHr)
            }
            if let zonesSec = session.zonesSec, !zonesSec.isEmpty {
                zonesCard(zonesSec: zonesSec, basis: session.zoneBasis)
            }
            if let running = session.running {
                runningFormCard(running)
            }
        }
    }

    /// WHOOP tab: strain, zones (max-HR-share basis), avg HR (vs the
    /// Watch's own), energy "not counted" from the primary device.
    private func whoopDeviceCards(_ session: AnalysisContext.DeviceSession) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let strain = session.strain {
                strainCard(strain)
            }
            if let zonesSec = session.zonesSec, !zonesSec.isEmpty {
                zonesCard(zonesSec: zonesSec, basis: session.zoneBasis)
            }
            avgHrEnergyCard(session)
            if session.kcal == nil {
                caloriesCountOnceCaption
            }
        }
    }

    /// No `devices`, or only one session recorded — show whichever of this
    /// session's own cards have data, with no switch (contract §2).
    private func singleDeviceFallbackCards(_ session: AnalysisContext.DeviceSession) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let hrSeries = session.hrSeries, hrSeries.count >= 2 {
                heartRateCurveCard(hrSeries: hrSeries, avgHr: session.avgHr, maxHr: session.maxHr)
            }
            if let zonesSec = session.zonesSec, !zonesSec.isEmpty {
                zonesCard(zonesSec: zonesSec, basis: session.zoneBasis)
            }
            if let running = session.running {
                runningFormCard(running)
            }
        }
    }

    private func heartRateCurveCard(hrSeries: [Double], avgHr: Double?, maxHr: Double?) -> some View {
        let stats = AnalysisLogic.hrSeriesAvgMax(hrSeries)
        let avg = avgHr ?? stats?.avg
        let peak = maxHr ?? stats?.max
        return VitalCard(padding: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack {
                    Text("Heart rate").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.Colors.textPrimary)
                    Spacer()
                    if let avg, let peak {
                        Text("avg \(Int(avg.rounded())) · max \(Int(peak.rounded()))")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.Colors.textSecondary)
                    }
                }
                HeartRateCurveView(points: AnalysisLogic.hrCurvePoints(series: hrSeries))
                    .frame(height: 90)
            }
        }
    }

    private func zoneCaption(basis: String?) -> String {
        basis == "maxHr"
            ? "WHOOP measures zones as a share of your max heart rate, so they won't match the Watch's exactly."
            : "Zones from your heart-rate reserve."
    }

    private func zonesCard(zonesSec: [Double], basis: String?) -> some View {
        let bars = AnalysisLogic.zoneBars(secondsByZone: zonesSec, basis: basis)
        return VitalCard(padding: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text("Time in zones").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.Colors.textPrimary)
                ForEach(Array(bars.enumerated()), id: \.offset) { _, bar in
                    ZoneBarRow(bar: bar)
                }
                Text(zoneCaption(basis: basis))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Theme.Spacing.xs)
            }
        }
    }

    private func runningFormCard(_ running: AnalysisContext.DeviceRunning) -> some View {
        VitalCard(padding: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: 0) {
                if let cadence = running.cadenceSpm {
                    DataRow(icon: "figure.run", label: "Cadence",
                            chip: .init(text: "\(Int(cadence.rounded())) spm", tone: .neutral), isFirst: true)
                }
                if let groundContact = running.groundContactMs {
                    DataRow(icon: "timer", label: "Ground contact",
                            chip: .init(text: "\(Int(groundContact.rounded())) ms", tone: .neutral),
                            isFirst: running.cadenceSpm == nil)
                }
                if let power = running.powerW {
                    DataRow(icon: "bolt.fill", label: "Power",
                            chip: .init(text: "\(Int(power.rounded())) W", tone: .neutral),
                            isFirst: running.cadenceSpm == nil && running.groundContactMs == nil)
                }
            }
        }
    }

    private func strainCard(_ strain: Double) -> some View {
        VitalCard(padding: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(alignment: .lastTextBaseline) {
                    Text("Strain").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.Colors.textPrimary)
                    Spacer()
                    Text(String(format: "%.1f", strain))
                        .font(Theme.Typography.numericSmall(18))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
                StrainScaleView(value: strain).frame(height: 14)
            }
        }
    }

    private func avgHrChipText(avgHr: Double, watchAvg: Double?) -> String {
        guard let watchAvg else { return "\(Int(avgHr.rounded())) bpm" }
        return "\(Int(avgHr.rounded())) bpm · Watch: \(Int(watchAvg.rounded()))"
    }

    private func avgHrEnergyCard(_ session: AnalysisContext.DeviceSession) -> some View {
        let watchAvg = deviceSession(.apple)?.avgHr
        return VitalCard(padding: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: 0) {
                if let avgHr = session.avgHr {
                    DataRow(icon: "heart.fill", label: "Average heart rate",
                            chip: .init(text: avgHrChipText(avgHr: avgHr, watchAvg: watchAvg), tone: .neutral),
                            isFirst: true)
                }
                DataRow(icon: "flame.fill", label: "Energy",
                        chip: .init(text: session.kcal.map { "\(Int($0.rounded())) kcal" } ?? "not counted", tone: .neutral),
                        isFirst: session.avgHr == nil)
            }
        }
    }

    /// "Calories count once, from your primary device for workouts —
    /// <primary name>." (contract) — shown under the energy row only when
    /// THIS session's own kcal was omitted (i.e. it isn't the primary).
    private var caloriesCountOnceCaption: some View {
        Text("Calories count once, from your primary device for workouts — \(AnalysisLogic.deviceDisplayName(devicesPrimary)).")
            .font(.system(size: 12))
            .foregroundStyle(Theme.Colors.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
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
                list.append(Stat(value: AnalysisLogic.workoutDurationLabel(durationMin), unit: "", label: "time", chip: nil))
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
            list.append(Stat(value: AnalysisLogic.workoutDurationLabel(durationMin), unit: "", label: "time", chip: nil))
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
                                ChipView(chip: chip, scalesToFit: true).padding(.top, Theme.Spacing.xxs)
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
            AnalysisSectionHeader(title: "Compared to your last \(total) runs", trailing: "pace")
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
            AnalysisSectionHeader(title: "Effort")
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
                    EffortZoneBar(avgFraction: effort.avgPct, markerFraction: maxHrMarkerFraction(effort))
                        .frame(height: 44)
                        .accessibilityLabel("Effort \(Int((effort.avgPct * 100).rounded()))% of your heart rate range, \(AnalysisLogic.effortZoneLabel(effort.zone).lowercased())")
                    // #249 polish: a small legend so the tick/ring markers on
                    // the bar above aren't left unexplained.
                    EffortZoneLegend(showsMaxMarker: maxHrMarkerFraction(effort) != nil)
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

    /// Fraction (0...1) on the resting→max HR range where this workout's own
    /// recorded max-HR marker sits, or `nil` when there's no recorded max HR
    /// to place it at (`EffortZoneBar`'s optional ring marker). Pulled out
    /// of `effortSection`'s view body so it's a plain function call there,
    /// not a `let` binding inside the `VitalCard` view-builder closure.
    private func maxHrMarkerFraction(_ effort: AnalysisContext.Effort) -> Double? {
        metrics?.maxHr.map { AnalysisLogic.heartRateRangeFraction($0, restingHr: effort.restingHr, maxHr: effort.maxHr) }
    }

    // MARK: Going in

    private func goingInSection(_ goingIn: AnalysisContext.GoingIn) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            AnalysisSectionHeader(title: "Going in")
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
                AnalysisSectionHeader(title: "How your body took it")
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

/// Small legend under `EffortZoneBar` explaining its two markers (#249
/// review polish — the bar's tick/ring were otherwise unlabeled). The ring
/// entry is omitted entirely when the bar has no max-HR marker to explain
/// (`showsMaxMarker == false`), rather than describing a marker that isn't
/// actually drawn.
private struct EffortZoneLegend: View {
    let showsMaxMarker: Bool

    var body: some View {
        HStack(spacing: Theme.Spacing.lg) {
            HStack(spacing: Theme.Spacing.xs) {
                Rectangle()
                    .fill(Theme.Colors.textPrimary)
                    .frame(width: 2, height: 10)
                Text("your average")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
            if showsMaxMarker {
                HStack(spacing: Theme.Spacing.xs) {
                    Circle()
                        .strokeBorder(Theme.Colors.textPrimary, lineWidth: 1.5)
                        .frame(width: 8, height: 8)
                    Text("this run's max")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }
}

// MARK: - Sleep content

// Internal (not `private`) — see `WorkoutAnalysisContent`'s comment above.
struct SleepAnalysisContent: View {
    let value: AnalysisResponse
    let doneAction: () -> Void
    let kind: AnalysisKind
    @EnvironmentObject private var router: AppRouter
    /// Which device's stages are showing — defaults to the primary device
    /// (contract), same pattern as `WorkoutAnalysisContent`.
    @State private var selectedDevice: DevicesLogic.DeviceKind

    init(value: AnalysisResponse, doneAction: @escaping () -> Void, kind: AnalysisKind) {
        self.value = value
        self.doneAction = doneAction
        self.kind = kind
        let primary = value.context?.devices?.primary ?? .apple
        _selectedDevice = State(initialValue: AnalysisLogic.defaultDeviceSelection(primary: primary))
    }

    private var metrics: AnalysisMetrics? { value.metrics }
    private var context: AnalysisContext? { value.context }

    // MARK: Devices

    private var hasBothDeviceSessions: Bool {
        (context?.devices?.sessions?.count ?? 0) >= 2
    }

    private func deviceSession(_ device: DevicesLogic.DeviceKind) -> AnalysisContext.DeviceSession? {
        context?.devices?.sessions?.first { $0.source == device }
    }

    private var devicesPrimary: DevicesLogic.DeviceKind {
        context?.devices?.primary ?? .apple
    }

    private var otherDevice: DevicesLogic.DeviceKind? {
        guard hasBothDeviceSessions else { return nil }
        return devicesPrimary == .apple ? .whoop : .apple
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxl) {
                AnalysisHeader(
                    iconSystemName: "moon.stars.fill",
                    kickerText: context?.timing.map { AnalysisLogic.sleepKicker(bedTime: $0.bedTime, wakeTime: $0.wakeTime) } ?? "LAST NIGHT",
                    title: value.result.headline,
                    subline: value.result.shortInsight,
                    doneAction: doneAction,
                    titleIdentifier: "analysisSleep.header"
                )

                hero

                deviceSourceChip

                if hasBothDeviceSessions {
                    devicesStagesSection
                } else {
                    stages
                }

                devicesDisagreeCard

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
                // #249 polish: the hero card spans the full card width
                // rather than shrinking to its content's intrinsic size.
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
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Stages

    @ViewBuilder
    private var stages: some View {
        if let hkStages = metrics?.stages, let usualStages = context?.sleepUsual?.stages {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                AnalysisSectionHeader(title: "Stages", trailing: "bar = last night · tick = your usual")
                stageRowsCard(hkStages, usualStages: usualStages)
            }
        } else if let hkStages = metrics?.stages {
            stackedStageBar(hkStages)
        }
    }

    /// The "bar = last night · tick = your usual" card, pulled out of
    /// `stages` so the devices stages switch (below) can reuse it for the
    /// primary device's tab without duplicating its own section header.
    private func stageRowsCard(_ hkStages: AnalysisMetrics.SleepStages, usualStages: AnalysisMetrics.SleepStages) -> some View {
        VitalCard(padding: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 0) {
                stageRow("Deep", minutes: hkStages.deep, usual: usualStages.deep, kind: .deep, isFirst: true)
                stageRow("REM", minutes: hkStages.rem, usual: usualStages.rem, kind: .rem, isFirst: false)
                stageRow("Core", minutes: hkStages.core, usual: usualStages.core, kind: .core, isFirst: false)
                stageRow("Awake", minutes: hkStages.awake, usual: usualStages.awake, kind: .awake, isFirst: false)
            }
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
        // #249 polish: Awake previously used `chartMuted`, a plain grey
        // that read as an empty/track segment rather than an actual stage.
        // `Theme.Colors.caution`'s warm amber is distinct from every other
        // stage color and from the bar's own track, and (like every other
        // Theme color) already has matched light/dark variants.
        case .awake: Theme.Colors.caution
        }
    }

    /// No `usual` baseline: fall back to a single stacked stage bar + legend
    /// (analysis-v2-contract.md §2).
    private func stackedStageBar(_ stages: AnalysisMetrics.SleepStages) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            AnalysisSectionHeader(title: "Stages")
            stackedStageBarCard(stages)
        }
    }

    /// The stacked-bar-and-legend card alone, no section header — pulled out
    /// of `stackedStageBar` so the devices stages switch (below) can reuse it
    /// for a secondary device's tab (which has no `usual` baseline of its
    /// own to compare against — "never one against the other") without a
    /// duplicate "Stages" header.
    private func stackedStageBarCard(_ stages: AnalysisMetrics.SleepStages) -> AnyView {
        let segments: [(String, Double, Color)] = [
            ("Deep", stages.deep ?? 0, stageColor(.deep)),
            ("REM", stages.rem ?? 0, stageColor(.rem)),
            ("Core", stages.core ?? 0, stageColor(.core)),
            ("Awake", stages.awake ?? 0, stageColor(.awake)),
        ].filter { $0.1 > 0 }
        let total = segments.reduce(0) { $0 + $1.1 }
        guard total > 0 else { return AnyView(EmptyView()) }
        return AnyView(
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
        )
    }

    // MARK: Devices — Stages switch + disagreement card (phase 2 "both
    // devices" contract, PR C item 3)

    @ViewBuilder
    private var deviceSourceChip: some View {
        if hasBothDeviceSessions {
            DeviceSourceChip(device: devicesPrimary, label: "\(AnalysisLogic.deviceDisplayName(devicesPrimary)) · primary for sleep")
        }
    }

    private var devicesStagesSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            AnalysisSectionHeader(title: "Stages", trailing: "both devices recorded this")
            DeviceSwitchControl(selected: $selectedDevice, options: [.apple, .whoop])
            stagesCard(for: selectedDevice)
        }
    }

    /// The selected device's own stages card: the primary device reuses the
    /// usual-baseline rows (falling back to the stacked bar if no baseline
    /// exists yet), the other device always gets the stacked bar — it has no
    /// `usual` of its own in this context, and per the "devices disagree"
    /// card's own copy, one device is never compared against the other's.
    @ViewBuilder
    private func stagesCard(for device: DevicesLogic.DeviceKind) -> some View {
        if device == devicesPrimary {
            if let hkStages = metrics?.stages, let usualStages = context?.sleepUsual?.stages {
                stageRowsCard(hkStages, usualStages: usualStages)
            } else if let hkStages = metrics?.stages {
                stackedStageBarCard(hkStages)
            }
        } else if let otherStages = deviceSession(device)?.stages {
            stackedStageBarCard(otherStages)
        }
    }

    /// "The devices disagree a little" — only when both sessions have
    /// `minutes` and they differ by ≥10 min (contract §3).
    @ViewBuilder
    private var devicesDisagreeCard: some View {
        if hasBothDeviceSessions, let other = otherDevice,
           let primaryMinutes = deviceSession(devicesPrimary)?.minutes,
           let otherMinutes = deviceSession(other)?.minutes,
           AnalysisLogic.sleepDevicesDisagree(minutesA: primaryMinutes, minutesB: otherMinutes) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("The devices disagree a little")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text("\(AnalysisLogic.deviceDisplayName(other)) counted \(AnalysisLogic.formatDuration(otherMinutes)) asleep. Each device estimates stages its own way, so I compare every night against the same device's normal — never one against the other.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Colors.glassFill, in: RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
        }
    }

    // MARK: Before bed

    private func beforeBedSection(_ beforeBed: AnalysisContext.BeforeBed, bedTime: Date) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            AnalysisSectionHeader(title: "Before bed")
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
            AnalysisSectionHeader(title: "This morning")
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
            AnalysisSectionHeader(title: "Last 7 nights", trailing: "goal \(AnalysisLogic.formatDuration(goalMinutes))")
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
