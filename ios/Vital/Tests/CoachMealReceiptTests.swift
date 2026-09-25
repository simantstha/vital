import Combine
import XCTest
@testable import Vital

/// Coverage for "meal logs instant + Undo" (the coach half): decoding the
/// `meal_logged` SSE event (including that unrecognized event types are
/// still ignored, per `decodeCoachSSELine`'s forward-compatibility contract)
/// and the inline receipt's Undo state machine
/// (logged → undoing → removed / error).
@MainActor
final class CoachMealReceiptTests: XCTestCase {

    // MARK: - SSE decoding

    func testMealLoggedEventDecodesIntoMealLoggedCase() throws {
        let event = try XCTUnwrap(APIClient.decodeCoachSSELine(
            #"data: {"type":"meal_logged","id":"evt-123","name":"Two eggs and toast","kcal":340,"p":18,"c":28,"f":16}"#
        ))
        XCTAssertEqual(event, .mealLogged(CoachMealReceipt(
            id: "evt-123", name: "Two eggs and toast", kcal: 340, p: 18, c: 28, f: 16
        )))
    }

    /// A `meal_logged` payload missing a required field (e.g. an older/buggy
    /// server) must not crash the decode — it's simply dropped, same as any
    /// other malformed event.
    func testMealLoggedEventMissingAFieldDecodesToNil() throws {
        let event = try APIClient.decodeCoachSSELine(
            #"data: {"type":"meal_logged","id":"evt-123","name":"Toast","kcal":340,"p":18,"c":28}"#
        )
        XCTAssertNil(event)
    }

    /// The forward-compatibility contract `decodeCoachSSELine`'s doc comment
    /// promises: an event type this (older) client build doesn't recognize
    /// yet is dropped rather than throwing or crashing the stream — this is
    /// what lets a server ship a brand-new event type (as `meal_logged` once
    /// was) ahead of the app update that understands it.
    func testUnknownEventTypeDecodesToNilRatherThanThrowing() throws {
        let event = try APIClient.decodeCoachSSELine(
            #"data: {"type":"some_future_event","foo":"bar"}"#
        )
        XCTAssertNil(event)
    }

    func testStreamEventsPreservesUnrecognizedEventsAsNilAmongKnownOnes() throws {
        let lines = [
            #"data: {"type":"text","delta":"Logged it "}"#,
            #"data: {"type":"some_future_event","foo":"bar"}"#,
            #"data: {"type":"meal_logged","id":"evt-9","name":"Oats","kcal":210,"p":8,"c":32,"f":5}"#,
        ]
        let decoded = try lines.map { try APIClient.decodeCoachSSELine($0) }
        XCTAssertEqual(decoded, [
            .text("Logged it "),
            nil,
            .mealLogged(CoachMealReceipt(id: "evt-9", name: "Oats", kcal: 210, p: 8, c: 32, f: 5)),
        ])
    }

    /// `items` present — an estimator-routed log_meal — decodes into
    /// `CoachMealReceipt.items`.
    func testMealLoggedEventWithItemsDecodesTheBreakdown() throws {
        let event = try XCTUnwrap(APIClient.decodeCoachSSELine(
            #"""
            data: {"type":"meal_logged","id":"evt-1","name":"White rice, cooked and chicken curry","kcal":942,"p":31,"c":154,"f":20,
            "items":[{"food":"white rice, cooked","grams":450,"kcal":585,"confidence":"med"},{"food":"chicken curry","grams":250,"kcal":357,"confidence":"low"}]}
            """#
        ))
        XCTAssertEqual(event, .mealLogged(CoachMealReceipt(
            id: "evt-1", name: "White rice, cooked and chicken curry", kcal: 942, p: 31, c: 154, f: 20,
            items: [
                CoachMealReceiptItem(food: "white rice, cooked", grams: 450, kcal: 585, confidence: "med"),
                CoachMealReceiptItem(food: "chicken curry", grams: 250, kcal: 357, confidence: "low"),
            ]
        )))
    }

    /// `items` absent (a flat/legacy/barcode log, or an older backend) must
    /// decode to `nil`, not fail or default to an empty array that would read
    /// as "zero items" — see `CoachMealReceipt.items`'s doc comment.
    func testMealLoggedEventWithoutItemsDecodesItemsToNil() throws {
        let event = try XCTUnwrap(APIClient.decodeCoachSSELine(
            #"data: {"type":"meal_logged","id":"evt-123","name":"Two eggs and toast","kcal":340,"p":18,"c":28,"f":16}"#
        ))
        guard case .mealLogged(let receipt) = event else { return XCTFail("expected .mealLogged") }
        XCTAssertNil(receipt.items)
    }

    func testMealUnloggedEventDecodesIntoMealUnloggedCase() throws {
        let event = try XCTUnwrap(APIClient.decodeCoachSSELine(
            #"data: {"type":"meal_unlogged","id":"evt-123"}"#
        ))
        XCTAssertEqual(event, .mealUnlogged(id: "evt-123"))
    }

    func testMealUnloggedEventMissingIdDecodesToNil() throws {
        let event = try APIClient.decodeCoachSSELine(#"data: {"type":"meal_unlogged"}"#)
        XCTAssertNil(event)
    }

    // MARK: - Restoration: decoding `mealReceipts`

    func testRestoredMessageDecodesPresentMealReceipts() throws {
        let json = Data(#"""
        {
          "messages": [{
            "id": "20000000-0000-4000-8000-000000000001",
            "role": "assistant", "speaker": "coach", "content": "Logged it!",
            "timestamp": "2026-07-11T12:05:00.000Z",
            "specialistSessionId": null, "specialistMetadata": null,
            "mealReceipts": [{"id": "evt-1", "name": "Oats", "kcal": 210, "p": 8, "c": 32, "f": 5}]
          }],
          "activePersona": {"id": "vital", "title": "Vital Coach", "subtitle": "Your personal coach", "accent": "#7C6CF2", "icon": "sparkles", "sessionId": null},
          "pendingCard": null
        }
        """#.utf8)
        let restoration = try APIClient.decodeCoachRestoration(json)
        XCTAssertEqual(restoration.messages.first?.mealReceipts, [
            CoachMealReceipt(id: "evt-1", name: "Oats", kcal: 210, p: 8, c: 32, f: 5),
        ])
    }

    func testRestoredMessageWithoutMealReceiptsDecodesToNil() throws {
        let json = Data(#"""
        {
          "messages": [{
            "id": "20000000-0000-4000-8000-000000000001",
            "role": "assistant", "speaker": "coach", "content": "Sure thing.",
            "timestamp": "2026-07-11T12:05:00.000Z",
            "specialistSessionId": null, "specialistMetadata": null
          }],
          "activePersona": {"id": "vital", "title": "Vital Coach", "subtitle": "Your personal coach", "accent": "#7C6CF2", "icon": "sparkles", "sessionId": null},
          "pendingCard": null
        }
        """#.utf8)
        let restoration = try APIClient.decodeCoachRestoration(json)
        XCTAssertNil(restoration.messages.first?.mealReceipts)
    }

    /// A malformed `mealReceipts` (wrong shape) must not sink the whole
    /// restoration decode — every other field, including `content`, still
    /// comes through, with `mealReceipts` simply dropped to nil.
    func testRestoredMessageWithMalformedMealReceiptsIgnoresThatFieldOnly() throws {
        let json = Data(#"""
        {
          "messages": [{
            "id": "20000000-0000-4000-8000-000000000001",
            "role": "assistant", "speaker": "coach", "content": "Logged it!",
            "timestamp": "2026-07-11T12:05:00.000Z",
            "specialistSessionId": null, "specialistMetadata": null,
            "mealReceipts": "not-an-array"
          }],
          "activePersona": {"id": "vital", "title": "Vital Coach", "subtitle": "Your personal coach", "accent": "#7C6CF2", "icon": "sparkles", "sessionId": null},
          "pendingCard": null
        }
        """#.utf8)
        let restoration = try APIClient.decodeCoachRestoration(json)
        XCTAssertNil(restoration.messages.first?.mealReceipts)
        XCTAssertEqual(restoration.messages.first?.content, "Logged it!")
    }

    /// A restored `mealReceipts` entry that carries `items` (a restored
    /// estimator log) decodes them the same way the live SSE event does.
    func testRestoredMessageDecodesMealReceiptItems() throws {
        let json = Data(#"""
        {
          "messages": [{
            "id": "20000000-0000-4000-8000-000000000001",
            "role": "assistant", "speaker": "coach", "content": "Logged it!",
            "timestamp": "2026-07-11T12:05:00.000Z",
            "specialistSessionId": null, "specialistMetadata": null,
            "mealReceipts": [{
              "id": "evt-1", "name": "Rice and curry", "kcal": 942, "p": 31, "c": 154, "f": 20,
              "items": [{"food": "white rice, cooked", "grams": 450, "kcal": 585, "confidence": "med"}]
            }]
          }],
          "activePersona": {"id": "vital", "title": "Vital Coach", "subtitle": "Your personal coach", "accent": "#7C6CF2", "icon": "sparkles", "sessionId": null},
          "pendingCard": null
        }
        """#.utf8)
        let restoration = try APIClient.decodeCoachRestoration(json)
        XCTAssertEqual(restoration.messages.first?.mealReceipts?.first?.items, [
            CoachMealReceiptItem(food: "white rice, cooked", grams: 450, kcal: 585, confidence: "med"),
        ])
    }

    /// A restored `mealReceipts` entry with no `items` key (a flat log, or an
    /// older backend) decodes `items` to `nil`, same as the live SSE path.
    func testRestoredMessageWithoutMealReceiptItemsDecodesItemsToNil() throws {
        let json = Data(#"""
        {
          "messages": [{
            "id": "20000000-0000-4000-8000-000000000001",
            "role": "assistant", "speaker": "coach", "content": "Logged it!",
            "timestamp": "2026-07-11T12:05:00.000Z",
            "specialistSessionId": null, "specialistMetadata": null,
            "mealReceipts": [{"id": "evt-1", "name": "Oats", "kcal": 210, "p": 8, "c": 32, "f": 5}]
          }],
          "activePersona": {"id": "vital", "title": "Vital Coach", "subtitle": "Your personal coach", "accent": "#7C6CF2", "icon": "sparkles", "sessionId": null},
          "pendingCard": null
        }
        """#.utf8)
        let restoration = try APIClient.decodeCoachRestoration(json)
        XCTAssertNil(restoration.messages.first?.mealReceipts?.first?.items)
    }

    // MARK: - Restoration: synthesizing receipt rows

    func testRestoreConversationSynthesizesAnAssistantTurnWithAnUndoableReceipt() async {
        let message = CoachRestoredMessage(
            id: "20000000-0000-4000-8000-000000000001",
            role: "assistant",
            speaker: "coach",
            content: "Logged it!",
            timestamp: "2026-07-11T12:05:00.000Z",
            specialistSessionId: nil,
            specialistMetadata: nil,
            mealReceipts: [CoachMealReceipt(id: "evt-1", name: "Oats", kcal: 210, p: 8, c: 32, f: 5)]
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [message], activePersona: .vital, pendingCard: nil
        ))
        let viewModel = CoachViewModel(api: api)

        await viewModel.restoreConversation()

        guard case .assistantTurn(let turn) = viewModel.rows.first else {
            return XCTFail("expected a restored assistantTurn carrying the meal receipt")
        }
        XCTAssertEqual(turn.visibleText, "Logged it!")
        XCTAssertEqual(turn.mealReceipts.map(\.id), ["evt-1"])
        XCTAssertEqual(turn.mealReceipts.first?.canUndo, true)

        // Undo on a restored receipt works exactly as it does live.
        viewModel.undoMealLog(id: "evt-1")
        await waitUntil(viewModel) { Self.cardState(for: "evt-1", in: viewModel) == .undone }
        XCTAssertEqual(api.deletedMealLogIds, ["evt-1"])
    }

    /// A restored assistant message with no meals in its turn window stays a
    /// plain prose bubble — unchanged from before this feature.
    func testRestoreConversationWithNoMealReceiptsStaysAPlainMessageRow() async {
        let message = CoachRestoredMessage(
            id: "20000000-0000-4000-8000-000000000001",
            role: "assistant",
            speaker: "coach",
            content: "Sure thing.",
            timestamp: "2026-07-11T12:05:00.000Z",
            specialistSessionId: nil,
            specialistMetadata: nil
        )
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [message], activePersona: .vital, pendingCard: nil
        ))
        let viewModel = CoachViewModel(api: api)

        await viewModel.restoreConversation()

        guard case .message(let restored) = viewModel.rows.first else {
            return XCTFail("expected a plain message row")
        }
        XCTAssertEqual(restored.text, "Sure thing.")
    }

    // MARK: - Live SSE turn: meal_unlogged flips a receipt to Removed

    func testMealUnloggedEventFlipsTheMatchingReceiptToRemoved() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: nil
        ))
        let viewModel = CoachViewModel(api: api)
        seedMealReceipt(id: "evt-1", into: viewModel)
        XCTAssertEqual(Self.cardState(for: "evt-1", in: viewModel), .normal)

        api.nextMessageEvents = [.mealUnlogged(id: "evt-1"), .text("Removed it."), .done]
        viewModel.input = "undo that"
        viewModel.send()

        await waitUntil(viewModel) { Self.cardState(for: "evt-1", in: viewModel) == .undone }
    }

    // MARK: - AssistantTurn: receipt insertion

    func testApplyMealReceiptInsertsOnceAndIgnoresADuplicateId() {
        var turn = AssistantTurn(id: UUID())
        let receipt = MealReceiptRow(
            id: "evt-1", name: "Chicken bowl", kcal: 520, protein: 40, carbs: 45, fat: 15,
            timestamp: "2:14 PM"
        )
        turn.applyMealReceipt(receipt)
        turn.applyMealReceipt(receipt) // duplicate id — must not double-insert

        XCTAssertEqual(turn.mealReceipts.map(\.id), ["evt-1"])
        XCTAssertEqual(turn.mealReceipts.first?.cardState, .normal)
    }

    // MARK: - Receipt state machine: logged → undoing → removed

    func testUndoMealLogTransitionsLoggedToUndoingToRemovedOnSuccess() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: nil
        ))
        let viewModel = CoachViewModel(api: api)
        seedMealReceipt(id: "evt-1", into: viewModel)

        XCTAssertEqual(Self.cardState(for: "evt-1", in: viewModel), .normal)

        viewModel.undoMealLog(id: "evt-1")
        // undoMealLog sets `.undoing` synchronously before hopping into the
        // Task that awaits the network call, so this is observable
        // immediately — no wait needed.
        XCTAssertEqual(Self.cardState(for: "evt-1", in: viewModel), .undoing)

        await waitUntil(viewModel) { Self.cardState(for: "evt-1", in: viewModel) == .undone }

        XCTAssertEqual(api.deletedMealLogIds, ["evt-1"])
    }

    // MARK: - Receipt state machine: logged → undoing → error (retryable)

    func testUndoMealLogSurfacesAnInlineErrorAndKeepsTheCardActionableOnFailure() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: nil
        ))
        api.deleteMealLogFailure = APIError.serverError(500)
        let viewModel = CoachViewModel(api: api)
        seedMealReceipt(id: "evt-1", into: viewModel)

        viewModel.undoMealLog(id: "evt-1")
        await waitUntil(viewModel) {
            if case .undoFailed = Self.cardState(for: "evt-1", in: viewModel) { return true }
            return false
        }

        guard case .undoFailed(let message) = Self.cardState(for: "evt-1", in: viewModel) else {
            return XCTFail("expected .undoFailed after a failed delete")
        }
        XCTAssertFalse(message.isEmpty)

        // The card must stay actionable for a retry — this is the "keeps the
        // card" half of the brief's "shows an inline error and keeps the
        // card" requirement.
        guard case .assistantTurn(let turn) = viewModel.rows.first(where: { row in
            if case .assistantTurn(let t) = row { return t.mealReceipts.contains { $0.id == "evt-1" } }
            return false
        }) else {
            return XCTFail("expected the seeded turn to still be present")
        }
        XCTAssertEqual(turn.mealReceipts.first?.canUndo, true)

        // Retrying (Undo tapped again) must be able to succeed once the
        // transient failure clears.
        api.deleteMealLogFailure = nil
        viewModel.undoMealLog(id: "evt-1")
        await waitUntil(viewModel) { Self.cardState(for: "evt-1", in: viewModel) == .undone }
        XCTAssertEqual(api.deletedMealLogIds, ["evt-1", "evt-1"])
    }

    /// Undo on an id that isn't in any turn (e.g. a stale tap after the row
    /// somehow disappeared) must be a silent no-op, never a crash.
    func testUndoMealLogForAnUnknownIdIsANoOp() {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: nil
        ))
        let viewModel = CoachViewModel(api: api)
        viewModel.undoMealLog(id: "does-not-exist")
        XCTAssertEqual(api.deletedMealLogIds, [])
    }

    // MARK: - Live SSE turn: meal_logged inserts a receipt into the stream's turn

    func testSendingAMessageThatLogsAMealInsertsAReceiptIntoTheAssistantTurn() async {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: nil
        ))
        api.nextMessageEvents = [
            .mealLogged(CoachMealReceipt(id: "evt-42", name: "Two eggs and toast", kcal: 340, p: 18, c: 28, f: 16)),
            .text("Logged it!"),
            .done,
        ]
        let viewModel = CoachViewModel(api: api)
        viewModel.input = "I had two eggs and toast"
        viewModel.send()

        await waitUntil(viewModel) { !viewModel.isStreaming }

        let receipts = viewModel.rows.compactMap { row -> [MealReceiptRow]? in
            if case .assistantTurn(let turn) = row { return turn.mealReceipts }
            return nil
        }.flatMap { $0 }
        XCTAssertEqual(receipts.map(\.id), ["evt-42"])
        XCTAssertEqual(receipts.first?.detail, "340 kcal · 18P 28C 16F")
    }

    // MARK: - Helpers

    /// Seeds `viewModel.rows` with a finished `AssistantTurn` carrying one
    /// `.normal` meal receipt — `rows` is plain internal state (not
    /// `private`), so this reaches it directly rather than replaying a whole
    /// SSE turn just to get a receipt on screen.
    private func seedMealReceipt(id: String, into viewModel: CoachViewModel) {
        var turn = AssistantTurn(id: UUID())
        turn.applyMealReceipt(MealReceiptRow(
            id: id, name: "Chicken bowl", kcal: 520, protein: 40, carbs: 45, fat: 15,
            timestamp: "2:14 PM"
        ))
        turn.finish()
        viewModel.rows = [.assistantTurn(turn)]
    }

    // `static` (not an instance method) so calling it from inside the
    // `waitUntil` closures below never implicitly captures `self` — it only
    // needs `viewModel`, which those closures already capture explicitly.
    private static func cardState(for id: String, in viewModel: CoachViewModel) -> LogReceiptCard.State? {
        for row in viewModel.rows {
            if case .assistantTurn(let turn) = row, let receipt = turn.mealReceipts.first(where: { $0.id == id }) {
                return receipt.cardState
            }
        }
        return nil
    }

    private func waitUntil(
        _ viewModel: CoachViewModel,
        timeout: TimeInterval = 10,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ predicate: @escaping @MainActor () -> Bool
    ) async {
        if predicate() { return }
        let satisfied = expectation(description: "predicate holds")
        satisfied.assertForOverFulfill = false
        let cancellable = viewModel.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { _ in
                MainActor.assumeIsolated {
                    if predicate() { satisfied.fulfill() }
                }
            }
        defer { cancellable.cancel() }
        await fulfillment(of: [satisfied], timeout: timeout)
        if !predicate() {
            XCTFail("condition never became true", file: file, line: line)
        }
    }
}
