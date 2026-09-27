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

    // MARK: - Activity fields (chat-activity-contract.md §1/§4)

    /// A `done` tool_call carrying `kind`/`ok`/`summary` lands on the row,
    /// and a memory-write row is excluded from `receiptRows` (K1–K3) but
    /// included in `memoryOpRows` (K4) once it's done.
    func testApplyToolCallCarriesNewFieldsAndSplitsReceiptFromMemoryOps() {
        var turn = AssistantTurn(id: UUID())

        turn.applyToolCall(id: "sleep", name: "get_sleep_summary", label: "Checking your sleep…", done: false, kind: "data")
        turn.applyToolCall(
            id: "sleep", name: "get_sleep_summary", label: "Checking your sleep…", done: true,
            kind: "data", ok: true, summary: "Last 7 nights · avg 5 h 57 m"
        )
        turn.applyToolCall(id: "note", name: "remember_fact", label: "Noting that…", done: false, kind: "memory")
        turn.applyToolCall(
            id: "note", name: "remember_fact", label: "Noted", done: true,
            kind: "memory", ok: true, memory: CoachMemoryOp(op: .saved, text: "Lactose intolerant", factId: "fact-1")
        )

        XCTAssertEqual(turn.toolCalls.first(where: { $0.id == "sleep" })?.summary, "Last 7 nights · avg 5 h 57 m")
        XCTAssertEqual(turn.toolCalls.first(where: { $0.id == "sleep" })?.ok, true)
        XCTAssertEqual(turn.receiptRows.map(\.id), ["sleep"], "a memory-write row must not fold into the receipt")
        XCTAssertEqual(turn.memoryOpRows.map(\.id), ["note"])
    }

    /// Undo on a `saved` chip rewrites just that row's op to `.removed`; it
    /// must never touch an unrelated row (e.g. a `proposed` card still
    /// pending in the same turn).
    func testUpdateMemoryOpRewritesOnlyTheMatchingFactId() {
        var turn = AssistantTurn(id: UUID())
        turn.applyToolCall(id: "a", name: "remember_fact", label: "Noted", done: true, kind: "memory", memory: CoachMemoryOp(op: .saved, text: "Knee pain", factId: "fact-a"))
        turn.applyToolCall(id: "b", name: "propose_fact", label: "Noting", done: true, kind: "memory", memory: CoachMemoryOp(op: .proposed, text: "Lactose intolerant", factId: "fact-b"))

        turn.updateMemoryOp(factId: "fact-a", newOp: .removed)

        XCTAssertEqual(turn.toolCalls.first(where: { $0.id == "a" })?.memory?.op, .removed)
        XCTAssertEqual(turn.toolCalls.first(where: { $0.id == "b" })?.memory?.op, .proposed)
    }

    /// "Not now" removes the proposal row outright rather than re-tagging it.
    func testRemoveMemoryOpDropsOnlyThatRow() {
        var turn = AssistantTurn(id: UUID())
        turn.applyToolCall(id: "a", name: "get_workouts", label: "Checked workouts", done: true, kind: "data")
        turn.applyToolCall(id: "b", name: "propose_fact", label: "Noting", done: true, kind: "memory", memory: CoachMemoryOp(op: .proposed, text: "Lactose intolerant", factId: "fact-b"))

        turn.removeMemoryOp(factId: "fact-b")

        XCTAssertEqual(turn.toolCalls.map(\.id), ["a"])
    }

    /// chat-activity-contract.md §3: a restored turn's `activity` array
    /// rebuilds every row as already done, so the working card never shows
    /// for history.
    func testApplyActivityRebuildsRowsAsDone() {
        var turn = AssistantTurn(id: UUID())
        turn.applyActivity([
            CoachActivityItem(name: "read_memory", label: "Checked your notes", kind: "memory", ok: true, summary: nil, sources: [CoachToolSource(text: "New baby born 2 Sep.")], memory: nil),
            CoachActivityItem(name: "get_sleep_summary", label: "Checked your sleep", kind: "data", ok: true, summary: "Avg 5 h 57 m", sources: nil, memory: nil),
        ])
        turn.finish()

        XCTAssertTrue(turn.toolCalls.allSatisfy(\.isDone))
        XCTAssertEqual(turn.receiptRows.count, 2)
        XCTAssertEqual(CoachActivityLogic.pillSummary(forRows: turn.receiptRows), "Sleep and 1 of your notes")
    }
}
