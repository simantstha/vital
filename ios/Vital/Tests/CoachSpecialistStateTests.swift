import XCTest
@testable import Vital

@MainActor
final class CoachSpecialistStateTests: XCTestCase {
    private let runningCoach = CoachPersonaSnapshot(
        id: "running-coach",
        title: "Running Coach",
        subtitle: "Vital Specialist",
        accent: "#4CC9F0",
        icon: "figure.run",
        sessionId: "session-1"
    )

    func testRestorationDecodesSpeakerSessionMetadataAndAuthoritativeState() throws {
        let json = #"""
        {
          "messages": [{
            "id": "message-1",
            "role": "assistant",
            "speaker": "specialist",
            "content": "Keep the first run easy.",
            "timestamp": "2026-07-11T12:05:00.000Z",
            "specialistSessionId": "session-1",
            "specialistMetadata": {
              "specialistId": "running-coach",
              "manifestVersion": "1.0.0",
              "name": "Running Coach",
              "role": "Vital Specialist",
              "accentColor": "#4CC9F0",
              "icon": "figure.run"
            }
          }],
          "activePersona": {
            "id": "running-coach",
            "title": "Running Coach",
            "subtitle": "Vital Specialist",
            "accent": "#4CC9F0",
            "icon": "figure.run",
            "sessionId": "session-1"
          },
          "pendingCard": {
            "phase": "return_proposed",
            "sessionId": "session-1",
            "specialist": {
              "id": "running-coach",
              "title": "Running Coach",
              "subtitle": "Vital Specialist",
              "accent": "#4CC9F0",
              "icon": "figure.run",
              "sessionId": "session-1"
            },
            "objective": "Plan a safe week",
            "returnSummary": { "outcomes": ["Week planned"] }
          }
        }
        """#

        let restored = try APIClient.decodeCoachRestoration(Data(json.utf8))

        XCTAssertEqual(restored.activePersona, runningCoach)
        XCTAssertEqual(restored.pendingCard?.phase, .returnProposed)
        XCTAssertEqual(restored.messages.first?.specialistSessionId, "session-1")
        XCTAssertEqual(restored.messages.first?.specialistMetadata?.name, "Running Coach")
    }

    func testNewAndLegacySSEEventsDecodeWithoutChangingLegacyShapes() throws {
        let text = try XCTUnwrap(APIClient.decodeCoachSSELine(#"data: {"type":"text","delta":"Hi"}"#))
        let tool = try XCTUnwrap(APIClient.decodeCoachSSELine(#"data: {"type":"tool_call","id":"t1","name":"get_workouts","label":"Checking","status":"started"}"#))
        let card = try XCTUnwrap(APIClient.decodeCoachSSELine(##"data: {"type":"handoff_card","phase":"proposed","sessionId":"session-1","specialist":{"id":"running-coach","title":"Running Coach","subtitle":"Vital Specialist","accent":"#4CC9F0","icon":"figure.run","sessionId":"session-1"},"objective":"Plan a safe week"}"##))
        let persona = try XCTUnwrap(APIClient.decodeCoachSSELine(##"data: {"type":"persona_changed","persona":{"id":"running-coach","title":"Running Coach","subtitle":"Vital Specialist","accent":"#4CC9F0","icon":"figure.run","sessionId":"session-1"}}"##))

        XCTAssertEqual(text, .text("Hi"))
        XCTAssertEqual(tool, .toolCall(id: "t1", name: "get_workouts", label: "Checking", done: false))
        XCTAssertEqual(card, .handoffCard(CoachHandoffCard(
            phase: .proposed,
            sessionId: "session-1",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )))
        XCTAssertEqual(persona, .personaChanged(runningCoach))
    }

    func testEverySpecialistActionEncodesStableWireRequest() throws {
        let expected = ["accept_handoff", "decline_handoff", "accept_return", "decline_return"]

        XCTAssertEqual(SpecialistAction.allCases.map(\.rawValue), expected)
        for action in SpecialistAction.allCases {
            let body = CoachActionRequestBody(
                sessionId: "session-1",
                actionId: CoachViewModel.stableActionId(sessionId: "session-1", action: action),
                action: action
            )
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: String])
            XCTAssertEqual(object["sessionId"], "session-1")
            XCTAssertEqual(object["action"], action.rawValue)
            XCTAssertEqual(object["actionId"], "ios:session-1:\(action.rawValue)")
        }
    }

    func testRestoreBuildsPendingReturnStateAndDurableSpecialistLabel() async {
        let message = CoachRestoredMessage(
            id: "message-1",
            role: "assistant",
            speaker: "specialist",
            content: "Keep the first run easy.",
            timestamp: "2026-07-11T12:05:00.000Z",
            specialistSessionId: "session-1",
            specialistMetadata: SpecialistMessageMetadata(
                specialistId: "running-coach",
                manifestVersion: "1.0.0",
                name: "Running Coach",
                role: "Vital Specialist",
                accentColor: "#4CC9F0",
                icon: "figure.run"
            )
        )
        let card = CoachHandoffCard(
            phase: .returnProposed,
            sessionId: "session-1",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [message], activePersona: runningCoach, pendingCard: card
        ))
        let viewModel = CoachViewModel(api: api)

        await viewModel.restoreConversation()

        XCTAssertEqual(viewModel.activePersona, runningCoach)
        XCTAssertEqual(viewModel.specialistState, .pendingReturn(card))
        guard case .message(let restoredMessage) = viewModel.rows.first else {
            return XCTFail("Expected restored message")
        }
        XCTAssertEqual(restoredMessage.speakerLabel, "Running Coach")
    }

    func testDuplicateInFlightActionTapIsSuppressed() async {
        let card = CoachHandoffCard(
            phase: .proposed,
            sessionId: "session-1",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: card
        ))
        api.holdActionStreamOpen = true
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()

        viewModel.performSpecialistAction(.acceptHandoff)
        viewModel.performSpecialistAction(.acceptHandoff)
        await waitUntil { api.actionRequests.count == 1 }

        XCTAssertEqual(api.actionRequests.count, 1)
        XCTAssertTrue(viewModel.isPerformingSpecialistAction)
        api.finishHeldAction()
    }

    func testAcceptHandoffUsesAuthoritativePersonaAndAddsJoinedSystemMessage() async {
        let card = CoachHandoffCard(
            phase: .proposed,
            sessionId: "session-1",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: card
        ))
        api.nextActionEvents = [
            .handoffCard(card.dismissed),
            .personaChanged(runningCoach),
        ]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()

        viewModel.performSpecialistAction(.acceptHandoff)
        await waitUntil { !viewModel.isPerformingSpecialistAction }

        XCTAssertEqual(viewModel.specialistState, .activeConsultation(runningCoach))
        XCTAssertTrue(viewModel.rows.contains {
            guard case .message(let message) = $0 else { return false }
            return message.role == .system && message.text == "Running Coach joined the conversation."
        })
    }

    func testInterruptedSpecialistReplyRetainsAuthoritativePersona() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: runningCoach, pendingCard: nil
        ))
        api.nextMessageFailure = TestFailure.interrupted
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        viewModel.input = "What should I run today?"

        viewModel.send()
        await waitUntil { !viewModel.isStreaming }

        XCTAssertEqual(viewModel.activePersona, runningCoach)
        XCTAssertEqual(viewModel.specialistState, .activeConsultation(runningCoach))
    }

    func testServerRollbackEventFollowedByFailureReturnsToVitalRecoverably() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: runningCoach, pendingCard: nil
        ))
        api.nextMessageEvents = [.personaChanged(.vital)]
        api.nextMessageFailure = TestFailure.unavailable
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        viewModel.input = "Help with this workout"

        viewModel.send()
        await waitUntil { !viewModel.isStreaming }

        XCTAssertEqual(viewModel.activePersona, .vital)
        guard case .recoverableRollback = viewModel.specialistState else {
            return XCTFail("Expected recoverable rollback state")
        }
    }

    func testHistoricalSpecialistLabelSurvivesReturnToVital() async {
        let metadata = SpecialistMessageMetadata(
            specialistId: "running-coach", manifestVersion: "1.0.0",
            name: "Running Coach", role: "Vital Specialist",
            accentColor: "#4CC9F0", icon: "figure.run"
        )
        let restoredMessage = CoachRestoredMessage(
            id: "message-1", role: "assistant", speaker: "specialist",
            content: "Week planned.", timestamp: "2026-07-11T12:05:00.000Z",
            specialistSessionId: "session-1", specialistMetadata: metadata
        )
        let card = CoachHandoffCard(
            phase: .returnProposed, sessionId: "session-1", specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [restoredMessage], activePersona: runningCoach, pendingCard: card
        ))
        api.nextActionEvents = [.handoffCard(card.dismissed), .personaChanged(.vital)]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()

        viewModel.performSpecialistAction(.acceptReturn)
        await waitUntil { !viewModel.isPerformingSpecialistAction }

        XCTAssertEqual(viewModel.activePersona, .vital)
        guard case .message(let historical) = viewModel.rows.first else {
            return XCTFail("Expected historical message")
        }
        XCTAssertEqual(historical.speakerLabel, "Running Coach")
    }

    private func waitUntil(
        _ predicate: @escaping @MainActor () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<100 where !predicate() {
            await Task.yield()
        }
        XCTAssertTrue(predicate(), file: file, line: line)
    }
}

private enum TestFailure: Error {
    case interrupted
    case unavailable
}

@MainActor
private final class FakeCoachAPI: CoachAPIProviding {
    struct ActionRequest {
        let sessionId: String
        let actionId: String
        let action: SpecialistAction
    }

    var restoration: CoachRestorationResponse
    var nextMessageEvents: [CoachStreamEvent] = []
    var nextMessageFailure: Error?
    var nextActionEvents: [CoachStreamEvent] = []
    var actionRequests: [ActionRequest] = []
    var holdActionStreamOpen = false
    private var heldActionContinuation: AsyncThrowingStream<CoachStreamEvent, Error>.Continuation?
    private var shouldFinishHeldAction = false

    init(restoration: CoachRestorationResponse) {
        self.restoration = restoration
    }

    func fetchCoachRestoration() async throws -> CoachRestorationResponse {
        restoration
    }

    func fetchCoachOpener() async throws -> String {
        "Fresh opener"
    }

    func streamCoach(message: String, imageBase64: String?, mode: String?) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        stream(events: nextMessageEvents, failure: nextMessageFailure)
    }

    func streamCoachAction(
        sessionId: String,
        actionId: String,
        action: SpecialistAction
    ) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        actionRequests.append(ActionRequest(sessionId: sessionId, actionId: actionId, action: action))
        if holdActionStreamOpen {
            return AsyncThrowingStream { continuation in
                heldActionContinuation = continuation
                if shouldFinishHeldAction { continuation.finish() }
            }
        }
        return stream(events: nextActionEvents, failure: nil)
    }

    func finishHeldAction() {
        shouldFinishHeldAction = true
        heldActionContinuation?.finish()
    }

    private func stream(
        events: [CoachStreamEvent],
        failure: Error?
    ) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            if let failure {
                continuation.finish(throwing: failure)
            } else {
                continuation.finish()
            }
        }
    }
}
