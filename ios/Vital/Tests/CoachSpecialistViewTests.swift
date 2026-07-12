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
            "Running Coach joined the conversation."
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
        let glassFill = UIColor(Theme.Colors.specialistGlassFill)

        XCTAssertNotEqual(
            accent.resolvedColor(with: lightTraits),
            accent.resolvedColor(with: darkTraits)
        )
        XCTAssertEqual(
            edgeGlow.resolvedColor(with: lightTraits),
            edgeGlow.resolvedColor(with: darkTraits)
        )
        XCTAssertNotEqual(
            glassFill.resolvedColor(with: lightTraits),
            glassFill.resolvedColor(with: darkTraits)
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
