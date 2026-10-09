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
        XCTAssertEqual(LiftLoggerLogic.loadText(140, system: .metric), "140\u{00A0}kg")
        XCTAssertEqual(LiftLoggerLogic.loadText(92.5, system: .metric), "92.5\u{00A0}kg")
        XCTAssertEqual(LiftLoggerLogic.loadText(225, system: .imperial), "225\u{00A0}lb")
        XCTAssertEqual(LiftLoggerLogic.loadText(0, system: .metric), "Bodyweight")
    }

    /// The load/progression/summary strings glue every value to its unit with
    /// U+00A0, so a narrow set row wraps between tokens, never "140" / "kg".
    func testNoPlainSpaceBetweenADigitAndAUnit() throws {
        for system in [UnitSystem.metric, .imperial] {
            assertNoBreakableUnitSpace(LiftLoggerLogic.loadText(140, system: system))
            assertNoBreakableUnitSpace(LiftLoggerLogic.loadText(92.5, system: system))
            let uniform = try XCTUnwrap(
                LiftLoggerLogic.progressionHint(history: refs([5, 5, 5], at: 140), key: "squat", system: system)
            )
            let ragged = try XCTUnwrap(
                LiftLoggerLogic.progressionHint(history: refs([5, 5, 4], at: 140), key: "squat", system: system)
            )
            for hint in [uniform, ragged] {
                let text = LiftLoggerLogic.progressionText(hint, system: system)
                assertNoBreakableUnitSpace(text)
                XCTAssertTrue(text.contains("\(LiftLoggerLogic.numberText(hint.lastLoad))\u{00A0}\(system.weightUnit)"), text)
            }
            let exercise = LiftDraftExercise(key: "squat", name: "Squat", sets: [LiftDraftSet(reps: 3, load: 150)])
            assertNoBreakableUnitSpace(LiftLoggerLogic.summaryLine(for: exercise, system: system))
        }
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
        XCTAssertEqual(LiftLoggerLogic.summaryLine(for: exercise, system: .metric), "2 sets · top 3 × 150\u{00A0}kg")
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

    // MARK: - lower-body classifier

    func testIsLowerBodyCompoundMatchesTheCanonicalLowerBodyLifts() {
        for key in ["squat", "deadlift", "romanian deadlift", "leg press", "hip thrust"] {
            XCTAssertTrue(LiftLoggerLogic.isLowerBodyCompound(key: key), key)
        }
        // Variants, odd casing / spacing / hyphens, and the "rdl" abbreviation.
        for key in ["back squat", "front squat", "  Sumo   Deadlift ", "single-leg press", "barbell hip thrust", "rdl"] {
            XCTAssertTrue(LiftLoggerLogic.isLowerBodyCompound(key: key), key)
        }
        for key in ["bench press", "overhead press", "barbell row", "pull-up", "curl", "leg curl", "leg extension", "calf raise", ""] {
            XCTAssertFalse(LiftLoggerLogic.isLowerBodyCompound(key: key), key)
        }
    }

    func testProgressionStepIsBiggerForLowerBodyCompounds() {
        XCTAssertEqual(LiftLoggerLogic.progressionStep(forKey: "squat", system: .metric), 2.5)
        XCTAssertEqual(LiftLoggerLogic.progressionStep(forKey: "bench press", system: .metric), 1.25)
        XCTAssertEqual(LiftLoggerLogic.progressionStep(forKey: "deadlift", system: .imperial), 5)
        XCTAssertEqual(LiftLoggerLogic.progressionStep(forKey: "barbell row", system: .imperial), 2.5)
    }

    func testRoundToPlateUsesHalfKilosAndWholePounds() {
        XCTAssertEqual(LiftLoggerLogic.roundToPlate(141.25, system: .metric), 141.5)
        XCTAssertEqual(LiftLoggerLogic.roundToPlate(142.5, system: .metric), 142.5)
        XCTAssertEqual(LiftLoggerLogic.roundToPlate(137.5, system: .imperial), 138)
        XCTAssertEqual(LiftLoggerLogic.roundToPlate(230, system: .imperial), 230)
    }

    // MARK: - progression hint

    private func refs(_ reps: [Int], at load: Double) -> [LiftLastRef] {
        reps.map { LiftLastRef(reps: $0, load: load) }
    }

    func testHintSuggestsPlusTwoPointFiveKgForALowerBodyCompoundThatHitEverySet() throws {
        let hint = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5, 5, 5], at: 140), key: "squat", system: .metric)
        )
        XCTAssertEqual(hint.lastLoad, 140)
        XCTAssertEqual(hint.lastReps, [5, 5, 5])
        XCTAssertEqual(hint.suggestedLoad, 142.5)
        XCTAssertTrue(hint.isIncrease)
        XCTAssertEqual(LiftLoggerLogic.progressionText(hint, system: .metric), "Last 3×5 @ 140\u{00A0}kg · try 142.5\u{00A0}kg")
    }

    func testHintUsesTheSmallerStepForUpperBodyAndRoundsToHalfKilos() throws {
        let bench = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5, 5, 5], at: 90), key: "bench press", system: .metric)
        )
        XCTAssertEqual(bench.suggestedLoad, 91.5)   // 90 + 1.25 = 91.25 → nearest 0.5
        let press = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([8, 8, 8], at: 57.5), key: "overhead press", system: .metric)
        )
        XCTAssertEqual(press.suggestedLoad, 59)     // 58.75 → 59
        let rdl = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([8, 8, 8], at: 100), key: "romanian deadlift", system: .metric)
        )
        XCTAssertEqual(rdl.suggestedLoad, 102.5)
        let legPress = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([10, 10, 10], at: 180), key: "leg press", system: .metric)
        )
        XCTAssertEqual(legPress.suggestedLoad, 182.5)
    }

    func testHintForPoundUsersUsesFivePoundsLowerBodyAndTwoPointFiveUpperBody() throws {
        let squat = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5, 5, 5], at: 225), key: "squat", system: .imperial)
        )
        XCTAssertEqual(squat.suggestedLoad, 230)
        XCTAssertEqual(LiftLoggerLogic.progressionText(squat, system: .imperial), "Last 3×5 @ 225\u{00A0}lb · try 230\u{00A0}lb")
        let bench = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5, 5, 5], at: 135), key: "bench press", system: .imperial)
        )
        XCTAssertEqual(bench.suggestedLoad, 138)    // 137.5 → whole pounds
    }

    func testHintSaysRepeatWhenAnySetMissedItsReps() throws {
        let hint = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5, 5, 4], at: 140), key: "squat", system: .metric)
        )
        XCTAssertEqual(hint.suggestedLoad, 140)
        XCTAssertFalse(hint.isIncrease)
        XCTAssertEqual(LiftLoggerLogic.progressionText(hint, system: .metric), "Last 5/5/4 @ 140\u{00A0}kg · repeat 140\u{00A0}kg")
    }

    func testHintTreatsAFirstSetThatOutperformedTheRestAsAMiss() throws {
        let hint = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([8, 7, 6], at: 100), key: "bench press", system: .metric)
        )
        XCTAssertFalse(hint.isIncrease)
        XCTAssertEqual(hint.suggestedLoad, 100)
    }

    func testHintJudgesOnlyTheSetsAtTheTopLoad() throws {
        // Ramp: lighter working sets don't count, the top load did hit its reps.
        let ramp = [
            LiftLastRef(reps: 5, load: 100), LiftLastRef(reps: 5, load: 120), LiftLastRef(reps: 5, load: 140),
        ]
        let hint = try XCTUnwrap(LiftLoggerLogic.progressionHint(history: ramp, key: "squat", system: .metric))
        XCTAssertEqual(hint.lastLoad, 140)
        XCTAssertEqual(hint.lastReps, [5])
        XCTAssertEqual(hint.suggestedLoad, 142.5)
        XCTAssertEqual(LiftLoggerLogic.progressionText(hint, system: .metric), "Last 1×5 @ 140\u{00A0}kg · try 142.5\u{00A0}kg")

        // A miss at the top load still means repeat, even if the back-off sets were fine.
        let missed = [
            LiftLastRef(reps: 5, load: 150), LiftLastRef(reps: 3, load: 150), LiftLastRef(reps: 8, load: 120),
        ]
        let repeatHint = try XCTUnwrap(LiftLoggerLogic.progressionHint(history: missed, key: "squat", system: .metric))
        XCTAssertEqual(repeatHint.lastReps, [5, 3])
        XCTAssertFalse(repeatHint.isIncrease)
    }

    func testNoHintWithoutHistoryOrForBodyweightOnlyLifts() {
        XCTAssertNil(LiftLoggerLogic.progressionHint(history: [], key: "squat", system: .metric))
        XCTAssertNil(LiftLoggerLogic.progressionHint(history: refs([8, 8, 8], at: 0), key: "pull-up", system: .metric))
    }

    func testHintNeverSuggestsPastTheMaxLoad() throws {
        let hint = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5], at: 1000), key: "deadlift", system: .metric)
        )
        XCTAssertEqual(hint.suggestedLoad, 1000)
        XCTAssertFalse(hint.isIncrease)
    }

    // MARK: - applying the hint

    func testApplyingTheHintOnlyTouchesUntickedUneditedWorkingSets() throws {
        let hint = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5, 5, 5], at: 140), key: "squat", system: .metric)
        )
        let sets = [
            LiftDraftSet(reps: 5, load: 60, isWarmup: true),
            LiftDraftSet(reps: 5, load: 140, isDone: true),
            LiftDraftSet(reps: 5, load: 145),            // edited by the user
            LiftDraftSet(reps: 5, load: 140),
            LiftDraftSet(reps: 4, load: 140),
        ]
        XCTAssertTrue(LiftLoggerLogic.canApplyProgression(hint, to: sets))

        let updated = LiftLoggerLogic.applyingProgression(hint, to: sets)

        XCTAssertEqual(updated.map { $0.load }, [60, 140, 145, 142.5, 142.5])
        XCTAssertEqual(updated.map { $0.reps }, [5, 5, 5, 5, 4])
        XCTAssertEqual(updated.map { $0.isDone }, [false, true, false, false, false])
        // Applied once → nothing left to apply.
        XCTAssertFalse(LiftLoggerLogic.canApplyProgression(hint, to: updated))
        XCTAssertEqual(LiftLoggerLogic.applyingProgression(hint, to: updated), updated)
    }

    func testARepeatHintIsNeverApplied() throws {
        let hint = try XCTUnwrap(
            LiftLoggerLogic.progressionHint(history: refs([5, 5, 4], at: 140), key: "squat", system: .metric)
        )
        let sets = [LiftDraftSet(reps: 5, load: 140), LiftDraftSet(reps: 5, load: 140)]
        XCTAssertFalse(LiftLoggerLogic.canApplyProgression(hint, to: sets))
        XCTAssertEqual(LiftLoggerLogic.applyingProgression(hint, to: sets), sets)
    }

    func testDraftsFromASessionCarryTheirLastSessionAsHistory() {
        let drafts = LiftLoggerLogic.drafts(from: session("a", day: "2026-10-05", names: ["Squat"]), system: .metric)
        XCTAssertEqual(drafts[0].history, Array(repeating: LiftLastRef(reps: 5, load: 100), count: 3))
        // Seeding the form from history must not invent per-set "last:" captions.
        XCTAssertTrue(drafts[0].sets.allSatisfy { $0.last == nil })
    }

    func testDraftsFromLastSetsCarryOnlyWorkingSetsAsHistory() {
        let drafts = LiftLoggerLogic.drafts(
            from: [
                rawDTO("squat", 1, reps: 5, kg: 60, warmup: true),
                rawDTO("squat", 2, reps: 5, kg: 140),
                rawDTO("squat", 3, reps: 5, kg: 140),
            ],
            system: .metric
        )
        XCTAssertEqual(drafts[0].sets.count, 3)
        XCTAssertEqual(drafts[0].history, [LiftLastRef(reps: 5, load: 140), LiftLastRef(reps: 5, load: 140)])
    }

    // MARK: - rest timer math

    func testRestDurationIsLongerForLowerBodyCompounds() {
        XCTAssertEqual(LiftLoggerLogic.restDuration(forKey: "squat"), 150)
        XCTAssertEqual(LiftLoggerLogic.restDuration(forKey: "romanian deadlift"), 150)
        XCTAssertEqual(LiftLoggerLogic.restDuration(forKey: "leg press"), 150)
        XCTAssertEqual(LiftLoggerLogic.restDuration(forKey: "hip thrust"), 150)
        XCTAssertEqual(LiftLoggerLogic.restDuration(forKey: "bench press"), 120)
        XCTAssertEqual(LiftLoggerLogic.restDuration(forKey: "barbell row"), 120)
        XCTAssertEqual(LiftLoggerLogic.restDuration(forKey: "leg curl"), 120)
    }

    func testRestRemainingSecondsRoundsUpAndFloorsAtZero() {
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        let end = start.addingTimeInterval(150)
        XCTAssertEqual(LiftLoggerLogic.restRemainingSeconds(until: end, now: start), 150)
        XCTAssertEqual(LiftLoggerLogic.restRemainingSeconds(until: end, now: start.addingTimeInterval(0.4)), 150)
        XCTAssertEqual(LiftLoggerLogic.restRemainingSeconds(until: end, now: start.addingTimeInterval(1)), 149)
        XCTAssertEqual(LiftLoggerLogic.restRemainingSeconds(until: end, now: start.addingTimeInterval(149.2)), 1)
        XCTAssertEqual(LiftLoggerLogic.restRemainingSeconds(until: end, now: end), 0)
        XCTAssertEqual(LiftLoggerLogic.restRemainingSeconds(until: end, now: end.addingTimeInterval(30)), 0)
    }

    func testRestLabelFormatsMinutesAndPaddedSeconds() {
        XCTAssertEqual(LiftLoggerLogic.restLabel(seconds: 150), "2:30")
        XCTAssertEqual(LiftLoggerLogic.restLabel(seconds: 118), "1:58")
        XCTAssertEqual(LiftLoggerLogic.restLabel(seconds: 120), "2:00")
        XCTAssertEqual(LiftLoggerLogic.restLabel(seconds: 7), "0:07")
        XCTAssertEqual(LiftLoggerLogic.restLabel(seconds: 0), "0:00")
        XCTAssertEqual(LiftLoggerLogic.restLabel(seconds: -5), "0:00")
        XCTAssertEqual(LiftLoggerLogic.restLabel(seconds: 600), "10:00")
    }

    func testRestPhaseRunsThenShowsDoneForAFewSecondsThenHides() {
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        let end = start.addingTimeInterval(10)
        XCTAssertEqual(LiftLoggerLogic.restPhase(end: end, now: start.addingTimeInterval(3)), .running(seconds: 7))
        XCTAssertEqual(LiftLoggerLogic.restPhase(end: end, now: start.addingTimeInterval(9.5)), .running(seconds: 1))
        XCTAssertEqual(LiftLoggerLogic.restPhase(end: end, now: end), .done)
        XCTAssertEqual(LiftLoggerLogic.restPhase(end: end, now: end.addingTimeInterval(3.9)), .done)
        XCTAssertEqual(LiftLoggerLogic.restPhase(end: end, now: end.addingTimeInterval(4)), .hidden)
        XCTAssertEqual(LiftLoggerLogic.restPhase(end: end, now: end.addingTimeInterval(100)), .hidden)
    }

    // MARK: - done ticks / save scope

    func testDraftsToSaveIsEverythingWhenNothingIsTicked() {
        let drafts = [
            LiftDraftExercise(key: "squat", name: "Squat", sets: [LiftDraftSet(reps: 5, load: 140), LiftDraftSet(reps: 5, load: 140)]),
        ]
        XCTAssertFalse(LiftLoggerLogic.hasDoneSets(in: drafts))
        XCTAssertEqual(LiftLoggerLogic.draftsToSave(from: drafts), drafts)
    }

    func testDraftsToSaveKeepsOnlyTickedSetsAndDropsExercisesWithNone() {
        let drafts = [
            LiftDraftExercise(key: "squat", name: "Squat", sets: [
                LiftDraftSet(reps: 5, load: 140, isDone: true),
                LiftDraftSet(reps: 5, load: 140),
                LiftDraftSet(reps: 3, load: 140, isDone: true),
            ]),
            LiftDraftExercise(key: "bench press", name: "Bench press", sets: [LiftDraftSet(reps: 5, load: 90)]),
            LiftDraftExercise(key: "leg press", name: "Leg press", sets: [LiftDraftSet(reps: 10, load: 180, isDone: true)]),
        ]
        XCTAssertTrue(LiftLoggerLogic.hasDoneSets(in: drafts))

        let toSave = LiftLoggerLogic.draftsToSave(from: drafts)

        XCTAssertEqual(toSave.map { $0.key }, ["squat", "leg press"])
        XCTAssertEqual(toSave[0].sets.map { $0.reps }, [5, 3])
        // Request body renumbers across what is actually saved.
        let inputs = LiftLoggerLogic.inputs(from: toSave, system: .metric)
        XCTAssertEqual(inputs.map { $0.setIndex }, [1, 2, 3])
        XCTAssertEqual(inputs.map { $0.exercise }, ["squat", "squat", "leg press"])
    }

    func testSaveLabelIsExplicitAboutWhatGetsSaved() {
        XCTAssertEqual(LiftLoggerLogic.saveLabel(setCount: 7, doneOnly: true), "Save 7 done sets")
        XCTAssertEqual(LiftLoggerLogic.saveLabel(setCount: 9, doneOnly: false), "Save 9 sets")
        XCTAssertEqual(LiftLoggerLogic.saveLabel(setCount: 1, doneOnly: true), "Save 1 done set")
        XCTAssertEqual(LiftLoggerLogic.saveLabel(setCount: 1, doneOnly: false), "Save 1 set")
        XCTAssertEqual(LiftLoggerLogic.saveLabel(setCount: 0, doneOnly: false), "Save lift")
        XCTAssertEqual(LiftLoggerLogic.saveLabel(setCount: 0, doneOnly: true), "Save lift")
    }

    func testSourceIgnoresDoneTicksButNotMissingSets() {
        let seeded = [
            LiftDraftExercise(key: "squat", name: "Squat", sets: [LiftDraftSet(reps: 5, load: 140), LiftDraftSet(reps: 5, load: 140)]),
        ]
        var allTicked = seeded
        for i in allTicked[0].sets.indices { allTicked[0].sets[i].isDone = true }
        XCTAssertEqual(LiftLoggerLogic.source(drafts: LiftLoggerLogic.draftsToSave(from: allTicked), seeded: seeded), "template")

        var someTicked = seeded
        someTicked[0].sets[0].isDone = true
        XCTAssertEqual(LiftLoggerLogic.source(drafts: LiftLoggerLogic.draftsToSave(from: someTicked), seeded: seeded), "manual")
    }
}
