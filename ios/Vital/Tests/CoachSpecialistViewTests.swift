import XCTest
import SwiftUI
@testable import Vital

@MainActor
final class CoachSpecialistViewTests: XCTestCase {
    private let runningCoach = CoachPersonaSnapshot(
        id: "running-coach",
        title: "Running Coach",
        subtitle: "Vital Specialist",
        accent: "#4CC9F0",
        icon: "figure.run",
        sessionId: "session-1"
    )

    func testHeaderPresentationUsesVitalDefaultsAndRunningCoachPersona() {
        let vital = CoachViewPresentation.header(for: .vital)
        XCTAssertEqual(vital.title, "Coach")
        XCTAssertEqual(vital.subtitle, "Vital AI")
        XCTAssertEqual(vital.iconSystemName, "message.fill")
        XCTAssertEqual(vital.accentHex, "#C7F23B")

        let specialist = CoachViewPresentation.header(for: runningCoach)
        XCTAssertEqual(specialist.title, "Running Coach")
        XCTAssertEqual(specialist.subtitle, "Vital Specialist")
        XCTAssertEqual(specialist.iconSystemName, "figure.run")
        XCTAssertEqual(specialist.accentHex, "#4CC9F0")
    }

    func testProposedHandoffCardLabelsAndDuplicateActionDisabledState() {
        let card = proposedCard()

        let idle = CoachViewPresentation.handoffCard(for: card, isPerformingAction: false)
        XCTAssertEqual(idle.primaryAction.title, "Bring them in")
        XCTAssertEqual(idle.primaryAction.action, .acceptHandoff)
        XCTAssertFalse(idle.primaryAction.requiresConfirmation)
        XCTAssertTrue(idle.primaryAction.isEnabled)
        XCTAssertEqual(idle.secondaryAction.title, "Not now")
        XCTAssertEqual(idle.secondaryAction.action, .declineHandoff)
        XCTAssertFalse(idle.secondaryAction.requiresConfirmation)
        XCTAssertTrue(idle.secondaryAction.isEnabled)

        let performing = CoachViewPresentation.handoffCard(for: card, isPerformingAction: true)
        XCTAssertFalse(performing.primaryAction.isEnabled)
        XCTAssertFalse(performing.secondaryAction.isEnabled)
    }

    func testReturnActionsRequireConfirmationBeforeLeavingRunningCoach() {
        let card = returnCard()

        let presentation = CoachViewPresentation.handoffCard(for: card, isPerformingAction: false)
        XCTAssertEqual(presentation.primaryAction.action, .acceptReturn)
        XCTAssertEqual(presentation.secondaryAction.action, .declineReturn)
        XCTAssertTrue(presentation.primaryAction.requiresConfirmation)
        XCTAssertTrue(presentation.secondaryAction.requiresConfirmation)
        XCTAssertEqual(presentation.primaryAction.confirmationTitle, "Return to Vital?")
        XCTAssertEqual(presentation.secondaryAction.confirmationTitle, "Stay with Running Coach?")
    }

    func testJoinedSystemRowTextUsesSpecialistTitle() {
        XCTAssertEqual(
            CoachViewPresentation.joinedSystemRowText(for: runningCoach),
            "Running Coach joined."
        )
    }

    func testJoinedSystemRowStaysSingleLineUntilAccessibilityDynamicType() {
        XCTAssertEqual(
            CoachViewPresentation.joinedSystemRowLineLimit(for: .large),
            1
        )
        XCTAssertNil(
            CoachViewPresentation.joinedSystemRowLineLimit(for: .accessibility1)
        )
    }

    func testReturnSummaryRendersEveryCategoryInDeterministicCompactOrder() {
        let summary: JSONValue = .object([
            "nextSteps": .array([.string("Check in next week")]),
            "unresolvedRisks": .array([.string("Watch the soreness response")]),
            "recommendations": .array([.string("Keep easy runs conversational")]),
            "decisions": .array([.string("Run three times")]),
            "outcomes": .array([.string("Training week planned")]),
        ])

        XCTAssertEqual(
            CoachViewPresentation.returnSummarySections(from: summary),
            [
                .init(title: "Outcomes", items: ["Training week planned"]),
                .init(title: "Decisions", items: ["Run three times"]),
                .init(title: "Recommendations", items: ["Keep easy runs conversational"]),
                .init(title: "Unresolved risks", items: ["Watch the soreness response"]),
                .init(title: "Next steps", items: ["Check in next week"]),
            ]
        )
    }

    func testReturnSummaryOmitsEmptyAndMalformedCategories() {
        let summary: JSONValue = .object([
            "outcomes": .array([.string("  Week planned  "), .string(" ")]),
            "decisions": .string("not an array"),
            "recommendations": .array([]),
            "unresolvedRisks": .array([.int(4)]),
            "nextSteps": .array([.string("Review after the long run")]),
        ])

        XCTAssertEqual(
            CoachViewPresentation.returnSummarySections(from: summary),
            [
                .init(title: "Outcomes", items: ["Week planned"]),
                .init(title: "Next steps", items: ["Review after the long run"]),
            ]
        )
    }

    func testHistoricalSpecialistBubbleKeepsPermanentLabelAndAccentFromMessageMetadataAfterRollback() {
        let message = ChatMessage(
            role: .assistant,
            text: "Start with an easy ten-minute warmup.",
            specialistMetadata: SpecialistMessageMetadata(
                specialistId: "running-coach",
                manifestVersion: "1.0.0",
                name: "Running Coach",
                role: "Vital Specialist",
                accentColor: "#4CC9F0",
                icon: "figure.run"
            )
        )

        let bubble = CoachViewPresentation.messageBubble(for: message)
        XCTAssertEqual(bubble.speakerLabel, "Running Coach")
        XCTAssertEqual(bubble.bubbleLabel, "RUNNING COACH")
        XCTAssertEqual(bubble.accentHex, "#4CC9F0")
    }

    func testHistoricalSpecialistTurnKeepsPermanentLabelAndAccentAfterRollback() {
        let turn = AssistantTurn(id: UUID(), persona: runningCoach)

        let bubble = CoachViewPresentation.assistantTurn(for: turn)
        XCTAssertEqual(bubble.speakerLabel, "Running Coach")
        XCTAssertEqual(bubble.bubbleLabel, "RUNNING COACH")
        XCTAssertEqual(bubble.accentHex, "#4CC9F0")
    }

    func testSpecialistColorsAdaptForLightAndDarkMode() {
        let lightTraits = UITraitCollection(userInterfaceStyle: .light)
        let darkTraits = UITraitCollection(userInterfaceStyle: .dark)
        let accent = UIColor(Theme.Colors.specialistAccent)
        let edgeGlow = UIColor(Theme.Colors.specialistEdgeGlow)

        XCTAssertNotEqual(
            accent.resolvedColor(with: lightTraits),
            accent.resolvedColor(with: darkTraits)
        )
        XCTAssertEqual(
            edgeGlow.resolvedColor(with: lightTraits),
            edgeGlow.resolvedColor(with: darkTraits)
        )
    }

    private func proposedCard() -> CoachHandoffCard {
        CoachHandoffCard(
            phase: .proposed,
            sessionId: "session-1",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
    }

    private func returnCard() -> CoachHandoffCard {
        CoachHandoffCard(
            phase: .returnProposed,
            sessionId: "session-1",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
    }
}
