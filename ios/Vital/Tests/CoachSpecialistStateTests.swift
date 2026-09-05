import Combine
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
            "cardOccurrenceId": "30000000-0000-4000-8000-000000000001",
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
        XCTAssertEqual(restored.pendingCard?.cardOccurrenceId, "30000000-0000-4000-8000-000000000001")
        XCTAssertEqual(restored.messages.first?.specialistSessionId, "session-1")
        XCTAssertEqual(restored.messages.first?.specialistMetadata?.name, "Running Coach")
    }

    func testNewAndLegacySSEEventsDecodeWithoutChangingLegacyShapes() throws {
        let text = try XCTUnwrap(APIClient.decodeCoachSSELine(#"data: {"type":"text","delta":"Hi"}"#))
        let tool = try XCTUnwrap(APIClient.decodeCoachSSELine(#"data: {"type":"tool_call","id":"t1","name":"get_workouts","label":"Checking","status":"started"}"#))
        let card = try XCTUnwrap(APIClient.decodeCoachSSELine(##"data: {"type":"handoff_card","phase":"proposed","sessionId":"session-1","cardOccurrenceId":"30000000-0000-4000-8000-000000000001","specialist":{"id":"running-coach","title":"Running Coach","subtitle":"Vital Specialist","accent":"#4CC9F0","icon":"figure.run","sessionId":"session-1"},"objective":"Plan a safe week"}"##))
        let persona = try XCTUnwrap(APIClient.decodeCoachSSELine(##"data: {"type":"persona_changed","persona":{"id":"running-coach","title":"Running Coach","subtitle":"Vital Specialist","accent":"#4CC9F0","icon":"figure.run","sessionId":"session-1"}}"##))

        XCTAssertEqual(text, .text("Hi"))
        XCTAssertEqual(tool, .toolCall(id: "t1", name: "get_workouts", label: "Checking", done: false))
        XCTAssertEqual(card, .handoffCard(CoachHandoffCard(
            phase: .proposed,
            sessionId: "session-1",
            cardOccurrenceId: "30000000-0000-4000-8000-000000000001",
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
                cardOccurrenceId: "30000000-0000-4000-8000-000000000001",
                actionId: CoachViewModel.stableActionId(
                    sessionId: "session-1",
                    cardOccurrenceId: "30000000-0000-4000-8000-000000000001",
                    action: action
                ),
                action: action
            )
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: String])
            XCTAssertEqual(object["sessionId"], "session-1")
            XCTAssertEqual(object["action"], action.rawValue)
            XCTAssertEqual(object["cardOccurrenceId"], "30000000-0000-4000-8000-000000000001")
            XCTAssertEqual(object["actionId"], "ios:session-1:30000000-0000-4000-8000-000000000001:\(action.rawValue)")
        }
    }

    func testRepeatedReturnProposalGetsADistinctStableActionId() {
        let first = CoachViewModel.stableActionId(
            sessionId: "session-1",
            cardOccurrenceId: "30000000-0000-4000-8000-000000000001",
            action: .declineReturn
        )
        let second = CoachViewModel.stableActionId(
            sessionId: "session-1",
            cardOccurrenceId: "30000000-0000-4000-8000-000000000002",
            action: .declineReturn
        )

        XCTAssertNotEqual(first, second)
    }

    func testRepeatedReturnDeclinesUseDistinctOccurrencesAndIgnoreStaleDismissal() async {
        let first = CoachHandoffCard(
            phase: .returnProposed,
            sessionId: "session-1",
            cardOccurrenceId: "30000000-0000-4000-8000-000000000001",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
        let second = CoachHandoffCard(
            phase: .returnProposed,
            sessionId: "session-1",
            cardOccurrenceId: "30000000-0000-4000-8000-000000000002",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: runningCoach, pendingCard: first
        ))
        api.nextActionEvents = [.handoffCard(first.dismissed), .personaChanged(runningCoach)]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()

        viewModel.performSpecialistAction(.declineReturn)
        await waitForSpecialistActionToSettle(viewModel)
        api.nextMessageEvents = [.handoffCard(second), .handoffCard(first.dismissed)]
        viewModel.input = "Keep coaching"
        viewModel.send()
        await waitForStreamToFinish(viewModel)
        XCTAssertEqual(viewModel.pendingHandoffCard, second)

        api.nextActionEvents = [.handoffCard(second.dismissed), .personaChanged(runningCoach)]
        viewModel.performSpecialistAction(.declineReturn)
        await waitForSpecialistActionToSettle(viewModel)

        XCTAssertEqual(api.actionRequests.map(\.cardOccurrenceId), [
            first.cardOccurrenceId,
            second.cardOccurrenceId,
        ])
        XCTAssertNotEqual(api.actionRequests[0].actionId, api.actionRequests[1].actionId)
        XCTAssertNil(viewModel.pendingHandoffCard)
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
            cardOccurrenceId: "return-occurrence",
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
            cardOccurrenceId: "proposal-occurrence",
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
        await waitForActionRequest(api)

        XCTAssertEqual(api.actionRequests.count, 1)
        XCTAssertTrue(viewModel.isPerformingSpecialistAction)
        api.finishHeldAction()
    }

    func testAcceptHandoffUsesAuthoritativePersonaAndAddsJoinedSystemMessage() async {
        let card = CoachHandoffCard(
            phase: .proposed,
            sessionId: "session-1",
            cardOccurrenceId: "proposal-occurrence",
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
        await waitForSpecialistActionToSettle(viewModel)

        XCTAssertEqual(viewModel.specialistState, .activeConsultation(runningCoach))
        XCTAssertTrue(viewModel.rows.contains {
            guard case .message(let message) = $0 else { return false }
            return message.role == .system && message.text == "Running Coach joined."
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
        await waitForStreamToFinish(viewModel)

        XCTAssertEqual(viewModel.activePersona, runningCoach)
        XCTAssertEqual(viewModel.specialistState, .activeConsultation(runningCoach))
    }

    func testRollbackAfterSpecialistPartialTextPreservesTurnSpeaker() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: runningCoach, pendingCard: nil
        ))
        api.nextMessageEvents = [
            .text("Start with an easy ten-minute warmup."),
            .personaChanged(.vital),
        ]
        api.nextMessageFailure = TestFailure.unavailable
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        viewModel.input = "What should I run?"

        viewModel.send()
        await waitForStreamToFinish(viewModel)

        XCTAssertEqual(viewModel.activePersona, .vital)
        guard let turn = viewModel.rows.compactMap({ row -> AssistantTurn? in
            guard case .assistantTurn(let turn) = row else { return nil }
            return turn
        }).last else {
            return XCTFail("Expected assistant turn")
        }
        XCTAssertEqual(turn.text, "Start with an easy ten-minute warmup.")
        XCTAssertEqual(turn.speakerLabel, "Running Coach")
    }

    func testPersonaChangeBeforeTextLabelsTypedAcceptanceReplyAsRunningCoach() async {
        let card = CoachHandoffCard(
            phase: .proposed, sessionId: "session-1", cardOccurrenceId: "proposal-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: card
        ))
        api.nextMessageEvents = [
            .handoffCard(card.dismissed),
            .toolCall(id: "context", name: "get_workouts", label: "Checking runs", done: false),
            .personaChanged(runningCoach),
            .text("Let's plan your week."),
            .toolCall(id: "context", name: "get_workouts", label: "Checking runs", done: true),
        ]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        viewModel.input = "yes"

        viewModel.send()
        await waitForStreamToFinish(viewModel)

        guard let turn = viewModel.rows.compactMap({ row -> AssistantTurn? in
            guard case .assistantTurn(let turn) = row else { return nil }
            return turn
        }).last else {
            return XCTFail("Expected assistant turn")
        }
        XCTAssertEqual(turn.speakerLabel, "Running Coach")
    }

    func testPersonaChangeBeforeTextLabelsExplicitReturnReplyAsVital() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: runningCoach, pendingCard: nil
        ))
        api.nextMessageEvents = [
            .personaChanged(.vital),
            .text("You're back with Vital."),
        ]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        viewModel.input = "return to Vital"

        viewModel.send()
        await waitForStreamToFinish(viewModel)

        guard case .assistantTurn(let turn) = viewModel.rows.last else {
            return XCTFail("Expected assistant turn")
        }
        XCTAssertEqual(turn.speakerLabel, "Vital Coach")
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
        await waitForStreamToFinish(viewModel)

        XCTAssertEqual(viewModel.activePersona, .vital)
        guard case .recoverableRollback = viewModel.specialistState else {
            return XCTFail("Expected recoverable rollback state")
        }
    }

    func testAuthoritativeVitalRollbackClearsPendingHandoffProposal() async {
        let card = CoachHandoffCard(
            phase: .proposed,
            sessionId: "session-1",
            cardOccurrenceId: "proposal-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: card
        ))
        api.nextMessageEvents = [.personaChanged(.vital)]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        viewModel.input = "Continue with Vital"

        viewModel.send()
        await waitForStreamToFinish(viewModel)

        XCTAssertEqual(viewModel.activePersona, .vital)
        XCTAssertNil(viewModel.pendingHandoffCard)
        XCTAssertEqual(viewModel.specialistState, .vital)
    }

    func testAuthoritativeVitalRollbackClearsPendingReturnProposal() async {
        let card = CoachHandoffCard(
            phase: .returnProposed,
            sessionId: "session-1",
            cardOccurrenceId: "return-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week",
            returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: runningCoach, pendingCard: card
        ))
        api.nextMessageEvents = [.personaChanged(.vital)]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        viewModel.input = "Continue with Vital"

        viewModel.send()
        await waitForStreamToFinish(viewModel)

        XCTAssertEqual(viewModel.activePersona, .vital)
        XCTAssertNil(viewModel.pendingHandoffCard)
        XCTAssertEqual(viewModel.specialistState, .vital)
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
            phase: .returnProposed, sessionId: "session-1", cardOccurrenceId: "return-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [restoredMessage], activePersona: runningCoach, pendingCard: card
        ))
        api.nextActionEvents = [.handoffCard(card.dismissed), .personaChanged(.vital)]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()

        viewModel.performSpecialistAction(.acceptReturn)
        await waitForSpecialistActionToSettle(viewModel)

        XCTAssertEqual(viewModel.activePersona, .vital)
        guard case .message(let historical) = viewModel.rows.first else {
            return XCTFail("Expected historical message")
        }
        XCTAssertEqual(historical.speakerLabel, "Running Coach")
    }

    func testActionFailureReconcilesAuthoritativeStateWithoutReplacingTranscript() async {
        let card = CoachHandoffCard(
            phase: .proposed, sessionId: "session-1", cardOccurrenceId: "proposal-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let restoredMessage = CoachRestoredMessage(
            id: "20000000-0000-4000-8000-000000000001",
            role: "assistant", speaker: "coach", content: "Want a running specialist?",
            timestamp: "2026-07-11T12:05:00.000Z",
            specialistSessionId: nil, specialistMetadata: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [restoredMessage], activePersona: .vital, pendingCard: card
        ))
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        let originalRows = viewModel.rows
        api.restoration = CoachRestorationResponse(
            messages: [], activePersona: runningCoach, pendingCard: nil
        )
        api.nextActionFailure = TestFailure.interrupted

        viewModel.performSpecialistAction(.acceptHandoff)
        await waitForSpecialistActionToSettle(viewModel)

        XCTAssertEqual(api.restorationRequestCount, 2)
        XCTAssertEqual(viewModel.rows, originalRows)
        XCTAssertEqual(viewModel.activePersona, runningCoach)
        XCTAssertNil(viewModel.pendingHandoffCard)
        XCTAssertEqual(viewModel.specialistState, .activeConsultation(runningCoach))
    }

    func testAcceptHandoffStreamsSpecialistOpeningTurnAttributedToSpecialist() async {
        let card = CoachHandoffCard(
            phase: .proposed, sessionId: "session-1", cardOccurrenceId: "proposal-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: card
        ))
        // No new SSE event types: the accept path just starts emitting the
        // same text/tool_call events `send()` already handles, with
        // persona_changed landing before the specialist's first token.
        api.nextActionEvents = [
            .handoffCard(card.dismissed),
            .personaChanged(runningCoach),
            .toolCall(id: "context", name: "get_workouts", label: "Checking runs", done: false),
            .text("Thanks for the context — "),
            .text("let's plan your week."),
            .toolCall(id: "context", name: "get_workouts", label: "Checking runs", done: true),
        ]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()

        viewModel.performSpecialistAction(.acceptHandoff)
        await waitForSpecialistActionToSettle(viewModel)

        guard case .assistantTurn(let turn) = viewModel.rows.last else {
            return XCTFail("Expected the specialist's opening reply to stream into an assistant turn")
        }
        XCTAssertEqual(turn.speakerLabel, "Running Coach")
        XCTAssertEqual(turn.text, "Thanks for the context — let's plan your week.")
        XCTAssertTrue(turn.isFinished)
        XCTAssertTrue(turn.toolCalls.allSatisfy(\.isDone))
        XCTAssertEqual(viewModel.specialistState, .activeConsultation(runningCoach))
    }

    func testDeclineHandoffStillProducesNoAssistantTurn() async {
        let card = CoachHandoffCard(
            phase: .proposed, sessionId: "session-1", cardOccurrenceId: "proposal-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: card
        ))
        // A decline never continues into a model turn server-side, so the
        // stream still ends on just the two lifecycle events plus `done` —
        // that must keep producing zero transcript rows, exactly as before.
        api.nextActionEvents = [
            .handoffCard(card.dismissed),
            .personaChanged(.vital),
        ]
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        let rowsBefore = viewModel.rows

        viewModel.performSpecialistAction(.declineHandoff)
        await waitForSpecialistActionToSettle(viewModel)

        XCTAssertEqual(viewModel.rows, rowsBefore)
        XCTAssertNil(viewModel.pendingHandoffCard)
        XCTAssertEqual(viewModel.specialistState, .vital)
    }

    func testSendIsBlockedWhileASpecialistActionIsStreaming() async {
        let card = CoachHandoffCard(
            phase: .proposed, sessionId: "session-1", cardOccurrenceId: "proposal-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: card
        ))
        api.holdActionStreamOpen = true
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()

        viewModel.performSpecialistAction(.acceptHandoff)
        XCTAssertTrue(viewModel.isPerformingSpecialistAction)

        // The affordance half: every composer control (send button, mic,
        // suggestion chips, New chat) gates on `isBusy`, so it must report
        // busy here — gating them on `isStreaming` instead left them lit and
        // tappable during a handoff while `send()` silently dropped the tap.
        XCTAssertTrue(viewModel.isBusy)
        // ...but NOT via `isStreaming`, which is what the send button's stop
        // affordance keys off. A specialist action isn't user-cancellable, so
        // the control must render as a disabled arrow, never a stop button.
        XCTAssertFalse(viewModel.isStreaming)

        // send() must not race the still-streaming specialist turn for
        // `pendingAssistantId`/`rows` — it should no-op while the action is
        // in flight, the same way a second `send()` already no-ops today.
        viewModel.input = "Should be blocked"
        viewModel.send()

        XCTAssertEqual(viewModel.input, "Should be blocked")
        XCTAssertFalse(viewModel.rows.contains {
            guard case .message(let message) = $0 else { return false }
            return message.role == .user && message.text == "Should be blocked"
        })

        api.finishHeldAction()
        await waitForSpecialistActionToSettle(viewModel)
        // Once the action settles the composer frees up again — otherwise
        // this guard would strand the user in a permanently disabled UI.
        XCTAssertFalse(viewModel.isBusy)
    }

    func testComposerEntryPointsAllNoOpWhileASpecialistActionStreams() async {
        let card = CoachHandoffCard(
            phase: .proposed, sessionId: "session-1", cardOccurrenceId: "proposal-occurrence",
            specialist: runningCoach,
            objective: "Plan a safe week", returnSummary: nil
        )
        let restoredMessage = CoachRestoredMessage(
            id: "20000000-0000-4000-8000-000000000001",
            role: "assistant", speaker: "coach", content: "Want a running specialist?",
            timestamp: "2026-07-11T12:05:00.000Z",
            specialistSessionId: nil, specialistMetadata: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [restoredMessage], activePersona: .vital, pendingCard: card
        ))
        api.holdActionStreamOpen = true
        let viewModel = CoachViewModel(api: api)
        await viewModel.restoreConversation()
        let rowsBefore = viewModel.rows

        viewModel.performSpecialistAction(.acceptHandoff)
        XCTAssertTrue(viewModel.isBusy)

        // Each of these backs a control that is now `.disabled(vm.isBusy)`.
        // They must also be inert at the model level: a disabled affordance
        // isn't a guarantee, and both `startNewChat` and the voice path would
        // otherwise clear or race the transcript the handoff is streaming into.
        viewModel.startNewChat()
        viewModel.toggleVoiceRecording()
        viewModel.sendExternalVoiceTranscript("Voice while handing off")
        viewModel.refreshIfStale()

        XCTAssertEqual(viewModel.rows, rowsBefore)
        XCTAssertFalse(viewModel.transcriber.isRecording)
        XCTAssertEqual(api.restorationRequestCount, 1)

        api.finishHeldAction()
        await waitForSpecialistActionToSettle(viewModel)
    }

    // MARK: - Waiting for asynchronous work

    // These replace a `for _ in 0..<100 where !predicate() { await Task.yield() }`
    // spin-wait, which was the single source of this suite's flakiness: the
    // same commit produced 5 assertion failures on one run and 0 on the next.
    //
    // `Task.yield()` only promises to let *already-runnable* work on this
    // executor take a turn. It is not a clock and it is not a signal, so a
    // fixed 100-iteration budget was really a bet that the work under test
    // would finish within 100 main-actor scheduling turns. On a cold test
    // process that bet loses: the test host app boots alongside the tests and
    // floods the main actor with its own callbacks (HealthKit authorization
    // queries, URLSession failures against a dev server that isn't running),
    // and the awaited continuation may be resumed from a different executor
    // entirely, which no number of main-actor yields can hurry along. The
    // loop then burned all 100 turns without the state ever changing and
    // reported a false failure — followed by a cascade of downstream
    // assertions failing against half-finished state, which is why one flaky
    // wait showed up as five failures.
    //
    // Note the same helper passed 25/25 back-to-back iterations in a warm
    // process; only cold runs failed. That is the signature of a scheduling
    // bet, not of a race in the code under test.
    //
    // The replacement waits on the real signal instead of guessing: the view
    // model is an `ObservableObject`, so every `@Published` mutation it makes
    // publishes through `objectWillChange`, and the fake API reports when a
    // request actually reaches it. Nothing polls, and every wait carries a
    // deadline so a genuinely stuck condition fails loudly and quickly
    // instead of hanging or passing by luck.

    /// Waits for the specialist action started by `performSpecialistAction`
    /// to finish, including the restoration it performs on failure.
    private func waitForSpecialistActionToSettle(
        _ viewModel: CoachViewModel,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        await waitUntil(
            viewModel,
            "isPerformingSpecialistAction returns to false",
            file: file,
            line: line
        ) { !viewModel.isPerformingSpecialistAction }
    }

    /// Waits for the turn started by `send()` to finish streaming, including
    /// the reveal-buffer flush and the error recovery on a failed stream.
    private func waitForStreamToFinish(
        _ viewModel: CoachViewModel,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        await waitUntil(
            viewModel,
            "isStreaming returns to false",
            file: file,
            line: line
        ) { !viewModel.isStreaming }
    }

    /// Waits until the in-flight specialist action has actually reached the
    /// API. `performSpecialistAction` dispatches into a `Task`, so the
    /// request is recorded asynchronously; this awaits the fake's own
    /// callback rather than watching `actionRequests` change from outside.
    private func waitForActionRequest(
        _ api: FakeCoachAPI,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        guard api.actionRequests.isEmpty else { return }
        let recorded = expectation(description: "a specialist action reaches the API")
        recorded.assertForOverFulfill = false
        api.onActionRequest = { recorded.fulfill() }
        await fulfillment(of: [recorded], timeout: Self.waitTimeout)
        api.onActionRequest = nil
    }

    /// Generous on purpose: it is a deadlock backstop, not a tuning knob.
    /// Every wait here settles in milliseconds when it settles at all, so a
    /// long timeout costs nothing on a passing run while still bounding a
    /// hung one.
    private static let waitTimeout: TimeInterval = 10

    /// Re-evaluates `predicate` whenever `viewModel` announces a change,
    /// failing with the awaited condition named if it never holds.
    private func waitUntil(
        _ viewModel: CoachViewModel,
        _ condition: String,
        timeout: TimeInterval = CoachSpecialistStateTests.waitTimeout,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ predicate: @escaping @MainActor () -> Bool
    ) async {
        if predicate() { return }

        let satisfied = expectation(description: condition)
        // The predicate can hold across several successive published changes;
        // only the first one matters.
        satisfied.assertForOverFulfill = false

        let cancellable = viewModel.objectWillChange
            // `objectWillChange` fires from `willSet`, i.e. *before* the new
            // value is stored, so evaluating the predicate synchronously here
            // would still read the pre-change state. Hopping through the main
            // queue re-checks on the next turn, once the setter — and the rest
            // of the synchronous work surrounding it — has completed.
            .receive(on: DispatchQueue.main)
            .sink { _ in
                MainActor.assumeIsolated {
                    if predicate() { satisfied.fulfill() }
                }
            }
        defer { cancellable.cancel() }

        await fulfillment(of: [satisfied], timeout: timeout)

        // `fulfillment` already reports the timeout; this pins the failure to
        // the awaited condition and to the caller's line rather than to the
        // helper's.
        XCTAssertTrue(
            predicate(),
            "Timed out after \(timeout)s waiting for \(condition).",
            file: file,
            line: line
        )
    }
}

private enum TestFailure: Error {
    case interrupted
    case unavailable
}

// Not `private`: reused by CoachAnswerBundleTests (same test target) to drive
// CoachViewModel through a real send()/stream lifecycle for its
// stopGenerating() regression test. `private` on a top-level declaration is
// file-scoped in Swift, which would otherwise make it invisible there.
@MainActor
final class FakeCoachAPI: CoachAPIProviding {
    struct ActionRequest {
        let sessionId: String
        let cardOccurrenceId: String
        let actionId: String
        let action: SpecialistAction
    }

    var restoration: CoachRestorationResponse
    var nextMessageEvents: [CoachStreamEvent] = []
    var nextMessageFailure: Error?
    var nextActionEvents: [CoachStreamEvent] = []
    var nextActionFailure: Error?
    var actionRequests: [ActionRequest] = []

    /// Fired once per recorded request, so a test can await the action task
    /// actually reaching the API instead of polling `actionRequests`.
    /// `performSpecialistAction` records asynchronously, and appending to
    /// this array publishes nothing the view model observes, so this is the
    /// only real signal that the request landed.
    var onActionRequest: (@MainActor () -> Void)? = nil
    private(set) var restorationRequestCount = 0
    var holdActionStreamOpen = false
    private var heldActionContinuation: AsyncThrowingStream<CoachStreamEvent, Error>.Continuation?
    private var shouldFinishHeldAction = false

    init(restoration: CoachRestorationResponse) {
        self.restoration = restoration
    }

    func uploadSTTAudio(fileURL: URL) async -> String? {
        nil
    }

    func fetchCoachRestoration() async throws -> CoachRestorationResponse {
        restorationRequestCount += 1
        return restoration
    }

    func fetchCoachOpener() async throws -> String {
        "Fresh opener"
    }

    func resetCoachConversation() async throws {
        // No-op for testing
    }

    func streamCoach(message: String, imageBase64: String?, mode: String?) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        stream(events: nextMessageEvents, failure: nextMessageFailure)
    }

    func streamCoachAction(
        sessionId: String,
        cardOccurrenceId: String,
        actionId: String,
        action: SpecialistAction
    ) -> AsyncThrowingStream<CoachStreamEvent, Error> {
        actionRequests.append(ActionRequest(
            sessionId: sessionId,
            cardOccurrenceId: cardOccurrenceId,
            actionId: actionId,
            action: action
        ))
        onActionRequest?()
        if holdActionStreamOpen {
            return AsyncThrowingStream { continuation in
                heldActionContinuation = continuation
                if shouldFinishHeldAction { continuation.finish() }
            }
        }
        return stream(events: nextActionEvents, failure: nextActionFailure)
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
