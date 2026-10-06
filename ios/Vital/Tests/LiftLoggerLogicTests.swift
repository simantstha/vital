import XCTest
@testable import Vital

final class LiftLoggerLogicTests: XCTestCase {

    private func dto(
        _ exercise: String,
        display: String? = nil,
        index: Int,
        reps: Int = 5,
        loadKg: Double? = 100,
        warmup: Bool = false
    ) -> WorkoutSetDTO {
        WorkoutSetDTO(
            id: "id-\(exercise)-\(index)",
            sessionId: "session-1",
            workoutId: nil,
            performedAt: "2026-10-05T10:00:00.000Z",
            localDay: "2026-10-05",
            exercise: exercise,
            exerciseDisplay: display ?? exercise.capitalized,
            setIndex: index,
            reps: reps,
            loadKg: loadKg,
            rpe: nil,
            isWarmup: warmup,
            source: "manual"
        )
    }

    // MARK: - Steps / conversion

    func testLoadStepIsTwoPointFiveKgOrFiveLb() {
        XCTAssertEqual(LiftLoggerLogic.loadStep(for: .metric), 2.5)
        XCTAssertEqual(LiftLoggerLogic.loadStep(for: .imperial), 5)
    }

    func testDisplayLoadRoundsToHalfUnitsAndTreatsBodyweightAsZero() {
        XCTAssertEqual(LiftLoggerLogic.displayLoad(fromKg: 142.5, system: .metric), 142.5)
        XCTAssertEqual(LiftLoggerLogic.displayLoad(fromKg: 100, system: .imperial), 220.5) // 220.46 lb
        XCTAssertEqual(LiftLoggerLogic.displayLoad(fromKg: nil, system: .metric), 0)
        XCTAssertEqual(LiftLoggerLogic.displayLoad(fromKg: 0, system: .imperial), 0)
    }

    func testKgFromDisplayLoadConvertsPoundsAndOmitsBodyweight() throws {
        XCTAssertEqual(LiftLoggerLogic.kg(fromDisplayLoad: 100, system: .metric), 100)
        let kg = try XCTUnwrap(LiftLoggerLogic.kg(fromDisplayLoad: 225, system: .imperial))
        XCTAssertEqual(kg, 102.06, accuracy: 0.01)
        XCTAssertNil(LiftLoggerLogic.kg(fromDisplayLoad: 0, system: .metric))
    }

    func testLoadText() {
        XCTAssertEqual(LiftLoggerLogic.loadText(140, system: .metric), "140 kg")
        XCTAssertEqual(LiftLoggerLogic.loadText(92.5, system: .metric), "92.5 kg")
        XCTAssertEqual(LiftLoggerLogic.loadText(225, system: .imperial), "225 lb")
        XCTAssertEqual(LiftLoggerLogic.loadText(0, system: .metric), "Bodyweight")
    }

    func testCanonicalKeyTrimsLowercasesAndCollapsesWhitespace() {
        XCTAssertEqual(LiftLoggerLogic.canonicalKey(from: "  Bench   Press "), "bench press")
        XCTAssertEqual(LiftLoggerLogic.canonicalKey(from: "   "), "")
    }

    // MARK: - drafts(from:)

    func testDraftsGroupByExerciseInFirstAppearanceOrderAndSortSetsByIndex() {
        let drafts = LiftLoggerLogic.drafts(
            from: [
                dto("bench press", display: "Bench press", index: 6, loadKg: 92.5),
                dto("bench press", display: "Bench press", index: 5, loadKg: 90),
                dto("squat", display: "Squat", index: 1, loadKg: 60, warmup: true),
                dto("squat", display: "Squat", index: 2, loadKg: 140),
            ],
            system: .metric
        )
        XCTAssertEqual(drafts.map(\.key), ["bench press", "squat"])
        XCTAssertEqual(drafts.map(\.name), ["Bench press", "Squat"])
        XCTAssertEqual(drafts[0].sets.map(\.load), [90, 92.5])
        XCTAssertEqual(drafts[1].sets.map(\.isWarmup), [true, false])
    }

    func testDraftsPreserveBodyweightAsZeroLoadAndClampReps() {
        let drafts = LiftLoggerLogic.drafts(
            from: [dto("pull up", index: 1, reps: 400, loadKg: nil)],
            system: .metric
        )
        XCTAssertEqual(drafts.first?.sets.first?.load, 0)
        XCTAssertEqual(drafts.first?.sets.first?.reps, LiftLoggerLogic.maxReps)
    }

    func testDraftsFromNoSetsIsEmpty() {
        XCTAssertTrue(LiftLoggerLogic.drafts(from: [], system: .metric).isEmpty)
    }

    // MARK: - seedExercise

    private func stat(_ week: String, sets: Int) -> WorkoutWeeklyStatDTO {
        WorkoutWeeklyStatDTO(weekStart: week, bestEstimatedOneRepMaxKg: 100, volumeKg: 1000, totalSets: sets, totalReps: sets * 5)
    }

    func testSeedExercisePicksTheMostRecentWeekThenMostSetsThenAlphabetical() {
        let summary = WorkoutSummaryResponse(days: 84, exercises: [
            "squat": [stat("2026-09-28", sets: 3), stat("2026-10-05", sets: 3)],
            "bench press": [stat("2026-10-05", sets: 4)],
            "deadlift": [stat("2026-09-21", sets: 9)],
        ])
        XCTAssertEqual(LiftLoggerLogic.seedExercise(from: summary), "bench press")

        let tied = WorkoutSummaryResponse(days: 84, exercises: [
            "squat": [stat("2026-10-05", sets: 3)],
            "bench press": [stat("2026-10-05", sets: 3)],
        ])
        XCTAssertEqual(LiftLoggerLogic.seedExercise(from: tied), "bench press")
    }

    func testSeedExerciseIsNilForAnEmptySummary() {
        XCTAssertNil(LiftLoggerLogic.seedExercise(from: WorkoutSummaryResponse(days: 84, exercises: [:])))
    }

    // MARK: - inputs(from:)

    func testInputsNumberSetsAcrossTheWholeSessionAndConvertToKg() {
        let drafts = [
            LiftDraftExercise(key: "bench press", name: "Bench press", sets: [
                LiftDraftSet(reps: 5, load: 90), LiftDraftSet(reps: 5, load: 90),
            ]),
            LiftDraftExercise(key: "squat", name: "Squat", sets: [
                LiftDraftSet(reps: 5, load: 60, isWarmup: true), LiftDraftSet(reps: 3, load: 140),
            ]),
        ]
        let inputs = LiftLoggerLogic.inputs(from: drafts, system: .metric)
        XCTAssertEqual(inputs.map(\.setIndex), [1, 2, 3, 4])
        XCTAssertEqual(inputs.map(\.exercise), ["bench press", "bench press", "squat", "squat"])
        XCTAssertEqual(inputs.map(\.exerciseDisplay), ["Bench press", "Bench press", "Squat", "Squat"])
        XCTAssertEqual(inputs.map(\.loadKg), [90, 90, 60, 140])
        XCTAssertEqual(inputs.map(\.isWarmup), [false, false, true, false])
        XCTAssertEqual(inputs.last?.reps, 3)
    }

    func testInputsConvertPoundsToKilograms() {
        let drafts = [LiftDraftExercise(key: "squat", name: "Squat", sets: [LiftDraftSet(reps: 5, load: 225)])]
        let inputs = LiftLoggerLogic.inputs(from: drafts, system: .imperial)
        XCTAssertEqual(inputs.first?.loadKg ?? 0, 102.06, accuracy: 0.01)
    }

    func testInputsSendBodyweightAsNilLoadAndDropInvalidRowsAndNamelessExercises() {
        let drafts = [
            LiftDraftExercise(key: "pull up", name: "Pull up", sets: [LiftDraftSet(reps: 8, load: 0), LiftDraftSet(reps: 0, load: 0)]),
            LiftDraftExercise(key: "", name: "   ", sets: [LiftDraftSet(reps: 5, load: 50)]),
        ]
        let inputs = LiftLoggerLogic.inputs(from: drafts, system: .metric)
        XCTAssertEqual(inputs.count, 1)
        XCTAssertNil(inputs[0].loadKg)
        XCTAssertEqual(inputs[0].reps, 8)
    }

    func testInputsEncodeWithoutNullLoadKeys() throws {
        let input = WorkoutSetInputDTO(exercise: "pull up", exerciseDisplay: "Pull up", setIndex: 1, reps: 8, loadKg: nil, rpe: nil, isWarmup: false)
        let data = try JSONEncoder().encode(input)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["loadKg"])
        XCTAssertNil(json["rpe"])
        XCTAssertEqual(json["reps"] as? Int, 8)
    }

    // MARK: - source

    func testSourceIsTemplateOnlyForAnUneditedSeed() {
        let seeded = [LiftDraftExercise(key: "squat", name: "Squat", sets: [LiftDraftSet(reps: 5, load: 140)])]
        XCTAssertEqual(LiftLoggerLogic.source(drafts: seeded, seeded: seeded), "template")

        var edited = seeded
        edited[0].sets[0].reps = 6
        XCTAssertEqual(LiftLoggerLogic.source(drafts: edited, seeded: seeded), "manual")

        XCTAssertEqual(LiftLoggerLogic.source(drafts: seeded, seeded: []), "manual")
    }

    // MARK: - summaryLine

    func testSummaryLineUsesTheHeaviestWorkingSet() {
        let exercise = LiftDraftExercise(key: "squat", name: "Squat", sets: [
            LiftDraftSet(reps: 5, load: 60, isWarmup: true),
            LiftDraftSet(reps: 5, load: 140),
            LiftDraftSet(reps: 3, load: 150),
        ])
        XCTAssertEqual(LiftLoggerLogic.summaryLine(for: exercise, system: .metric), "2 sets · top 3 × 150 kg")
    }
}
