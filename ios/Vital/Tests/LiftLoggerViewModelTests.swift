import XCTest
@testable import Vital

/// Drives `LiftLoggerViewModel` through an injected fake of the three
/// strength endpoints — no networking.
@MainActor
final class LiftLoggerViewModelTests: XCTestCase {

    private struct SaveFailure: Error {}

    private final class FakeAPI: LiftLoggerAPIProviding {
        var summary = WorkoutSummaryResponse(days: 84, exercises: [:])
        var lastByExercise: [String: [WorkoutSetDTO]] = [:]
        var lastRequests: [String] = []
        var recentSessions: [RecentSessionDTO] = []
        var savedPerformedAt: [Date] = []
        var savedSessionIds: [String] = []
        /// Every session id posted, including attempts that threw.
        var attemptedSessionIds: [String] = []
        var savedSources: [String] = []
        var savedSets: [[WorkoutSetInputDTO]] = []
        var saveError: Error? = nil
        var recentSessionsError: Error? = nil

        func fetchWorkoutSummary(days: Int) async throws -> WorkoutSummaryResponse {
            summary
        }

        func fetchLastWorkoutSession(exercise: String) async throws -> WorkoutLastSessionResponse {
            lastRequests.append(exercise)
            return WorkoutLastSessionResponse(sets: lastByExercise[exercise] ?? [])
        }

        func fetchRecentWorkoutSessions(limit: Int) async throws -> WorkoutRecentSessionsResponse {
            if let recentSessionsError { throw recentSessionsError }
            return WorkoutRecentSessionsResponse(sessions: recentSessions)
        }

        func logWorkoutSets(
            sessionId: String,
            source: String,
            sets: [WorkoutSetInputDTO],
            performedAt: Date,
            tz: String?
        ) async throws -> LogWorkoutSetsResponse {
            attemptedSessionIds.append(sessionId)
            if let saveError { throw saveError }
            savedSessionIds.append(sessionId)
            savedSources.append(source)
            savedPerformedAt.append(performedAt)
            savedSets.append(sets)
            return LogWorkoutSetsResponse(ok: true, sets: [])
        }
    }

    private func setDTO(_ exercise: String, index: Int, reps: Int = 5, loadKg: Double? = 100) -> WorkoutSetDTO {
        WorkoutSetDTO(
            id: "id-\(exercise)-\(index)",
            sessionId: "s1",
            workoutId: nil,
            performedAt: "2026-10-05T10:00:00.000Z",
            localDay: "2026-10-05",
            exercise: exercise,
            exerciseDisplay: exercise.capitalized,
            setIndex: index,
            reps: reps,
            loadKg: loadKg,
            rpe: nil,
            isWarmup: false,
            source: "manual"
        )
    }

    private func summary(_ keys: [String]) -> WorkoutSummaryResponse {
        var exercises: [String: [WorkoutWeeklyStatDTO]] = [:]
        for key in keys {
            exercises[key] = [
                WorkoutWeeklyStatDTO(weekStart: "2026-10-05", bestEstimatedOneRepMaxKg: 100, volumeKg: 1500, totalSets: 3, totalReps: 15),
            ]
        }
        return WorkoutSummaryResponse(days: 84, exercises: exercises)
    }

    private func makeViewModel(_ api: FakeAPI, preferred: String? = nil) -> LiftLoggerViewModel {
        LiftLoggerViewModel(preferredExercise: preferred, system: .metric, sessionId: "session-under-test", api: api)
    }

    /// A hand-cranked clock + haptic counter, so rest-timer tests never sleep
    /// and never touch the Taptic engine.
    private final class RestHarness {
        var now = Date(timeIntervalSinceReferenceDate: 1_000_000)
        var hapticCount = 0
        var announcements: [String] = []
        func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    }

    private func makeTimedViewModel(
        _ api: FakeAPI, preferred: String? = nil, system: UnitSystem = .metric, harness: RestHarness
    ) -> LiftLoggerViewModel {
        LiftLoggerViewModel(
            preferredExercise: preferred, system: system, sessionId: "session-under-test", api: api,
            clock: { harness.now }, restHaptic: { harness.hapticCount += 1 },
            restAnnouncement: { harness.announcements.append($0) }, runsRestTimer: false
        )
    }

    /// A VM seeded from `/last` with `exercise` × `sets` sets of `reps` @ `kg`.
    private func seededViewModel(
        _ api: FakeAPI, exercise: String = "squat", sets: Int = 3, reps: Int = 5, kg: Double = 140,
        harness: RestHarness
    ) async -> LiftLoggerViewModel {
        api.summary = summary([exercise])
        api.lastByExercise[exercise] = (1...sets).map { setDTO(exercise, index: $0, reps: reps, loadKg: kg) }
        let vm = makeTimedViewModel(api, preferred: exercise, harness: harness)
        await vm.load()
        return vm
    }

    // MARK: - load

    func testLoadPrefillsFromThePreferredExercisesLastSession() async {
        let api = FakeAPI()
        api.summary = summary(["squat"])
        api.lastByExercise["squat"] = [setDTO("squat", index: 1), setDTO("squat", index: 2)]
        let vm = makeViewModel(api, preferred: "Squat")

        await vm.load()

        XCTAssertEqual(api.lastRequests, ["squat"])
        XCTAssertEqual(vm.exercises.count, 1)
        XCTAssertEqual(vm.exercises.first?.sets.count, 2)
        XCTAssertTrue(vm.isRepeatingLast)
        XCTAssertFalse(vm.isLoading)
    }

    func testLoadFallsBackToTheSummarysMostRecentExerciseWhenThePreferredOneIsUnknown() async {
        let api = FakeAPI()
        api.summary = summary(["bench press"])
        api.lastByExercise["bench press"] = [setDTO("bench press", index: 1)]
        let vm = makeViewModel(api, preferred: "BB bench")

        await vm.load()

        XCTAssertEqual(api.lastRequests, ["bb bench", "bench press"])
        XCTAssertEqual(vm.exercises.map(\.key), ["bench press"])
    }

    func testLoadWithNoHistoryLeavesAnEmptyFormWithoutError() async {
        let vm = makeViewModel(FakeAPI())

        await vm.load()

        XCTAssertTrue(vm.exercises.isEmpty)
        XCTAssertFalse(vm.isRepeatingLast)
        XCTAssertFalse(vm.isLoading)
        XCTAssertNil(vm.errorMessage)
    }

    // MARK: - editing

    func testAddSetCopiesThePreviousSet() async {
        let api = FakeAPI()
        api.summary = summary(["squat"])
        api.lastByExercise["squat"] = [setDTO("squat", index: 1, reps: 5, loadKg: 140)]
        let vm = makeViewModel(api, preferred: "squat")
        await vm.load()

        vm.addSet(to: vm.exercises[0].id)

        XCTAssertEqual(vm.exercises[0].sets.count, 2)
        XCTAssertEqual(vm.exercises[0].sets[1].reps, 5)
        XCTAssertEqual(vm.exercises[0].sets[1].load, 140)
    }

    func testAddingAnExistingExerciseAddsASetInsteadOfADuplicateSection() {
        let vm = makeViewModel(FakeAPI())
        vm.addExercise(named: "Squat")
        vm.addExercise(named: "  squat ")

        XCTAssertEqual(vm.exercises.count, 1)
        XCTAssertEqual(vm.exercises[0].sets.count, 2)
        XCTAssertEqual(vm.exercises[0].key, "squat")
        XCTAssertEqual(vm.exercises[0].name, "Squat")
    }

    func testRemovingTheLastSetDropsTheExercise() {
        let vm = makeViewModel(FakeAPI())
        vm.addExercise(named: "squat")

        vm.removeSets(in: vm.exercises[0].id, at: IndexSet(integer: 0))

        XCTAssertTrue(vm.exercises.isEmpty)
    }

    // MARK: - save

    func testSavingAnUneditedRepeatPostsATemplateSessionAndSignalsDidSave() async {
        let api = FakeAPI()
        api.summary = summary(["squat"])
        api.lastByExercise["squat"] = [setDTO("squat", index: 1), setDTO("squat", index: 2)]
        let vm = makeViewModel(api, preferred: "squat")
        await vm.load()

        await vm.save()

        XCTAssertTrue(vm.didSave)
        XCTAssertFalse(vm.isSaving)
        XCTAssertNil(vm.errorMessage)
        XCTAssertEqual(api.savedSources, ["template"])
        XCTAssertEqual(api.savedSessionIds, ["session-under-test"])
        XCTAssertEqual(api.savedSets.first?.map(\.setIndex), [1, 2])
    }

    func testSavingAnEditedSessionPostsManual() async {
        let api = FakeAPI()
        api.summary = summary(["squat"])
        api.lastByExercise["squat"] = [setDTO("squat", index: 1, reps: 5)]
        let vm = makeViewModel(api, preferred: "squat")
        await vm.load()
        vm.exercises[0].sets[0].reps = 6

        await vm.save()

        XCTAssertEqual(api.savedSources, ["manual"])
        XCTAssertEqual(api.savedSets.first?.first?.reps, 6)
    }

    func testSavingNothingShowsAMessageAndDoesNotPost() async {
        let api = FakeAPI()
        let vm = makeViewModel(api)

        await vm.save()

        XCTAssertFalse(vm.didSave)
        XCTAssertNotNil(vm.errorMessage)
        XCTAssertTrue(api.savedSets.isEmpty)
    }

    func testSaveFailureKeepsTheFormAndShowsAnError() async {
        let api = FakeAPI()
        api.saveError = SaveFailure()
        let vm = makeViewModel(api)
        vm.addExercise(named: "squat")

        await vm.save()

        XCTAssertFalse(vm.didSave)
        XCTAssertFalse(vm.isSaving)
        XCTAssertNotNil(vm.errorMessage)
        XCTAssertEqual(vm.exercises.count, 1)
    }

    func testSaveRetryWithoutFormChangesReusesSessionId() async {
        let api = FakeAPI()
        api.saveError = SaveFailure()
        let vm = makeViewModel(api)
        vm.addExercise(named: "squat")
        let sessionId = vm.sessionId

        await vm.save()
        XCTAssertFalse(vm.didSave)
        XCTAssertEqual(api.attemptedSessionIds, [sessionId])
        XCTAssertTrue(api.savedSessionIds.isEmpty)

        api.saveError = nil
        await vm.save()

        XCTAssertEqual(api.attemptedSessionIds, [sessionId, sessionId])
        XCTAssertEqual(api.savedSessionIds, [sessionId])
        XCTAssertTrue(vm.didSave)
    }

    func testSaveRetryAfterFormChangeGeneratesFreshSessionId() async {
        let api = FakeAPI()
        api.saveError = SaveFailure()
        let vm = makeViewModel(api)
        vm.addExercise(named: "squat")
        let sessionId = vm.sessionId

        await vm.save()
        XCTAssertFalse(vm.didSave)
        XCTAssertEqual(api.attemptedSessionIds, [sessionId])

        vm.addSet(to: vm.exercises[0].id)
        api.saveError = nil
        await vm.save()

        XCTAssertEqual(api.attemptedSessionIds.count, 2)
        if api.attemptedSessionIds.count == 2 {
            XCTAssertNotEqual(api.attemptedSessionIds[0], api.attemptedSessionIds[1])
            XCTAssertEqual(api.savedSessionIds, [api.attemptedSessionIds[1]])
        }
        XCTAssertTrue(vm.didSave)
    }

    // MARK: - fast logging

    private func recentSession(_ id: String, day: String, _ exercises: [(String, Int, Double)]) -> RecentSessionDTO {
        RecentSessionDTO(
            sessionId: id, performedAt: "\(day)T10:00:00.000Z", localDay: day,
            exercises: exercises.map { key, sets, kg in
                RecentSessionExerciseDTO(
                    exercise: key, display: key.capitalized, sets: sets,
                    topSet: RecentSessionTopSetDTO(reps: 5, loadKg: kg),
                    setDetails: (0..<sets).map { _ in RecentSessionSetDTO(reps: 5, loadKg: kg, rpe: nil) }
                )
            }
        )
    }

    private func warmupDTO(_ exercise: String, index: Int, loadKg: Double) -> WorkoutSetDTO {
        WorkoutSetDTO(
            id: "id-\(exercise)-\(index)", sessionId: "s1", workoutId: nil,
            performedAt: "2026-10-05T10:00:00.000Z", localDay: "2026-10-05", exercise: exercise,
            exerciseDisplay: exercise.capitalized, setIndex: index, reps: 5, loadKg: loadKg,
            rpe: nil, isWarmup: true, source: "manual"
        )
    }

    func testAddingAnExerciseSeedsItFromItsOwnLastSessionWithHints() async throws {
        let api = FakeAPI()
        // /last returns the WHOLE session: other exercises and warm-ups must be ignored.
        api.lastByExercise["squat"] = [
            warmupDTO("squat", index: 1, loadKg: 60),
            setDTO("squat", index: 2, reps: 8, loadKg: 100),
            setDTO("squat", index: 3, reps: 6, loadKg: 105),
            setDTO("bench press", index: 4, reps: 5, loadKg: 80),
        ]
        let vm = makeViewModel(api)
        vm.addExercise(named: "squat")
        let id = try XCTUnwrap(vm.exercises.first?.id)

        await vm.seedFromHistory(exerciseID: id)

        let sets = try XCTUnwrap(vm.exercises.first?.sets)
        XCTAssertEqual(sets.map { $0.reps }, [8, 6])
        XCTAssertEqual(sets.map { $0.load }, [100, 105])
        XCTAssertEqual(sets.first?.last, LiftLastRef(reps: 8, load: 100))
    }

    func testSeedingDoesNotOverwriteASetTheUserAlreadyEdited() async throws {
        let api = FakeAPI()
        api.lastByExercise["squat"] = [setDTO("squat", index: 1, reps: 8, loadKg: 100)]
        let vm = makeViewModel(api)
        vm.addExercise(named: "squat")
        let exercise = try XCTUnwrap(vm.exercises.first)
        vm.exercises[0].sets[0].load = 90

        await vm.seedFromHistory(exerciseID: exercise.id)

        XCTAssertEqual(vm.exercises[0].sets.count, 1)
        XCTAssertEqual(vm.exercises[0].sets[0].load, 90)
        XCTAssertEqual(vm.exercises[0].history.count, 1)
    }

    func testAddSetAfterSeedingShowsTheNextHistoryHint() async throws {
        let api = FakeAPI()
        api.lastByExercise["squat"] = [
            setDTO("squat", index: 1, reps: 8, loadKg: 100),
            setDTO("squat", index: 2, reps: 6, loadKg: 105),
            setDTO("squat", index: 3, reps: 5, loadKg: 110),
        ]
        let vm = makeViewModel(api)
        vm.addExercise(named: "squat")
        let id = try XCTUnwrap(vm.exercises.first?.id)
        await vm.seedFromHistory(exerciseID: id)
        vm.removeSets(in: id, at: IndexSet(integer: 2))

        vm.addSet(to: id)

        let added = try XCTUnwrap(vm.exercises.first?.sets.last)
        XCTAssertEqual(added.reps, 6)           // copies the previous set
        XCTAssertEqual(added.last, LiftLastRef(reps: 5, load: 110))
    }

    func testPickingARecentSessionReplacesTheForm() async {
        let api = FakeAPI()
        api.recentSessions = [
            recentSession("s-legs", day: "2026-10-03", [("squat", 3, 140)]),
            recentSession("s-push", day: "2026-10-01", [("bench press", 4, 90), ("overhead press", 3, 55)]),
        ]
        let vm = makeViewModel(api)
        await vm.load()
        // Opens on the newest recent session.
        XCTAssertEqual(vm.repeatedSessionId, "s-legs")

        vm.repeatSession(id: "s-push")

        XCTAssertEqual(vm.exercises.map { $0.key }, ["bench press", "overhead press"])
        XCTAssertEqual(vm.exercises.first?.sets.count, 4)
        XCTAssertEqual(vm.repeatedSessionId, "s-push")
        XCTAssertTrue(vm.isRepeatingLast)
    }

    func testOpenSeedsTheWholeNewestSessionAndLabelMatchesIt() async {
        let api = FakeAPI()
        api.summary = summary(["squat"])
        // /last would only give squat; the sessions list must win.
        api.lastByExercise["squat"] = [setDTO("squat", index: 1)]
        api.recentSessions = [
            recentSession("s-legs", day: "2026-10-05", [("squat", 3, 140), ("romanian deadlift", 3, 100), ("leg press", 3, 180)]),
            recentSession("s-push", day: "2026-10-01", [("bench press", 3, 92.5)]),
        ]
        let vm = makeViewModel(api, preferred: "squat")

        await vm.load()

        XCTAssertEqual(vm.exercises.map { $0.key }, ["squat", "romanian deadlift", "leg press"])
        XCTAssertEqual(vm.exercises.map { $0.sets.count }, [3, 3, 3])
        XCTAssertEqual(vm.repeatedSessionId, "s-legs")
        XCTAssertEqual(vm.repeatedSession?.exercises.map { $0.exercise }, vm.exercises.map { $0.key })
        XCTAssertTrue(vm.isRepeatingLast)
        XCTAssertTrue(api.lastRequests.isEmpty)
    }

    func testOpenPutsThePreferredExerciseFirst() async {
        let api = FakeAPI()
        api.recentSessions = [
            recentSession("s-legs", day: "2026-10-05", [("squat", 3, 140), ("leg press", 3, 180)]),
        ]
        let vm = makeViewModel(api, preferred: "Leg press")

        await vm.load()

        XCTAssertEqual(vm.exercises.map { $0.key }, ["leg press", "squat"])
        XCTAssertEqual(vm.repeatedSessionId, "s-legs")
    }

    func testSessionsFailureFallsBackToLastWithNoRepeatedSessionId() async {
        let api = FakeAPI()
        api.summary = summary(["squat"])
        api.lastByExercise["squat"] = [setDTO("squat", index: 1), setDTO("squat", index: 2)]
        api.recentSessionsError = SaveFailure()
        let vm = makeViewModel(api, preferred: "squat")

        await vm.load()

        XCTAssertEqual(vm.exercises.map { $0.key }, ["squat"])
        XCTAssertEqual(vm.exercises.first?.sets.count, 2)
        XCTAssertNil(vm.repeatedSessionId)
        XCTAssertNil(vm.repeatedSession)
        XCTAssertTrue(vm.isRepeatingLast)
    }

    func testCompletionsComeFromTheUsersOwnHistory() async {
        let api = FakeAPI()
        api.summary = summary(["bench press", "squat"])
        api.recentSessions = [
            recentSession("s2", day: "2026-10-05", [("squat", 3, 100)]),
            recentSession("s1", day: "2026-10-03", [("overhead press", 3, 55)]),
        ]
        let vm = makeViewModel(api)
        await vm.load()

        vm.newExerciseName = "ben"
        XCTAssertEqual(vm.completions.map { $0.key }, ["bench press"])
        vm.newExerciseName = "press"
        XCTAssertEqual(Set(vm.completions.map { $0.key }), ["bench press", "overhead press"])
    }

    func testSaveSendsTheChosenDateAndWarmupAndRPE() async {
        let api = FakeAPI()
        let vm = makeViewModel(api)
        vm.addExercise(named: "squat")
        vm.exercises[0].sets[0].isWarmup = true
        vm.exercises[0].sets[0].rpe = 8.5
        let yesterday = Date(timeIntervalSinceNow: -86_400)
        vm.performedDate = yesterday

        await vm.save()

        XCTAssertEqual(api.savedPerformedAt, [yesterday])
        XCTAssertEqual(api.savedSets.first?.first?.isWarmup, true)
        XCTAssertEqual(api.savedSets.first?.first?.rpe, 8.5)
    }

    // MARK: - progression hint

    func testHintComesFromTheSeededSessionAndTappingItBumpsEveryUneditedSet() async throws {
        let api = FakeAPI()
        api.recentSessions = [recentSession("s-legs", day: "2026-10-05", [("squat", 3, 140), ("bench press", 3, 90)])]
        let vm = makeViewModel(api)
        await vm.load()
        let squatID = try XCTUnwrap(vm.exercises.first { $0.key == "squat" }?.id)
        let benchID = try XCTUnwrap(vm.exercises.first { $0.key == "bench press" }?.id)

        let squatHint = try XCTUnwrap(vm.progressionHint(for: squatID))
        XCTAssertEqual(LiftLoggerLogic.progressionText(squatHint, system: .metric), "Last 3×5 @ 140\u{00A0}kg · try 142.5\u{00A0}kg")
        let benchHint = try XCTUnwrap(vm.progressionHint(for: benchID))
        XCTAssertEqual(LiftLoggerLogic.progressionText(benchHint, system: .metric), "Last 3×5 @ 90\u{00A0}kg · try 91.5\u{00A0}kg")
        XCTAssertTrue(vm.canApplyProgression(to: squatID))

        vm.applyProgression(to: squatID)

        let squat = try XCTUnwrap(vm.exercises.first { $0.key == "squat" })
        XCTAssertEqual(squat.sets.map { $0.load }, [142.5, 142.5, 142.5])
        // Other exercises are untouched and the hint's baseline is unchanged.
        XCTAssertEqual(vm.exercises.first { $0.key == "bench press" }?.sets.map { $0.load }, [90, 90, 90])
        XCTAssertEqual(squat.history.map { $0.load }, [140, 140, 140])
        XCTAssertFalse(vm.canApplyProgression(to: squatID))
        XCTAssertTrue(vm.canApplyProgression(to: benchID))
    }

    func testApplyingTheHintSkipsTickedAndEditedSets() async throws {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        let id = vm.exercises[0].id
        vm.toggleSetDone(exerciseID: id, setID: vm.exercises[0].sets[0].id)   // already done at 140
        vm.exercises[0].sets[1].load = 145                                    // edited

        vm.applyProgression(to: id)

        XCTAssertEqual(vm.exercises[0].sets.map { $0.load }, [140, 145, 142.5])
    }

    func testAMissedSetGivesARepeatHintThatChangesNothing() async throws {
        let api = FakeAPI()
        api.summary = summary(["squat"])
        api.lastByExercise["squat"] = [
            setDTO("squat", index: 1, reps: 5, loadKg: 140),
            setDTO("squat", index: 2, reps: 5, loadKg: 140),
            setDTO("squat", index: 3, reps: 3, loadKg: 140),
        ]
        let vm = makeViewModel(api, preferred: "squat")
        await vm.load()
        let id = vm.exercises[0].id

        let hint = try XCTUnwrap(vm.progressionHint(for: id))
        XCTAssertEqual(LiftLoggerLogic.progressionText(hint, system: .metric), "Last 5/5/3 @ 140\u{00A0}kg · repeat 140\u{00A0}kg")
        XCTAssertFalse(vm.canApplyProgression(to: id))
        vm.applyProgression(to: id)
        XCTAssertEqual(vm.exercises[0].sets.map { $0.load }, [140, 140, 140])
    }

    func testNoHintWithoutHistory() {
        let vm = makeViewModel(FakeAPI())
        vm.addExercise(named: "squat")

        XCTAssertNil(vm.progressionHint(for: vm.exercises[0].id))
        XCTAssertFalse(vm.canApplyProgression(to: vm.exercises[0].id))
    }

    func testAnExerciseAddedLaterGetsAHintOnceItsHistoryLands() async throws {
        let api = FakeAPI()
        api.lastByExercise["bench press"] = [
            setDTO("bench press", index: 1, reps: 5, loadKg: 90),
            setDTO("bench press", index: 2, reps: 5, loadKg: 90),
        ]
        let vm = makeViewModel(api)
        vm.addExercise(named: "bench press")
        let id = try XCTUnwrap(vm.exercises.first?.id)
        XCTAssertNil(vm.progressionHint(for: id))

        await vm.seedFromHistory(exerciseID: id)

        XCTAssertEqual(vm.progressionHint(for: id)?.suggestedLoad, 91.5)
        vm.applyProgression(to: id)
        XCTAssertEqual(vm.exercises[0].sets.map { $0.load }, [91.5, 91.5])
    }

    func testPoundUsersGetPoundSteps() async throws {
        let api = FakeAPI()
        api.recentSessions = [recentSession("s", day: "2026-10-05", [("squat", 3, 102.06)])]
        let harness = RestHarness()
        let vm = makeTimedViewModel(api, system: .imperial, harness: harness)
        await vm.load()

        // 102.06 kg → 225 lb (display unit), +5 lb for a lower-body compound.
        let hint = try XCTUnwrap(vm.progressionHint(for: vm.exercises[0].id))
        XCTAssertEqual(hint.lastLoad, 225)
        XCTAssertEqual(hint.suggestedLoad, 230)
    }

    // MARK: - done ticks + rest timer

    func testTickingASetStartsAFullLowerBodyRest() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        XCTAssertNil(vm.rest)

        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)

        XCTAssertTrue(vm.exercises[0].sets[0].isDone)
        XCTAssertEqual(vm.rest?.start, harness.now)
        XCTAssertEqual(vm.rest?.end, harness.now.addingTimeInterval(150))
    }

    func testOtherLiftsRestTwoMinutes() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), exercise: "bench press", kg: 90, harness: harness)

        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)

        XCTAssertEqual(vm.rest?.end, harness.now.addingTimeInterval(120))
    }

    func testUntickingDoesNotRestartOrStopTheTimer() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        let id = vm.exercises[0].id
        vm.toggleSetDone(exerciseID: id, setID: vm.exercises[0].sets[0].id)
        let original = vm.rest
        harness.advance(40)

        vm.toggleSetDone(exerciseID: id, setID: vm.exercises[0].sets[0].id)   // untick

        XCTAssertFalse(vm.exercises[0].sets[0].isDone)
        XCTAssertEqual(vm.rest, original)
    }

    func testTickingTheNextSetRestartsTheRest() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        let id = vm.exercises[0].id
        vm.toggleSetDone(exerciseID: id, setID: vm.exercises[0].sets[0].id)
        harness.advance(100)

        vm.toggleSetDone(exerciseID: id, setID: vm.exercises[0].sets[1].id)

        XCTAssertEqual(vm.rest?.end, harness.now.addingTimeInterval(150))
    }

    func testExtendAddsThirtySecondsWhileRunningOnly() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        let start = harness.now
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)
        harness.advance(20)

        vm.extendRest()
        XCTAssertEqual(vm.rest?.end, start.addingTimeInterval(180))
        XCTAssertEqual(vm.rest?.start, start)

        // Once the countdown has finished ("Rest done" showing), "+30s" no
        // longer applies.
        harness.advance(161)   // 1s past the extended end
        vm.advanceRest(now: harness.now)
        XCTAssertEqual(harness.hapticCount, 1)
        vm.extendRest()
        XCTAssertEqual(vm.rest?.end, start.addingTimeInterval(180))
    }

    func testSkipClearsTheTimerWithoutTheDoneHaptic() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)

        vm.skipRest()
        harness.advance(500)
        let next = vm.advanceRest(now: harness.now)

        XCTAssertNil(vm.rest)
        XCTAssertNil(next)
        XCTAssertEqual(harness.hapticCount, 0)
    }

    func testRestFiresTheHapticOnceAtZeroShowsDoneThenClears() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        let start = harness.now
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)

        // Mid-countdown: nothing fires, next wake-up is at the end.
        XCTAssertEqual(vm.advanceRest(now: start.addingTimeInterval(100)), 50)
        XCTAssertEqual(harness.hapticCount, 0)

        // At zero: haptic fires, "Rest done" lingers, next wake-up is its timeout.
        XCTAssertEqual(vm.advanceRest(now: start.addingTimeInterval(150)), 4)
        XCTAssertEqual(harness.hapticCount, 1)
        XCTAssertNotNil(vm.rest)

        // Re-checking during the done window doesn't buzz again.
        XCTAssertEqual(vm.advanceRest(now: start.addingTimeInterval(152)), 2)
        XCTAssertEqual(harness.hapticCount, 1)

        // Window over: the bar goes away.
        XCTAssertNil(vm.advanceRest(now: start.addingTimeInterval(154)))
        XCTAssertNil(vm.rest)
        XCTAssertEqual(harness.hapticCount, 1)
    }

    func testARestThatEndedWhileSuspendedClearsQuietly() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)

        XCTAssertNil(vm.advanceRest(now: harness.now.addingTimeInterval(600)))

        XCTAssertNil(vm.rest)
        XCTAssertEqual(harness.hapticCount, 0)
        XCTAssertTrue(harness.announcements.isEmpty, "nothing is announced late")
    }

    // MARK: - VoiceOver

    func testRestDoneIsAnnouncedToVoiceOverExactlyOnceAtZero() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        let start = harness.now
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)

        // Mid-countdown: silent.
        vm.advanceRest(now: start.addingTimeInterval(100))
        XCTAssertTrue(harness.announcements.isEmpty)

        // At zero: "Rest done", alongside the haptic.
        vm.advanceRest(now: start.addingTimeInterval(150))
        XCTAssertEqual(harness.announcements, ["Rest done"])
        XCTAssertEqual(harness.announcements, [LiftLoggerLogic.restDoneAnnouncement])
        XCTAssertEqual(harness.hapticCount, 1)

        // Re-checking during the done window, and the window ending, stay silent.
        vm.advanceRest(now: start.addingTimeInterval(152))
        vm.advanceRest(now: start.addingTimeInterval(154))
        XCTAssertEqual(harness.announcements, ["Rest done"])
    }

    func testSkippingTheRestAnnouncesNothing() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)

        vm.skipRest()
        harness.advance(500)
        vm.advanceRest(now: harness.now)

        XCTAssertTrue(harness.announcements.isEmpty)
    }

    func testRestButtonsMeetTheMinimumTapTarget() {
        XCTAssertGreaterThanOrEqual(LiftLoggerLogic.restButtonMinTapSize, 44)
    }

    func testSavingStopsTheRestTimer() async {
        let harness = RestHarness()
        let vm = await seededViewModel(FakeAPI(), harness: harness)
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)
        XCTAssertNotNil(vm.rest)

        await vm.save()

        XCTAssertTrue(vm.didSave)
        XCTAssertNil(vm.rest)
    }

    // MARK: - save semantics

    func testSaveButtonCountsEverySetWhenNothingIsTicked() async {
        let api = FakeAPI()
        let vm = await seededViewModel(api, harness: RestHarness())

        XCTAssertFalse(vm.hasDoneSets)
        XCTAssertEqual(vm.saveLabel, "Save 3 sets")
        XCTAssertTrue(vm.canSave)

        await vm.save()

        XCTAssertEqual(api.savedSets.first?.count, 3)
        // The screenshot flow: saving the untouched repeat is a template log.
        XCTAssertEqual(api.savedSources, ["template"])
    }

    func testSaveLogsOnlyTickedSetsAndSaysSo() async throws {
        let api = FakeAPI()
        let vm = await seededViewModel(api, harness: RestHarness())
        vm.addExercise(named: "bench press")
        let squatID = vm.exercises[0].id
        vm.toggleSetDone(exerciseID: squatID, setID: vm.exercises[0].sets[0].id)
        vm.toggleSetDone(exerciseID: squatID, setID: vm.exercises[0].sets[2].id)

        XCTAssertTrue(vm.hasDoneSets)
        XCTAssertEqual(vm.saveLabel, "Save 2 done sets")

        await vm.save()

        let saved = try XCTUnwrap(api.savedSets.first)
        XCTAssertEqual(saved.count, 2)
        XCTAssertEqual(saved.map { $0.exercise }, ["squat", "squat"])
        XCTAssertEqual(saved.map { $0.setIndex }, [1, 2])
        XCTAssertEqual(api.savedSources, ["manual"])
    }

    func testTickingEverySetStillSavesATemplate() async {
        let api = FakeAPI()
        let vm = await seededViewModel(api, harness: RestHarness())
        for set in vm.exercises[0].sets {
            vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: set.id)
        }

        XCTAssertEqual(vm.saveLabel, "Save 3 done sets")
        await vm.save()

        XCTAssertEqual(api.savedSets.first?.count, 3)
        XCTAssertEqual(api.savedSources, ["template"])
    }

    func testSaveLabelUsesSingularAndFallsBackWhenThereIsNothingToSave() {
        let vm = makeTimedViewModel(FakeAPI(), harness: RestHarness())
        XCTAssertEqual(vm.saveLabel, "Save lift")
        XCTAssertFalse(vm.canSave)

        vm.addExercise(named: "squat")
        XCTAssertEqual(vm.saveLabel, "Save 1 set")
        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)
        XCTAssertEqual(vm.saveLabel, "Save 1 done set")
        XCTAssertTrue(vm.canSave)
    }

    func testChangingTheTickedSetsAfterAFailedSaveGetsAFreshSessionId() async {
        let api = FakeAPI()
        api.saveError = SaveFailure()
        let vm = await seededViewModel(api, harness: RestHarness())
        let sessionId = vm.sessionId
        await vm.save()
        XCTAssertFalse(vm.didSave)

        vm.toggleSetDone(exerciseID: vm.exercises[0].id, setID: vm.exercises[0].sets[0].id)
        api.saveError = nil
        await vm.save()

        XCTAssertEqual(api.attemptedSessionIds.count, 2)
        XCTAssertNotEqual(api.attemptedSessionIds[0], api.attemptedSessionIds[1])
        XCTAssertEqual(api.attemptedSessionIds[0], sessionId)
        XCTAssertTrue(vm.didSave)
    }

    func testAddSetDoesNotCopyTheDoneTick() async {
        let vm = await seededViewModel(FakeAPI(), harness: RestHarness())
        let id = vm.exercises[0].id
        vm.toggleSetDone(exerciseID: id, setID: vm.exercises[0].sets[2].id)

        vm.addSet(to: id)

        XCTAssertEqual(vm.exercises[0].sets.map { $0.isDone }, [false, false, true, false])
    }
}
