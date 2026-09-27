import XCTest
@testable import Vital

final class CoachActivityLogicTests: XCTestCase {

    // MARK: - kind → icon

    func testIconPerKindMatchesContractSymbols() {
        XCTAssertEqual(CoachActivityLogic.icon(forKind: "data"), "chart.xyaxis.line")
        XCTAssertEqual(CoachActivityLogic.icon(forKind: "memory"), "doc.text")
        XCTAssertEqual(CoachActivityLogic.icon(forKind: "action"), "checkmark.circle")
        XCTAssertEqual(CoachActivityLogic.icon(forKind: "calendar"), "calendar")
        XCTAssertEqual(CoachActivityLogic.icon(forKind: "other"), "sparkles")
        XCTAssertEqual(CoachActivityLogic.icon(forKind: "unknown-future-kind"), "sparkles")
    }

    func testUsesMemoryTintOnlyForMemoryKind() {
        XCTAssertTrue(CoachActivityLogic.usesMemoryTint("memory"))
        XCTAssertFalse(CoachActivityLogic.usesMemoryTint("data"))
        XCTAssertFalse(CoachActivityLogic.usesMemoryTint("action"))
    }

    // MARK: - kind derivation from tool name (older-backend fallback)

    func testKindDerivationMatchesContractTable() {
        for name in ["read_memory", "write_memory", "append_observation", "query_ontology", "read_entity", "remember_fact", "propose_fact", "confirm_fact", "resolve_fact"] {
            XCTAssertEqual(CoachActivityLogic.kind(forToolName: name), "memory", name)
        }
        for name in ["log_meal", "delete_meal", "log_weight", "log_workout", "update_diet_budget"] {
            XCTAssertEqual(CoachActivityLogic.kind(forToolName: name), "action", name)
        }
        XCTAssertEqual(CoachActivityLogic.kind(forToolName: "get_schedule"), "calendar")
        for name in ["get_metric_trend", "get_weight_trend", "get_sleep_summary", "get_workouts", "get_baseline", "compare_periods", "query_events", "get_training_history", "calculate_macros"] {
            XCTAssertEqual(CoachActivityLogic.kind(forToolName: name), "data", name)
        }
        XCTAssertEqual(CoachActivityLogic.kind(forToolName: "specialist_handoff"), "other")
    }

    // MARK: - working card vs. pill vs. nothing

    func testNoToolCallsShowsNothing() {
        XCTAssertEqual(
            CoachActivityLogic.presentation(hasActivity: false, hasRunningStep: true, oldestRunningStepAge: 1, hasProse: false, isFinished: false),
            .none
        )
    }

    func testRunningStepUnder400msIsGatedOff() {
        XCTAssertEqual(
            CoachActivityLogic.presentation(hasActivity: true, hasRunningStep: true, oldestRunningStepAge: 0.1, hasProse: false, isFinished: false),
            .none
        )
    }

    func testRunningStepAt400msOrMoreShowsWorkingCard() {
        XCTAssertEqual(
            CoachActivityLogic.presentation(hasActivity: true, hasRunningStep: true, oldestRunningStepAge: 0.4, hasProse: false, isFinished: false),
            .workingCard
        )
        XCTAssertEqual(
            CoachActivityLogic.presentation(hasActivity: true, hasRunningStep: true, oldestRunningStepAge: 5, hasProse: false, isFinished: false),
            .workingCard
        )
    }

    func testProseStartingFoldsIntoPillEvenWithARunningStep() {
        XCTAssertEqual(
            CoachActivityLogic.presentation(hasActivity: true, hasRunningStep: true, oldestRunningStepAge: 5, hasProse: true, isFinished: false),
            .pill
        )
    }

    func testFinishedTurnAlwaysShowsPill() {
        XCTAssertEqual(
            CoachActivityLogic.presentation(hasActivity: true, hasRunningStep: false, oldestRunningStepAge: 0, hasProse: false, isFinished: true),
            .pill
        )
    }

    func testCompletedNoLongerRunningWithNoProseYetShowsPill() {
        // Every step is done; nothing is "running" any more, so there's
        // nothing left to gate on — this is exactly the moment the card
        // should fold, even before prose exists.
        XCTAssertEqual(
            CoachActivityLogic.presentation(hasActivity: true, hasRunningStep: false, oldestRunningStepAge: 0, hasProse: false, isFinished: false),
            .pill
        )
    }

    // MARK: - Oxford join

    func testJoinedListHandlesOneTwoAndThreeOrMore() {
        XCTAssertEqual(CoachActivityLogic.joinedList([]), "")
        XCTAssertEqual(CoachActivityLogic.joinedList(["Sleep"]), "Sleep")
        XCTAssertEqual(CoachActivityLogic.joinedList(["Sleep", "HRV"]), "Sleep and HRV")
        XCTAssertEqual(CoachActivityLogic.joinedList(["Sleep", "HRV", "2 of your notes"]), "Sleep, HRV and 2 of your notes")
    }

    // MARK: - noun distillation

    func testNounFromDoneLabelStripsCommonPrefixesAndPossessives() {
        XCTAssertEqual(CoachActivityLogic.noun(fromDoneLabel: "Checked your sleep"), "Sleep")
        XCTAssertEqual(CoachActivityLogic.noun(fromDoneLabel: "Compared HRV with your normal"), "HRV")
        XCTAssertEqual(CoachActivityLogic.noun(fromDoneLabel: "Pulled up your workouts"), "Workouts")
        XCTAssertEqual(CoachActivityLogic.noun(fromDoneLabel: "Read your sleep"), "Sleep")
    }

    // MARK: - Pill summary (the exact contract example, plus edge cases)

    func testPillSummaryMatchesContractExampleForThreeItems() {
        let entries = [
            CoachActivityLogic.PillEntry(kind: "data", label: "Read your sleep"),
            CoachActivityLogic.PillEntry(kind: "data", label: "Compared HRV with your normal"),
            CoachActivityLogic.PillEntry(kind: "memory", label: "Checked your notes", noteCount: 2),
        ]
        XCTAssertEqual(CoachActivityLogic.pillSummary(entries), "Sleep, HRV and 2 of your notes")
    }

    func testPillSummaryHandlesASingleItem() {
        let entries = [CoachActivityLogic.PillEntry(kind: "data", label: "Read your sleep")]
        XCTAssertEqual(CoachActivityLogic.pillSummary(entries), "Sleep")
    }

    func testPillSummaryHandlesTwoItems() {
        let entries = [
            CoachActivityLogic.PillEntry(kind: "data", label: "Read your sleep"),
            CoachActivityLogic.PillEntry(kind: "data", label: "Compared HRV with your normal"),
        ]
        XCTAssertEqual(CoachActivityLogic.pillSummary(entries), "Sleep and HRV")
    }

    func testPillSummaryHandlesAMemoryOnlyTurn() {
        let entries = [CoachActivityLogic.PillEntry(kind: "memory", label: "Checked your notes", noteCount: 3)]
        XCTAssertEqual(CoachActivityLogic.pillSummary(entries), "3 of your notes")
    }

    func testPillSummaryHandlesASingleNote() {
        let entries = [CoachActivityLogic.PillEntry(kind: "memory", label: "Checked your notes", noteCount: 1)]
        XCTAssertEqual(CoachActivityLogic.pillSummary(entries), "1 of your notes")
    }

    func testPillSummaryIsEmptyForNoEntries() {
        XCTAssertEqual(CoachActivityLogic.pillSummary([]), "")
    }

    @MainActor
    func testPillSummaryForRowsSkipsUnfinishedRowsAndFoldsMemoryWrites() {
        var sleep = ToolCallRow(id: "1", name: "get_sleep_summary", label: "Checked your sleep")
        sleep.isDone = true
        sleep.kind = "data"
        var hrv = ToolCallRow(id: "2", name: "get_baseline", label: "Compared HRV with your normal")
        hrv.isDone = true
        hrv.kind = "data"
        var memoryRead = ToolCallRow(id: "3", name: "read_memory", label: "Checked your notes")
        memoryRead.isDone = true
        memoryRead.kind = "memory"
        memoryRead.sources = [CoachToolSource(text: "Note one"), CoachToolSource(text: "Note two")]
        var running = ToolCallRow(id: "4", name: "get_workouts", label: "Pulling up your workouts…")
        running.isDone = false

        let summary = CoachActivityLogic.pillSummary(forRows: [sleep, hrv, memoryRead, running])
        XCTAssertEqual(summary, "Sleep, HRV and 2 of your notes")
    }

    // MARK: - Done-label fallback

    func testDoneLabelFallbackReadsTheToolNameAsWords() {
        XCTAssertEqual(CoachActivityLogic.doneLabelFallback(forToolName: "get_sleep_summary"), "Checked get sleep summary")
        XCTAssertEqual(CoachActivityLogic.doneLabelFallback(forToolName: ""), "Checked that")
    }
}
