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

    // MARK: - typed entry

    func testParseRepsClampsAndRejectsGarbage() {
        XCTAssertEqual(LiftLoggerLogic.parseReps("8"), 8)
        XCTAssertEqual(LiftLoggerLogic.parseReps(" 12 "), 12)
        XCTAssertEqual(LiftLoggerLogic.parseReps("0"), 1)
        XCTAssertEqual(LiftLoggerLogic.parseReps("500"), 100)
        XCTAssertNil(LiftLoggerLogic.parseReps(""))
        XCTAssertNil(LiftLoggerLogic.parseReps("8.5"))
        XCTAssertNil(LiftLoggerLogic.parseReps("abc"))
    }

    func testParseLoadHandlesCommaDecimalsClampsAndIsUnitAware() {
        XCTAssertEqual(LiftLoggerLogic.parseLoad("142.5", system: .metric), 142.5)
        XCTAssertEqual(LiftLoggerLogic.parseLoad("142,5", system: .metric), 142.5)
        XCTAssertEqual(LiftLoggerLogic.parseLoad("-5", system: .metric), 0)
        XCTAssertEqual(LiftLoggerLogic.parseLoad("5000", system: .metric), 1000)
        XCTAssertEqual(LiftLoggerLogic.parseLoad("1500", system: .imperial), 1500)
        XCTAssertEqual(LiftLoggerLogic.parseLoad("5000", system: .imperial), 2200)
        XCTAssertEqual(LiftLoggerLogic.parseLoad("102.456", system: .metric), 102.46)
        XCTAssertNil(LiftLoggerLogic.parseLoad("", system: .metric))
        XCTAssertNil(LiftLoggerLogic.parseLoad("x", system: .metric))
        XCTAssertNil(LiftLoggerLogic.parseLoad("inf", system: .metric))
    }

    func testEditTextAndNumberText() {
        XCTAssertEqual(LiftLoggerLogic.numberText(140), "140")
        XCTAssertEqual(LiftLoggerLogic.numberText(142.5), "142.5")
        XCTAssertEqual(LiftLoggerLogic.numberText(2.25), "2.25")
        XCTAssertEqual(LiftLoggerLogic.editText(forLoad: 0), "")
        XCTAssertEqual(LiftLoggerLogic.editText(forLoad: 60), "60")
    }

    // MARK: - RPE

    func testRPEOptionsAndClamping() {
        XCTAssertEqual(LiftLoggerLogic.rpeOptions.first, 6)
        XCTAssertEqual(LiftLoggerLogic.rpeOptions.last, 10)
        XCTAssertEqual(LiftLoggerLogic.rpeOptions.count, 9)
        XCTAssertEqual(LiftLoggerLogic.clampRPE(8.3), 8.5)
        XCTAssertEqual(LiftLoggerLogic.clampRPE(3), 6)
        XCTAssertEqual(LiftLoggerLogic.clampRPE(12), 10)
        XCTAssertNil(LiftLoggerLogic.clampRPE(nil))
        XCTAssertEqual(LiftLoggerLogic.rpeText(8.5), "8.5")
        XCTAssertEqual(LiftLoggerLogic.rpeText(nil), "—")
    }

    func testInputsCarryWarmupAndRPE() {
        let drafts = [LiftDraftExercise(key: "squat", name: "Squat", sets: [
            LiftDraftSet(reps: 5, load: 60, isWarmup: true),
            LiftDraftSet(reps: 5, load: 140, rpe: 8.5),
        ])]
        let inputs = LiftLoggerLogic.inputs(from: drafts, system: .metric)
        XCTAssertEqual(inputs.map { $0.isWarmup }, [true, false])
        XCTAssertEqual(inputs.map { $0.rpe }, [nil, 8.5])
    }

    // MARK: - seeding / hints

    private func rawDTO(_ exercise: String, _ index: Int, reps: Int, kg: Double?, warmup: Bool = false) -> WorkoutSetDTO {
        WorkoutSetDTO(
            id: "\(exercise)-\(index)", sessionId: "s", workoutId: nil, performedAt: "2026-10-01T10:00:00.000Z",
            localDay: "2026-10-01", exercise: exercise, exerciseDisplay: exercise.capitalized, setIndex: index,
            reps: reps, loadKg: kg, rpe: nil, isWarmup: warmup, source: "manual"
        )
    }

    func testHistoryKeepsOnlyThisExercisesWorkingSetsInOrder() {
        let sets = [
            rawDTO("bench press", 4, reps: 5, kg: 80),
            rawDTO("squat", 3, reps: 6, kg: 105),
            rawDTO("squat", 1, reps: 5, kg: 60, warmup: true),
            rawDTO("squat", 2, reps: 8, kg: 100),
        ]
        let history = LiftLoggerLogic.history(forKey: "squat", from: sets, system: .metric)
        XCTAssertEqual(history, [LiftLastRef(reps: 8, load: 100), LiftLastRef(reps: 6, load: 105)])
    }

    func testHistoryConvertsToPounds() {
        let history = LiftLoggerLogic.history(forKey: "squat", from: [rawDTO("squat", 1, reps: 5, kg: 100)], system: .imperial)
        XCTAssertEqual(history.first?.load, 220.5)
    }

    func testSeededSetsFromHistoryOrBlank() {
        let seeded = LiftLoggerLogic.seededSets(from: [LiftLastRef(reps: 8, load: 100), LiftLastRef(reps: 6, load: 105)])
        XCTAssertEqual(seeded.map { $0.reps }, [8, 6])
        XCTAssertEqual(seeded.map { $0.last }, [LiftLastRef(reps: 8, load: 100), LiftLastRef(reps: 6, load: 105)])

        let blank = LiftLoggerLogic.seededSets(from: [])
        XCTAssertEqual(blank.count, 1)
        XCTAssertEqual(blank[0].reps, 5)
        XCTAssertEqual(blank[0].load, 0)
        XCTAssertNil(blank[0].last)
    }

    func testHintText() {
        XCTAssertEqual(LiftLoggerLogic.hintText(LiftLastRef(reps: 8, load: 185)), "last: 185×8")
        XCTAssertEqual(LiftLoggerLogic.hintText(LiftLastRef(reps: 10, load: 62.5)), "last: 62.5×10")
        XCTAssertEqual(LiftLoggerLogic.hintText(LiftLastRef(reps: 12, load: 0)), "last: BW×12")
    }

    // MARK: - recent sessions

    private func session(_ id: String, day: String, names: [String]) -> RecentSessionDTO {
        RecentSessionDTO(
            sessionId: id, performedAt: "\(day)T10:00:00.000Z", localDay: day,
            exercises: names.map {
                RecentSessionExerciseDTO(
                    exercise: $0.lowercased(), display: $0, sets: 3,
                    topSet: RecentSessionTopSetDTO(reps: 5, loadKg: 100), setDetails: nil
                )
            }
        )
    }

    func testSessionTitleUsesWeekdayAndAtMostThreeNames() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let today = calendar.date(from: DateComponents(year: 2026, month: 10, day: 7))!
        // 2026-10-05 is a Monday.
        let long = session("a", day: "2026-10-05", names: ["Bench", "OHP", "Dips", "Fly"])
        XCTAssertEqual(LiftLoggerLogic.sessionTitle(long, today: today, calendar: calendar), "Mon · Bench, OHP, Dips, …")
        let short = session("b", day: "2026-10-06", names: ["Row"])
        XCTAssertEqual(LiftLoggerLogic.sessionTitle(short, today: today, calendar: calendar), "Yesterday · Row")
        let same = session("c", day: "2026-10-07", names: ["Squat", "RDL"])
        XCTAssertEqual(LiftLoggerLogic.sessionTitle(same, today: today, calendar: calendar), "Today · Squat, RDL")
    }

    func testDraftsFromSessionFallBackToTopSetCopies() {
        let drafts = LiftLoggerLogic.drafts(from: session("a", day: "2026-10-05", names: ["Squat"]), system: .metric)
        XCTAssertEqual(drafts.count, 1)
        XCTAssertEqual(drafts[0].sets.count, 3)
        XCTAssertEqual(drafts[0].sets[0].load, 100)
        XCTAssertEqual(drafts[0].key, "squat")
    }

    // MARK: - autocomplete

    func testCompletionsPrefixFirstThenSubstringExcludingUsed() {
        let options = [
            LiftExerciseOption(key: "bench press", display: "Bench press"),
            LiftExerciseOption(key: "incline bench press", display: "Incline bench press"),
            LiftExerciseOption(key: "squat", display: "Squat"),
            LiftExerciseOption(key: "barbell row", display: "Barbell row"),
        ]
        let result = LiftLoggerLogic.completions(for: "Bench", in: options, excluding: [])
        XCTAssertEqual(result.map { $0.key }, ["bench press", "incline bench press"])
        let excluded = LiftLoggerLogic.completions(for: "bench", in: options, excluding: ["bench press"])
        XCTAssertEqual(excluded.map { $0.key }, ["incline bench press"])
        XCTAssertTrue(LiftLoggerLogic.completions(for: "  ", in: options, excluding: []).isEmpty)
    }

    func testDateLabel() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let today = calendar.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: 12))!
        XCTAssertEqual(LiftLoggerLogic.dateLabel(today, today: today, calendar: calendar), "Today")
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        XCTAssertEqual(LiftLoggerLogic.dateLabel(yesterday, today: today, calendar: calendar), "Yesterday")
        let older = calendar.date(byAdding: .day, value: -3, to: today)!
        XCTAssertEqual(LiftLoggerLogic.dateLabel(older, today: today, calendar: calendar), "Sun, Oct 4")
    }
}
