import SwiftUI

// MARK: - Verdict chip

/// The verdict pill ("On track", "Behind pace", …) — a `Chip` tinted by the
/// verdict's tone (see `GoalProgressLogic.tone(for:)`).
struct GoalVerdictChip: View {
    let verdict: GoalVerdict
    /// Canonical goal id; makes the muscle `behind` chip read "Sessions behind".
    var goal: String? = nil

    var body: some View {
        Chip(
            text: GoalProgressLogic.label(for: verdict, goal: goal),
            tint: GoalProgressLogic.color(for: GoalProgressLogic.tone(for: verdict))
        )
    }
}

// MARK: - Progress bar (start -> target, current marker)

/// Start -> target bar with a marker at the current position. Only rendered
/// by callers that have all three weights and a `progressPct` (so it is never
/// drawn from guessed numbers).
private struct GoalWeightBar: View {
    let fraction: Double
    let startText: String
    let targetText: String
    let tint: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let barHeight: CGFloat = 8
    private let markerSize: CGFloat = 16

    var body: some View {
        VStack(spacing: Theme.Spacing.xs) {
            GeometryReader { geo in
                let width = geo.size.width
                let x = width * fraction
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.Colors.progressTrack)
                        .frame(height: barHeight)
                    Capsule()
                        .fill(tint)
                        .frame(width: max(barHeight, x), height: barHeight)
                    Circle()
                        .fill(Theme.Colors.card)
                        .overlay(Circle().strokeBorder(tint, lineWidth: 3))
                        .frame(width: markerSize, height: markerSize)
                        .offset(x: min(max(0, x - markerSize / 2), width - markerSize))
                }
                .frame(maxHeight: .infinity)
                .animation(reduceMotion ? nil : Theme.Motion.settle, value: fraction)
            }
            .frame(height: markerSize)

            HStack {
                Text(startText)
                Spacer()
                Text(targetText)
            }
            .scaledFont(size: 12)
            .foregroundStyle(Theme.Colors.textTertiary)
            .monospacedDigit()
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Weekly distance bar (endurance)

/// This week's distance against the weekly target: a plain filled bar with the
/// labelled 4-week average on the left and the target on the right. Only
/// rendered when the server supplied a distance target AND a measured distance.
private struct GoalDistanceBar: View {
    let fraction: Double
    let averageText: String?
    let targetText: String
    let tint: Color

    var body: some View {
        VStack(spacing: Theme.Spacing.xs) {
            VitalProgressBar(fraction: fraction, tint: tint, height: 8)
            HStack {
                if let averageText { Text(averageText) }
                Spacer()
                Text(targetText)
            }
            .scaledFont(size: 12)
            .foregroundStyle(Theme.Colors.textTertiary)
            .monospacedDigit()
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Reason row

private struct GoalReasonRow: View {
    let reason: GoalReasonDTO

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
            Circle()
                .fill(GoalProgressLogic.color(for: GoalProgressLogic.tone(for: reason.tone)))
                .frame(width: 8, height: 8)
                // Align the dot with the first text line's x-height.
                .alignmentGuide(.firstTextBaseline) { dimensions in dimensions[.bottom] - 1 }
            // Non-breaking so "+10 kg" and "(153 → 163 kg)" never wrap mid-value.
            Text(GoalProgressLogic.nonBreaking(reason.text))
                .scaledFont(size: 14)
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        // The dot's green / amber is colour-only: speak it ("good" / "watch").
        .accessibilityValue(GoalProgressLogic.accessibilityToneWord(for: reason.tone) ?? "")
    }
}

// MARK: - Goal reached: next steps

/// Drives the two next steps offered once a goal is reached. "Set a new target"
/// opens Profile's goal editor (`.vitalOpenGoalEditor`); "Switch to maintenance"
/// moves the goal KIND to General through the same PATCH /api/diet-goal the
/// Profile → Goal radio list uses, then posts `.vitalGoalKindChanged` so Today
/// and Trends re-read. Closures are injected so the flow is unit-testable.
@MainActor
final class GoalReachedActions: ObservableObject {
    @Published private(set) var isSwitching = false
    @Published private(set) var errorMessage: String?

    private let switchGoal: (String) async throws -> Void
    private let post: (Notification.Name) -> Void

    init(
        switchGoal: @escaping (String) async throws -> Void = { goal in
            _ = try await APIClient.shared.updateDietGoal(goal: goal)
        },
        post: @escaping (Notification.Name) -> Void = { NotificationCenter.default.post(name: $0, object: nil) }
    ) {
        self.switchGoal = switchGoal
        self.post = post
    }

    /// Opens the goal editor.
    func setNewTarget() {
        post(.vitalOpenGoalEditor)
    }

    /// Returns true when the goal is now maintenance. A failure keeps the
    /// current goal and leaves a retryable message.
    @discardableResult
    func switchToMaintenance() async -> Bool {
        guard !isSwitching else { return false }
        isSwitching = true
        errorMessage = nil
        defer { isSwitching = false }
        do {
            try await switchGoal(GoalProgressLogic.maintenanceGoal)
            post(.vitalGoalKindChanged)
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error, context: .write, tag: "switchToMaintenance")
            return false
        }
    }
}

/// "Set a new target" / "Switch to maintenance" — shown on the goal card and the
/// detail sheet only while the verdict is `reached`. Full-width, >= 44 pt tall.
struct GoalReachedActionRow: View {
    @StateObject private var model = GoalReachedActions()
    /// Called after either action starts/succeeds (the sheet dismisses itself).
    var onSetNewTarget: () -> Void = {}
    var onSwitched: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            actionButton(
                GoalProgressLogic.setNewTargetTitle, identifier: "goalProgress.setNewTarget", filled: true
            ) {
                model.setNewTarget()
                onSetNewTarget()
            }
            actionButton(
                GoalProgressLogic.switchToMaintenanceTitle, identifier: "goalProgress.switchToMaintenance",
                filled: false
            ) {
                Task { if await model.switchToMaintenance() { onSwitched() } }
            }
            .disabled(model.isSwitching)
            .opacity(model.isSwitching ? 0.5 : 1)

            if let message = model.errorMessage {
                Text(message)
                    .scaledFont(size: 13)
                    .foregroundStyle(Theme.Colors.alert)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("goalProgress.reachedError")
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func actionButton(
        _ title: String, identifier: String, filled: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .scaledFont(size: 15, weight: .semibold)
                .foregroundStyle(filled ? Theme.Colors.onAccent : Theme.Colors.accentContent)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Capsule().fill(filled ? Theme.Colors.accent : Theme.Colors.accentSoft))
                .contentShape(Capsule())
        }
        .buttonStyle(.vital(scale: 0.97))
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Race done: set your next goal

/// "Set your next goal" — shown on the goal card and the detail sheet only while
/// the race is done and its 14-day recovery is under way (phase "recovery").
/// Opens Profile's goal editor through the same `.vitalOpenGoalEditor` hop as
/// "Set a new target" (`GoalReachedActions.setNewTarget`), where the runner can
/// add a new race, a weekly distance target, or switch to maintenance.
/// Full-width, >= 44 pt tall.
struct GoalNextGoalActionRow: View {
    @StateObject private var model = GoalReachedActions()
    /// Called after the editor is requested (the sheet dismisses itself).
    var onSetNextGoal: () -> Void = {}

    var body: some View {
        Button {
            model.setNewTarget()
            onSetNextGoal()
        } label: {
            Text(RaceLogic.nextGoalTitle)
                .scaledFont(size: 15, weight: .semibold)
                .foregroundStyle(Theme.Colors.onAccent)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Capsule().fill(Theme.Colors.accent))
                .contentShape(Capsule())
        }
        .buttonStyle(.vital(scale: 0.97))
        .accessibilityIdentifier("goalProgress.setNextGoal")
    }
}

// MARK: - Trends card

/// Top-of-Trends "Am I on track?" card (v5 Wave 2). Compact: verdict chip,
/// primary line, a progress bar for weight goals, the ETA line (only when the
/// server supplied one — never a fake date) and up to 3 reasons. Tapping opens
/// the detail sheet (`onTap`). The needs-target state is a friendly prompt
/// with a button (`onSetTarget`) instead; insufficient data shows weigh-in
/// progress, never an ETA.
struct GoalProgressCard: View {
    let progress: GoalProgressDTO
    let system: UnitSystem
    var onTap: () -> Void
    var onSetTarget: () -> Void

    var body: some View {
        if GoalProgressLogic.needsTargetPrompt(progress) {
            promptCard
        } else if GoalProgressLogic.isReached(progress) {
            reachedCard
        } else if GoalProgressLogic.showsNextGoalPrompt(progress) {
            raceDoneCard
        } else {
            Button(action: onTap) {
                summaryCard
            }
            .buttonStyle(.pressableCard)
            .accessibilityIdentifier("goalProgress.card")
        }
    }

    // MARK: Needs-target prompt

    private var promptCard: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                GoalVerdictChip(verdict: .needsTarget)
                Text(GoalProgressLogic.primaryLine(progress, system: system))
                    .scaledFont(size: 17, weight: .semibold)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(GoalProgressLogic.needsSessionTarget(progress)
                     ? (progress.goal == "endurance"
                        ? "Pick a weekly distance (or how many workouts a week) you're aiming for and I'll tell you if you're keeping up."
                        : "Pick how many workouts a week you're aiming for and I'll tell you if you're keeping up.")
                     : "Pick where you want to land and I'll tell you if you're on pace.")
                    .scaledFont(size: 14)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: onSetTarget) {
                    Text("Set target")
                        .scaledFont(size: 14, weight: .semibold)
                        .foregroundStyle(Theme.Colors.accentContent)
                        .padding(.horizontal, Theme.Spacing.lg)
                        .padding(.vertical, Theme.Spacing.sm)
                        .background(Capsule().fill(Theme.Colors.accentSoft))
                }
                .buttonStyle(.vital(scale: 0.96))
                .accessibilityIdentifier("goalProgress.setTarget")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("goalProgress.card")
    }

    // MARK: Summary

    private var summaryCard: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            summaryContent
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the details")
    }

    /// Goal reached: the same summary, but the card can't be one big button (the
    /// two next-step buttons would sit inside another button), so the summary is
    /// the button and the actions sit beneath it inside the same card.
    private var reachedCard: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Button(action: onTap) {
                    summaryContent
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens the details")
                .accessibilityIdentifier("goalProgress.reachedSummary")

                GoalReachedActionRow()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("goalProgress.card")
    }

    /// Race done (recovery): like `reachedCard`, the summary is the button and
    /// "Set your next goal" sits beneath it inside the same card.
    private var raceDoneCard: some View {
        VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Button(action: onTap) {
                    summaryContent
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens the details")
                .accessibilityIdentifier("goalProgress.raceDoneSummary")

                GoalNextGoalActionRow()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("goalProgress.card")
    }

    private var summaryContent: some View {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(alignment: .center) {
                    GoalVerdictChip(verdict: progress.verdict, goal: progress.goal)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .scaledFont(size: 13, weight: .semibold)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Text(GoalProgressLogic.nonBreaking(GoalProgressLogic.primaryLine(progress, system: system)))
                    .scaledFont(size: 20, weight: .bold, design: .rounded)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)

                if GoalProgressLogic.showsWeighInProgressBar(progress) {
                    VitalProgressBar(
                        fraction: GoalProgressLogic.insufficientDataFraction(progress),
                        tint: Theme.Colors.accent,
                        height: 6
                    )
                } else if let bar = distanceBar {
                    bar
                } else if let bar = weightBar {
                    bar
                }

                if let pace = GoalProgressLogic.paceLine(progress) {
                    Text(pace)
                        .scaledFont(size: 14, weight: .semibold)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .accessibilityIdentifier("goalProgress.paceLine")
                }

                if let stale = GoalProgressLogic.staleWeighInText(progress) {
                    Text(stale)
                        .scaledFont(size: 14, weight: .semibold)
                        .foregroundStyle(Theme.Colors.caution)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("goalProgress.staleWeighIn")
                }

                let reasons = GoalProgressLogic.visibleReasons(progress)
                if !reasons.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        ForEach(Array(reasons.enumerated()), id: \.offset) { _, reason in
                            GoalReasonRow(reason: reason)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var weightBar: GoalWeightBar? {
        guard GoalProgressLogic.hasWeightProgress(progress),
              let fraction = GoalProgressLogic.progressFraction(progress),
              let start = progress.current.startWeightKg,
              let target = progress.target.weightKg else { return nil }
        return GoalWeightBar(
            fraction: fraction,
            startText: UnitFormat.weight(kg: start, system),
            targetText: UnitFormat.weight(kg: target, system),
            tint: GoalProgressLogic.color(for: GoalProgressLogic.tone(for: progress.verdict) == .watch ? .watch : .good)
        )
    }

    private var distanceBar: GoalDistanceBar? {
        guard let fraction = GoalProgressLogic.distanceFraction(progress),
              let endText = GoalProgressLogic.distanceBarEndText(progress, system: system) else { return nil }
        return GoalDistanceBar(
            fraction: fraction,
            averageText: GoalProgressLogic.distanceAverageLine(progress, system: system),
            targetText: endText,
            tint: GoalProgressLogic.color(for: GoalProgressLogic.tone(for: progress.verdict) == .watch ? .watch : .good)
        )
    }
}

// MARK: - Today one-line verdict

/// One compact, tappable line for each Today goal hero: the verdict chip plus
/// short text ("On track · ≈ Dec 10"). Tapping opens the same detail sheet as
/// the Trends card (`onTap`).
struct GoalProgressLine: View {
    let progress: GoalProgressDTO
    let system: UnitSystem
    /// The hero above already shows this week's distance progress (endurance
    /// with a weekly km target) — show the verdict's reason instead of repeating it.
    var heroShowsDistance = false
    /// Sessions already done this week, as the muscle hero shows them ("2 of 4
    /// sessions this week") — lets a `behind` muscle line name the remainder
    /// ("2 more by Sun"). `nil` when Today has no training summary yet.
    var sessionsDoneThisWeek: Int? = nil
    var onTap: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var text: String {
        GoalProgressLogic.compactText(
            progress, system: system, heroShowsDistance: heroShowsDistance,
            sessionsDoneThisWeek: sessionsDoneThisWeek
        )
    }

    var body: some View {
        Button(action: onTap) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    // Accessibility sizes: the pill and the text can't share
                    // one row without truncating, so the pill sits on its own
                    // line and the text wraps freely underneath (no line
                    // limit, no shrink-to-fit).
                    HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                            GoalVerdictChip(verdict: progress.verdict, goal: progress.goal)
                            Text(text)
                                .scaledFont(size: 14, weight: .semibold)
                                .foregroundStyle(Theme.Colors.textSecondary)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: Theme.Spacing.xs)
                        chevron
                    }
                } else {
                    HStack(spacing: Theme.Spacing.sm) {
                        GoalVerdictChip(verdict: progress.verdict, goal: progress.goal)
                        Text(text)
                            .scaledFont(size: 14, weight: .semibold)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: Theme.Spacing.xs)
                        chevron
                    }
                }
            }
            .padding(.horizontal, Theme.Spacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressableCard)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(GoalProgressLogic.label(for: progress.verdict, goal: progress.goal)). \(text)")
        .accessibilityHint("Opens your goal progress")
        .accessibilityIdentifier("goalProgress.todayLine")
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .scaledFont(size: 12, weight: .semibold)
            .foregroundStyle(Theme.Colors.textTertiary)
    }
}

// MARK: - Detail sheet

/// Everything behind the verdict: all reasons, the healthy-pace explanation
/// in plain English, start / now / target, the trend rate, ETA and the target
/// date's on-pace verdict. Present inside a `VitalSheet`.
struct GoalProgressDetailView: View {
    let progress: GoalProgressDTO
    let system: UnitSystem

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                header

                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    GoalVerdictChip(verdict: progress.verdict, goal: progress.goal)
                    Text(GoalProgressLogic.nonBreaking(GoalProgressLogic.primaryLine(progress, system: system)))
                        .scaledFont(size: 24, weight: .bold, design: .rounded)
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("goalProgress.detail.primary")
                }

                // Goal reached: the two ways forward, ahead of the numbers.
                if GoalProgressLogic.isReached(progress) {
                    GoalReachedActionRow(onSetNewTarget: { dismiss() }, onSwitched: { dismiss() })
                }

                // Race done (recovery): the way forward, ahead of the numbers.
                if GoalProgressLogic.showsNextGoalPrompt(progress) {
                    GoalNextGoalActionRow(onSetNextGoal: { dismiss() })
                }

                if let bar = distanceBar {
                    bar
                } else if let bar = weightBar {
                    bar
                }

                statsCard

                if !GoalProgressLogic.displayReasons(progress).isEmpty {
                    section(title: "Why") {
                        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                            ForEach(Array(GoalProgressLogic.displayReasons(progress).enumerated()), id: \.offset) { _, reason in
                                GoalReasonRow(reason: reason)
                            }
                        }
                    }
                }

                if let band = GoalProgressLogic.safeBandText(progress, system: system) {
                    section(title: "What's a healthy pace?") {
                        Text(band)
                            .scaledFont(size: 14)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if progress.goal == "weight_loss", progress.dataSufficiency.weighIns > 0 {
                    Text("Based on \(progress.dataSufficiency.weighIns) weigh-ins.")
                        .scaledFont(size: 12)
                        .foregroundStyle(Theme.Colors.textTertiary)
                }
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.top, Theme.Spacing.md)
            .padding(.bottom, Theme.Spacing.xxxl)
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("goalProgress.detail")
    }

    // MARK: Pieces

    private var header: some View {
        HStack {
            Text("Your goal progress")
                .scaledFont(size: 18, weight: .bold)
                .tracking(-0.2)
                .foregroundStyle(Theme.Colors.textPrimary)
                .accessibilityIdentifier("goalProgress.detail.title")
            Spacer()
            Button {
                dismiss()
            } label: {
                ZStack {
                    Circle()
                        .fill(Theme.Colors.glassFill)
                        .frame(width: 36, height: 36)
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
    }

    private var weightBar: GoalWeightBar? {
        guard GoalProgressLogic.hasWeightProgress(progress),
              let fraction = GoalProgressLogic.progressFraction(progress),
              let start = progress.current.startWeightKg,
              let target = progress.target.weightKg else { return nil }
        return GoalWeightBar(
            fraction: fraction,
            startText: UnitFormat.weight(kg: start, system),
            targetText: UnitFormat.weight(kg: target, system),
            tint: GoalProgressLogic.color(for: GoalProgressLogic.tone(for: progress.verdict) == .watch ? .watch : .good)
        )
    }

    private var distanceBar: GoalDistanceBar? {
        guard let fraction = GoalProgressLogic.distanceFraction(progress),
              let endText = GoalProgressLogic.distanceBarEndText(progress, system: system) else { return nil }
        return GoalDistanceBar(
            fraction: fraction,
            averageText: GoalProgressLogic.distanceAverageLine(progress, system: system),
            targetText: endText,
            tint: GoalProgressLogic.color(for: GoalProgressLogic.tone(for: progress.verdict) == .watch ? .watch : .good)
        )
    }

    /// Label/value rows for whatever the response has (pure logic lives in
    /// `GoalProgressLogic.statRows`: unknown values are omitted, and weight rows
    /// are hidden for an endurance/general goal without a target weight).
    private var statRows: [GoalProgressLogic.StatRow] {
        GoalProgressLogic.statRows(progress, system: system)
    }

    @ViewBuilder
    private var statsCard: some View {
        let rows = statRows
        let pace = GoalProgressLogic.paceLine(progress)
        if !rows.isEmpty || pace != nil {
            VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        // Label above value at accessibility sizes (see
                        // `AccessibilityAdaptiveStack`).
                        AccessibilityAdaptiveStack(stackedSpacing: 0) {
                            Text(row.label)
                                .scaledFont(size: 14)
                                .foregroundStyle(Theme.Colors.textSecondary)
                            Spacer()
                            Text(row.value)
                                .scaledFont(size: 15, weight: .semibold)
                                .foregroundStyle(Theme.Colors.textPrimary)
                                .monospacedDigit()
                        }
                    }
                    // One line relating the projection to the target date
                    // ("About 2 weeks ahead of your Dec 29 target") instead of
                    // two unrelated dates.
                    if let pace {
                        Text(pace)
                            .scaledFont(size: 14, weight: .semibold)
                            .foregroundStyle(paceColor)
                            .accessibilityIdentifier("goalProgress.detail.paceLine")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var paceColor: Color {
        let tone = GoalProgressLogic.paceTone(progress)
        return tone == .neutral ? Theme.Colors.textPrimary : GoalProgressLogic.color(for: tone)
    }

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(title)
                .scaledFont(size: 17, weight: .bold)
                .foregroundStyle(Theme.Colors.textPrimary)
            content()
        }
    }
}
