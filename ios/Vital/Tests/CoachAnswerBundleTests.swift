import XCTest
@testable import Vital

@MainActor
final class CoachAnswerBundleTests: XCTestCase {
    func testToolBackedAssistantTurnOrdersCardsBeforeAnswerAndHidesCompletedStatus() {
        var turn = AssistantTurn(id: UUID())

        turn.applyToolCall(id: "hrv", name: "get_metric_trend", label: "Checking your HRV trend…", done: false)
        turn.appendText("## Carb Loading\nStart tonight.")
        turn.applyToolData(id: "hrv", viz: CoachViz(
            kind: "trend",
            title: "HRV · last 8 days",
            unit: "ms",
            points: [CoachVizPoint(label: "F", value: 79)],
            mean: 79,
            baseline: 81,
            deltaPct: -3,
            meanMinutes: nil,
            consistency: nil,
            currentMean: nil,
            previousMean: nil,
            delta: nil
        ))
        turn.applyToolCall(id: "hrv", name: "get_metric_trend", label: "Checking your HRV trend…", done: true)
        turn.finish()

        XCTAssertEqual(turn.dataCards.map(\.id), ["hrv"])
        XCTAssertEqual(turn.visibleText, "## Carb Loading\nStart tonight.")
        XCTAssertEqual(turn.statusSummary, "Checked HRV trend")
        XCTAssertFalse(turn.isChecking)
    }

    /// Text must never disappear: even while a mid-turn tool call is still in
    /// flight, prose that has already streamed in stays visible — only the
    /// transient status chip reflects the in-flight work.
    func testAssistantTurnKeepsTextVisibleWhileToolCallIsInFlight() {
        var turn = AssistantTurn(id: UUID())

        turn.applyToolCall(id: "workouts", name: "get_workouts", label: "Pulling up your workouts…", done: false)
        turn.appendText("I found your recent run data.")

        XCTAssertEqual(turn.visibleText, "I found your recent run data.")
        XCTAssertEqual(turn.statusSummary, "Pulling up your workouts…")

        turn.applyToolCall(id: "workouts", name: "get_workouts", label: "Pulling up your workouts…", done: true)

        XCTAssertEqual(turn.visibleText, "I found your recent run data.")
        XCTAssertEqual(turn.statusSummary, "Pulled up workouts")
        XCTAssertFalse(turn.isChecking)
    }

    /// Regression guard for the reveal buffer's flush path: whether text
    /// arrives as one delta or many small ones, the concatenated result must
    /// be complete — a flush (stream end, error, or `stopGenerating()`) must
    /// never truncate the last characters that hadn't been revealed yet.
    func testAppendTextAcrossMultipleDeltasNeverTruncates() {
        var turn = AssistantTurn(id: UUID())
        let chunks = ["Hel", "lo, ", "this is ", "a full ", "reply."]

        for chunk in chunks {
            turn.appendText(chunk)
        }
        turn.finish()

        XCTAssertEqual(turn.visibleText, chunks.joined())
        XCTAssertTrue(turn.isFinished)
    }

    func testAssistantTurnCombinesCompletedToolCallsIntoOneCompactSummary() {
        var turn = AssistantTurn(id: UUID())

        turn.applyToolCall(id: "workouts", name: "get_workouts", label: "Pulling up your workouts…", done: false)
        turn.applyToolCall(id: "hrv", name: "get_metric_trend", label: "Checking your HRV trend…", done: false)
        turn.applyToolCall(id: "workouts", name: "get_workouts", label: "Pulling up your workouts…", done: true)
        turn.applyToolCall(id: "hrv", name: "get_metric_trend", label: "Checking your HRV trend…", done: true)

        XCTAssertEqual(turn.statusSummary, "Checked workouts, HRV trend")
        XCTAssertFalse(turn.isChecking)
    }

    /// Regression guard for the phantom-empty-turn bug: `stopGenerating()`
    /// used to unconditionally call `finishTurn`, which goes through
    /// `mutateTurn`'s no-row branch and *creates* an `AssistantTurn` if one
    /// doesn't exist yet. Tapping stop during the thinking phase — before any
    /// `.text` delta had arrived, so no assistant row existed — appended an
    /// empty turn that rendered nothing but left a permanent stray gap in the
    /// transcript. `stopGenerating()` must only finish a turn whose row
    /// already exists.
    ///
    /// `send()` kicks off its network work in a detached `Task`, which Swift
    /// Concurrency does not schedule until the current task suspends. Calling
    /// `stopGenerating()` immediately after `send()`, with no `await` in
    /// between, deterministically catches the view model in the
    /// "thinking phase" (`isStreaming == true`, no assistant row yet) without
    /// needing `FakeCoachAPI`'s stream to hang mid-delivery.
    func testStopGeneratingBeforeAnyTextDeltaDoesNotAppendAPhantomAssistantTurn() {
        let api = FakeCoachAPI(restoration: CoachRestorationResponse(
            messages: [], activePersona: .vital, pendingCard: nil
        ))
        api.nextMessageEvents = [.text("Hello"), .done]
        let viewModel = CoachViewModel(api: api)

        viewModel.input = "Hi"
        viewModel.send()
        viewModel.stopGenerating()

        XCTAssertFalse(viewModel.rows.contains { row in
            if case .assistantTurn = row { return true }
            return false
        }, "stopGenerating() before any text delta must not append an AssistantTurn row")
        XCTAssertTrue(viewModel.rows.contains { row in
            if case .message(let message) = row { return message.role == .user }
            return false
        })
    }
}
