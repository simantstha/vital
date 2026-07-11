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

    func testToolBackedAssistantTurnBuffersTextUntilAllToolsFinish() {
        var turn = AssistantTurn(id: UUID())

        turn.applyToolCall(id: "workouts", name: "get_workouts", label: "Pulling up your workouts…", done: false)
        turn.appendText("I found your recent run data.")

        XCTAssertEqual(turn.visibleText, "")
        XCTAssertEqual(turn.statusSummary, "Pulling up your workouts…")

        turn.applyToolCall(id: "workouts", name: "get_workouts", label: "Pulling up your workouts…", done: true)

        XCTAssertEqual(turn.visibleText, "I found your recent run data.")
        XCTAssertEqual(turn.statusSummary, "Pulled up workouts")
        XCTAssertFalse(turn.isChecking)
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
}
