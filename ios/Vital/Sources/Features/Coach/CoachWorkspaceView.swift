import SwiftUI

// MARK: - Presentation

enum CoachWorkspaceAdjustment: Equatable, Identifiable {
    case moveDuration(minutes: Int)
    case restDuration(minutes: Int)
    case sleepTime(minutes: Int)

    var id: String {
        switch self {
        case .moveDuration(let minutes): return "move-\(minutes)"
        case .restDuration(let minutes): return "rest-\(minutes)"
        case .sleepTime(let minutes): return "sleep-\(minutes)"
        }
    }

    var label: String {
        switch self {
        case .moveDuration(let minutes), .restDuration(let minutes): return "\(minutes) min"
        case .sleepTime(let minutes): return "Wind down \(CoachWorkspacePresentation.clockTime(minutes))"
        }
    }

    var request: CoachWorkspaceAdjustmentRequest {
        switch self {
        case .moveDuration(let minutes), .restDuration(let minutes):
            return CoachWorkspaceAdjustmentRequest(durationMinutes: minutes)
        case .sleepTime(let minutes):
            return CoachWorkspaceAdjustmentRequest(timeMinutes: minutes)
        }
    }
}

enum CoachWorkspaceControl: Equatable {
    case addToPlan
    case adjust
    case skip
    case complete
    case refresh
    case evidence
    case talk
}

enum CoachWorkspacePresentation {
    static func allowsPlanControls(for workspace: CoachWorkspaceSnapshot) -> Bool {
        workspace.state.status == .ready
            && workspace.recommendation.evidence.fresh
            && !workspace.recommendation.evidence.constraintGate
    }

    static func isCalibrationGuidance(for workspace: CoachWorkspaceSnapshot) -> Bool {
        workspace.state.status == .calibration
            || !workspace.recommendation.evidence.fresh
            || workspace.recommendation.evidence.constraintGate
    }

    static func controls(for workspace: CoachWorkspaceSnapshot) -> [CoachWorkspaceControl] {
        if isCalibrationGuidance(for: workspace) {
            return [.refresh, .evidence, .talk]
        }
        switch workspace.state.status {
        case .ready:
            return [.addToPlan, .adjust, .skip, .evidence, .talk]
        case .planned:
            return [.adjust, .complete, .skip, .evidence, .talk]
        case .skipped, .completed:
            return [.evidence, .talk]
        case .calibration:
            return [.refresh, .evidence, .talk]
        }
    }

    static func calibrationGuidance(for workspace: CoachWorkspaceSnapshot) -> String {
        if workspace.recommendation.evidence.constraintGate {
            return "A confirmed health limit is guiding today’s recommendation. Let’s keep this comfortable."
        }
        if !workspace.recommendation.evidence.fresh {
            return "We need fresh sleep, HRV, and resting-heart-rate signals before offering a plan."
        }
        return "We’re still learning your baseline. Keep today comfortable while your signals calibrate."
    }

    static func adjustmentOptions(for recommendation: CoachWorkspaceRecommendation) -> [CoachWorkspaceAdjustment] {
        switch recommendation.action.kind {
        case "move":
            return [.moveDuration(minutes: 20), .moveDuration(minutes: 30), .moveDuration(minutes: 45)]
        case "rest":
            return [.restDuration(minutes: 10), .restDuration(minutes: 20), .restDuration(minutes: 30)]
        case "sleep":
            return [.sleepTime(minutes: 1_230), .sleepTime(minutes: 1_260), .sleepTime(minutes: 1_290)]
        default:
            return []
        }
    }

    static func evidenceSummary(for recommendation: CoachWorkspaceRecommendation) -> String {
        guard recommendation.evidence.fresh else { return "Waiting for fresh signals" }
        if recommendation.evidence.constraintGate { return "Using your confirmed limits" }
        let count = recommendation.evidence.sources.filter { $0.value != nil }.count
        return count == 1 ? "Grounded in 1 fresh signal" : "Grounded in \(count) fresh signals"
    }

    static func clockTime(_ minutes: Int) -> String {
        let hour = ((minutes / 60) + 11) % 12 + 1
        let suffix = minutes / 60 >= 12 ? "PM" : "AM"
        return String(format: "%d:%02d %@", hour, minutes % 60, suffix)
    }

    static func icon(for kind: String) -> String {
        switch kind {
        case "move": return "figure.run"
        case "rest": return "heart"
        case "sleep": return "moon.zzz"
        default: return "sparkles"
        }
    }
}

// MARK: - Workspace card

struct CoachWorkspaceView: View {
    let workspace: CoachWorkspaceSnapshot
    let isLoadingWorkspace: Bool
    let isPerformingAction: Bool
    let actionMessage: String?
    let actionError: String?
    let onAction: (CoachWorkspaceActionKind, CoachWorkspaceAdjustmentRequest?) -> Void
    let onRefresh: () -> Void
    let onRetry: () -> Void

    @State private var activeSheet: CoachWorkspaceSheet?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var recommendation: CoachWorkspaceRecommendation {
        CoachWorkspaceRecommendation(
            id: workspace.recommendation.id,
            localDay: workspace.recommendation.localDay,
            category: workspace.recommendation.category,
            action: workspace.effectiveAction,
            evidence: workspace.recommendation.evidence,
            materialSignature: workspace.recommendation.materialSignature
        )
    }

    private var isCalibration: Bool { CoachWorkspacePresentation.isCalibrationGuidance(for: workspace) }
    private var controls: [CoachWorkspaceControl] { CoachWorkspacePresentation.controls(for: workspace) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "sparkles")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Theme.Colors.accentContent)
                Text("TODAY'S COACH BRIEF")
                    .font(.caption2)
                    .tracking(0.8)
                    .foregroundStyle(Theme.Colors.accentContent)
                Spacer()
                Text(CoachWorkspacePresentation.evidenceSummary(for: recommendation))
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .multilineTextAlignment(.trailing)
            }

            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                Image(systemName: CoachWorkspacePresentation.icon(for: recommendation.action.kind))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Theme.Colors.accent.opacity(0.14)))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 5) {
                    Text(recommendation.action.title)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(actionDetail)
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }

            Text(recommendation.action.copy)
                .font(.body)
                .foregroundStyle(Theme.Colors.textPrimary)

            evidenceChips

            if isCalibration {
                calibrationControls
            } else if workspace.state.status == .planned {
                stateLabel("Added to today’s plan", icon: "checkmark.circle.fill")
            } else if workspace.state.status == .skipped {
                stateLabel("Skipped for today", icon: "forward.fill")
            } else if workspace.state.status == .completed {
                stateLabel("Completed", icon: "checkmark.circle.fill")
            } else if controls.contains(.addToPlan) {
                Button {
                    onAction(.accept, nil)
                } label: {
                    Label("Add to plan", systemImage: "calendar.badge.plus")
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(CoachWorkspacePrimaryButtonStyle())
                .disabled(isPerformingAction)
                .accessibilityHint("Adds this recommendation to today’s plan")
            }

            if let actionMessage, isPerformingAction {
                HStack(spacing: Theme.Spacing.sm) {
                    ProgressView().controlSize(.small)
                    Text(actionMessage).font(.footnote).foregroundStyle(Theme.Colors.textSecondary)
                }
                .accessibilityLabel(actionMessage)
            }

            if let actionError {
                ErrorCard(
                    title: "Couldn’t update today’s plan",
                    message: actionError,
                    actionLabel: "Try again",
                    actionIcon: "arrow.clockwise",
                    onAction: onRetry
                )
            }

            secondaryActions
        }
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.card)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous).strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.75))
        .accessibilityElement(children: .contain)
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .adjust:
                CoachWorkspaceAdjustSheet(recommendation: recommendation) { adjustment in
                    onAction(.adjust, adjustment.request)
                    activeSheet = nil
                }
            case .evidence:
                CoachWorkspaceEvidenceSheet(recommendation: recommendation)
            }
        }
    }

    private var actionDetail: String {
        var details: [String] = []
        if let duration = recommendation.action.durationMinutes { details.append("\(duration) min") }
        if recommendation.action.kind == "sleep" { details.append("Wind down \(CoachWorkspacePresentation.clockTime(recommendation.action.timeMinutes))") }
        if let intensity = recommendation.action.intensity { details.append(intensity.capitalized) }
        return details.isEmpty ? "Today" : details.joined(separator: " · ")
    }

    private var evidenceChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(recommendation.evidence.sources) { source in
                    Label(source.label, systemImage: source.icon)
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .background(Capsule().fill(Theme.Colors.accent.opacity(0.09)))
                }
            }
        }
        .accessibilityLabel("Evidence: \(CoachWorkspacePresentation.evidenceSummary(for: recommendation))")
    }

    @ViewBuilder
    private var calibrationControls: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(CoachWorkspacePresentation.calibrationGuidance(for: workspace))
                .font(.body)
                .foregroundStyle(Theme.Colors.textSecondary)
            Button {
                onRefresh()
            } label: {
                if isLoadingWorkspace {
                    HStack(spacing: Theme.Spacing.sm) {
                        ProgressView().controlSize(.small)
                        Text("Refreshing signals…")
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                } else {
                    Label("Refresh signals", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
            }
            .buttonStyle(CoachWorkspacePrimaryButtonStyle())
            .disabled(isLoadingWorkspace || isPerformingAction)
            .accessibilityLabel(isLoadingWorkspace ? "Refreshing signals" : "Refresh signals")
        }
    }

    private func stateLabel(_ title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(.body.weight(.semibold))
            .foregroundStyle(Theme.Colors.accentContent)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Theme.Colors.accent.opacity(0.13)))
            .accessibilityLabel(title)
    }

    @ViewBuilder
    private var secondaryActions: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(spacing: Theme.Spacing.sm) {
                transitionControls
                referenceControls
            }
        } else {
            VStack(spacing: Theme.Spacing.sm) {
                HStack(spacing: Theme.Spacing.sm) { transitionControls }
                HStack(spacing: Theme.Spacing.sm) { referenceControls }
            }
        }
    }

    @ViewBuilder
    private var transitionControls: some View {
        if controls.contains(.adjust) {
            Button("Adjust") { activeSheet = .adjust }
                .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
                .disabled(isPerformingAction || CoachWorkspacePresentation.adjustmentOptions(for: recommendation).isEmpty)
                .accessibilityHint("Choose a safe adjustment for this recommendation")
        }
        if controls.contains(.complete) {
            Button("Mark complete") { onAction(.complete, nil) }
                .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
                .disabled(isPerformingAction)
                .accessibilityHint("Marks this recommendation complete")
        }
        if controls.contains(.skip) {
            Button("Skip") { onAction(.skip, nil) }
                .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
                .disabled(isPerformingAction)
                .accessibilityHint("Skips this recommendation for today")
        }
    }

    @ViewBuilder
    private var referenceControls: some View {
        if controls.contains(.evidence) {
            Button("See evidence") { activeSheet = .evidence }
                .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
        }
        if controls.contains(.talk) {
            Button("Talk it through") { onAction(.openChat, nil) }
                .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
                .disabled(isPerformingAction)
                .accessibilityHint("Opens this recommendation in coach chat")
        }
    }
}

struct CoachWorkspaceCompactSummary: View {
    let workspace: CoachWorkspaceSnapshot

    private var recommendation: CoachWorkspaceRecommendation {
        CoachWorkspaceRecommendation(
            id: workspace.recommendation.id, localDay: workspace.recommendation.localDay,
            category: workspace.recommendation.category, action: workspace.effectiveAction,
            evidence: workspace.recommendation.evidence, materialSignature: workspace.recommendation.materialSignature
        )
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: workspace.state.status == .planned ? "checkmark.circle.fill" : CoachWorkspacePresentation.icon(for: recommendation.action.kind))
                .foregroundStyle(Theme.Colors.accentContent)
            VStack(alignment: .leading, spacing: 1) {
                Text(workspace.state.status == .planned ? "In today’s plan" : "Today’s recommendation")
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text(recommendation.action.title)
                    .font(.body)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.md)
        .frame(minHeight: 52)
        .background(.ultraThinMaterial)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.75))
        .shadow(color: Theme.Colors.cardShadow, radius: 8, x: 0, y: 3)
        .accessibilityElement(children: .combine)
    }
}

private enum CoachWorkspaceSheet: Identifiable {
    case adjust
    case evidence
    var id: String { self == .adjust ? "adjust" : "evidence" }
}

private struct CoachWorkspaceAdjustSheet: View {
    let recommendation: CoachWorkspaceRecommendation
    let select: (CoachWorkspaceAdjustment) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Keep it comfortable") {
                    Text("Choose a bounded adjustment. Your coach’s safety guidance stays the same.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.textSecondary)
                    ForEach(CoachWorkspacePresentation.adjustmentOptions(for: recommendation)) { option in
                        Button(option.label) { select(option) }
                            .frame(minHeight: 44)
                    }
                }
            }
            .navigationTitle("Adjust plan")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: dismiss.callAsFunction) } }
        }
        .presentationDetents([.medium])
    }
}

private struct CoachWorkspaceEvidenceSheet: View {
    let recommendation: CoachWorkspaceRecommendation
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Why this recommendation") {
                    Text(recommendation.action.copy)
                }
                Section("Signals") {
                    ForEach(recommendation.evidence.sources) { source in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(source.label).font(.body)
                            Text(source.detail).font(.subheadline).foregroundStyle(Theme.Colors.textSecondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
                if recommendation.evidence.constraintGate {
                    Section("Safety") { Text("A confirmed health limit is guiding this recommendation.") }
                }
            }
            .navigationTitle("Evidence")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done", action: dismiss.callAsFunction) } }
        }
    }
}

private struct CoachWorkspacePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body)
            .fontWeight(.semibold)
            .foregroundStyle(Theme.Colors.onAccent)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Theme.Colors.accent.opacity(configuration.isPressed ? 0.72 : 1)))
    }
}

private struct CoachWorkspaceSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline)
            .foregroundStyle(Theme.Colors.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Theme.Colors.card))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.75))
            .opacity(configuration.isPressed ? 0.68 : 1)
    }
}

#Preview("Loaded coach workspace") {
    CoachWorkspaceView(
        workspace: .previewLoaded,
        isLoadingWorkspace: false,
        isPerformingAction: false,
        actionMessage: nil,
        actionError: nil,
        onAction: { _, _ in },
        onRefresh: {},
        onRetry: {}
    )
    .padding()
    .background(Theme.Colors.canvas)
}

#Preview("Calibration coach workspace") {
    CoachWorkspaceView(
        workspace: .previewCalibration,
        isLoadingWorkspace: false,
        isPerformingAction: false,
        actionMessage: nil,
        actionError: nil,
        onAction: { _, _ in },
        onRefresh: {},
        onRetry: {}
    )
    .padding()
    .background(Theme.Colors.canvas)
}

private extension CoachWorkspaceSnapshot {
    static let previewLoaded = CoachWorkspaceSnapshot(
        recommendation: CoachWorkspaceRecommendation(
            id: "preview-recommendation",
            localDay: "2026-08-11",
            category: "training",
            action: CoachWorkspaceAction(
                title: "Keep it easy this afternoon",
                copy: "A comfortable session supports recovery and keeps your weekly rhythm intact.",
                kind: "move",
                timeMinutes: 1_020,
                durationMinutes: 30,
                intensity: "easy"
            ),
            evidence: CoachWorkspaceEvidence(
                fresh: true,
                sources: [
                    CoachWorkspaceEvidenceSource(metric: "hrv", observedAt: "2026-08-11T12:00:00.000Z", baseline: 56, value: 61),
                    CoachWorkspaceEvidenceSource(metric: "sleep", observedAt: "2026-08-11T12:00:00.000Z", baseline: 480, value: 462),
                ],
                constraintGate: false
            ),
            materialSignature: "preview-signature"
        ),
        state: CoachWorkspaceState(status: .ready, planItemId: nil, effectiveAction: nil)
    )

    static let previewCalibration = CoachWorkspaceSnapshot(
        recommendation: previewLoaded.recommendation,
        state: CoachWorkspaceState(status: .calibration, planItemId: nil, effectiveAction: nil)
    )
}
