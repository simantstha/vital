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

enum CoachWorkspacePresentation {
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
    let recommendation: CoachWorkspaceRecommendation
    let isPerformingAction: Bool
    let isPlanned: Bool
    let onAction: (CoachWorkspaceActionKind, CoachWorkspaceAdjustmentRequest?) -> Void

    @State private var activeSheet: CoachWorkspaceSheet?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.Colors.accentContent)
                Text("TODAY'S COACH BRIEF")
                    .font(Theme.Typography.labelSmall)
                    .tracking(0.8)
                    .foregroundStyle(Theme.Colors.accentContent)
                Spacer()
                Text(CoachWorkspacePresentation.evidenceSummary(for: recommendation))
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                    .multilineTextAlignment(.trailing)
            }

            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                Image(systemName: CoachWorkspacePresentation.icon(for: recommendation.action.kind))
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.Colors.accentContent)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Theme.Colors.accent.opacity(0.14)))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 5) {
                    Text(recommendation.action.title)
                        .font(Theme.Typography.titleLarge)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(actionDetail)
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }

            Text(recommendation.action.copy)
                .font(Theme.Typography.bodyMedium)
                .foregroundStyle(Theme.Colors.textPrimary)

            evidenceChips

            if isPlanned {
                Label("Added to today’s plan", systemImage: "checkmark.circle.fill")
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.accentContent)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Theme.Colors.accent.opacity(0.13)))
                    .accessibilityLabel("Added to today’s plan")
            } else {
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

            HStack(spacing: Theme.Spacing.sm) {
                Button("Adjust") { activeSheet = .adjust }
                    .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
                    .disabled(isPerformingAction || CoachWorkspacePresentation.adjustmentOptions(for: recommendation).isEmpty)
                Button("See evidence") { activeSheet = .evidence }
                    .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
                Button("Talk it through") { onAction(.openChat, nil) }
                    .buttonStyle(CoachWorkspaceSecondaryButtonStyle())
                    .disabled(isPerformingAction)
            }
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
                        .font(Theme.Typography.labelSmall)
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .background(Capsule().fill(Theme.Colors.accent.opacity(0.09)))
                }
            }
        }
        .accessibilityLabel("Evidence: \(CoachWorkspacePresentation.evidenceSummary(for: recommendation))")
    }
}

struct CoachWorkspaceCompactSummary: View {
    let recommendation: CoachWorkspaceRecommendation
    let isPlanned: Bool

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: isPlanned ? "checkmark.circle.fill" : CoachWorkspacePresentation.icon(for: recommendation.action.kind))
                .foregroundStyle(Theme.Colors.accentContent)
            VStack(alignment: .leading, spacing: 1) {
                Text(isPlanned ? "In today’s plan" : "Today’s recommendation")
                    .font(Theme.Typography.labelSmall)
                    .foregroundStyle(Theme.Colors.textSecondary)
                Text(recommendation.action.title)
                    .font(Theme.Typography.bodyMedium)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .lineLimit(1)
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
                        .font(Theme.Typography.bodySmall)
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
                            Text(source.label).font(Theme.Typography.bodyMedium)
                            Text(source.detail).font(Theme.Typography.bodySmall).foregroundStyle(Theme.Colors.textSecondary)
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
            .font(Theme.Typography.bodyMedium)
            .fontWeight(.semibold)
            .foregroundStyle(Theme.Colors.onAccent)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Theme.Colors.accent.opacity(configuration.isPressed ? 0.72 : 1)))
    }
}

private struct CoachWorkspaceSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Typography.labelMedium)
            .foregroundStyle(Theme.Colors.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Theme.Colors.card))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).strokeBorder(Theme.Colors.glassBorder, lineWidth: 0.75))
            .opacity(configuration.isPressed ? 0.68 : 1)
    }
}
