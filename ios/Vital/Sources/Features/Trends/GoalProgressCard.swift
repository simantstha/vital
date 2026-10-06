import SwiftUI

// MARK: - Verdict chip

/// The verdict pill ("On track", "Behind pace", …) — a `Chip` tinted by the
/// verdict's tone (see `GoalProgressLogic.tone(for:)`).
struct GoalVerdictChip: View {
    let verdict: GoalVerdict

    var body: some View {
        Chip(
            text: GoalProgressLogic.label(for: verdict),
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
            .font(.system(size: 12))
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
            Text(reason.text)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
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
        if GoalProgressLogic.needsWeightTarget(progress) {
            promptCard
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
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Pick where you want to land and I'll tell you if you're on pace.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: onSetTarget) {
                    Text("Set target")
                        .font(.system(size: 14, weight: .semibold))
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
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(alignment: .center) {
                    GoalVerdictChip(verdict: progress.verdict)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textTertiary)
                }

                Text(GoalProgressLogic.primaryLine(progress, system: system))
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)

                if progress.verdict == .insufficientData, progress.goal == "weight_loss" {
                    VitalProgressBar(
                        fraction: GoalProgressLogic.insufficientDataFraction(progress),
                        tint: Theme.Colors.accent,
                        height: 6
                    )
                } else if let bar = weightBar {
                    bar
                }

                if let eta = GoalProgressLogic.etaLine(progress) {
                    Text(eta)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.Colors.textSecondary)
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
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the details")
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
}

// MARK: - Today one-line verdict

/// One compact, tappable line for each Today goal hero: the verdict chip plus
/// short text ("On track · ≈ Dec 10"). Tapping opens the same detail sheet as
/// the Trends card (`onTap`).
struct GoalProgressLine: View {
    let progress: GoalProgressDTO
    let system: UnitSystem
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Theme.Spacing.sm) {
                GoalVerdictChip(verdict: progress.verdict)
                Text(GoalProgressLogic.compactText(progress, system: system))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: Theme.Spacing.xs)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Colors.textTertiary)
            }
            .padding(.horizontal, Theme.Spacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressableCard)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(GoalProgressLogic.label(for: progress.verdict)). \(GoalProgressLogic.compactText(progress, system: system))")
        .accessibilityHint("Opens your goal progress")
        .accessibilityIdentifier("goalProgress.todayLine")
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
                    GoalVerdictChip(verdict: progress.verdict)
                    Text(GoalProgressLogic.primaryLine(progress, system: system))
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.Colors.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("goalProgress.detail.primary")
                }

                if let bar = weightBar {
                    bar
                }

                statsCard

                if !progress.reasons.isEmpty {
                    section(title: "Why") {
                        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                            ForEach(Array(progress.reasons.enumerated()), id: \.offset) { _, reason in
                                GoalReasonRow(reason: reason)
                            }
                        }
                    }
                }

                if let band = GoalProgressLogic.safeBandText(progress, system: system) {
                    section(title: "What's a healthy pace?") {
                        Text(band)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if progress.goal == "weight_loss", progress.dataSufficiency.weighIns > 0 {
                    Text("Based on \(progress.dataSufficiency.weighIns) weigh-ins.")
                        .font(.system(size: 12))
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
                .font(.system(size: 18, weight: .bold))
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

    /// Label/value rows for whatever the response has — a row is simply
    /// omitted when its value is unknown (never "--" placeholders or zeros).
    private var statRows: [(label: String, value: String)] {
        var rows: [(String, String)] = []
        if let start = progress.current.startWeightKg {
            rows.append(("Start", UnitFormat.weight(kg: start, system)))
        }
        if let current = progress.current.weightKg {
            rows.append(("Now", UnitFormat.weight(kg: current, system)))
        }
        if let target = progress.target.weightKg {
            rows.append(("Target", UnitFormat.weight(kg: target, system)))
        }
        if let rate = GoalProgressLogic.rateText(progress, system: system) {
            rows.append(("Trend", rate))
        }
        if let sessions = progress.target.weeklySessions {
            rows.append(("Weekly sessions goal", "\(sessions)"))
        }
        if progress.goal != "weight_loss", progress.dataSufficiency.sessionsLast28d > 0 {
            rows.append(("Sessions, last 4 weeks", "\(progress.dataSufficiency.sessionsLast28d)"))
        }
        return rows.map { (label: $0.0, value: $0.1) }
    }

    @ViewBuilder
    private var statsCard: some View {
        let rows = statRows
        let eta = GoalProgressLogic.etaLine(progress)
        let targetDate = GoalProgressLogic.targetDateLine(progress)
        if !rows.isEmpty || eta != nil || targetDate != nil {
            VitalCard(padding: Theme.Spacing.lg, cornerRadius: Theme.Radius.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        HStack {
                            Text(row.label)
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.Colors.textSecondary)
                            Spacer()
                            Text(row.value)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Theme.Colors.textPrimary)
                                .monospacedDigit()
                        }
                    }
                    if let eta {
                        Text(eta)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                    }
                    if let targetDate {
                        Text(targetDate)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(targetDateColor)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var targetDateColor: Color {
        switch progress.onPaceForTargetDate {
        case .some(true):  return Theme.Colors.positive
        case .some(false): return Theme.Colors.caution
        case .none:        return Theme.Colors.textSecondary
        }
    }

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(title)
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(Theme.Colors.textPrimary)
            content()
        }
    }
}
