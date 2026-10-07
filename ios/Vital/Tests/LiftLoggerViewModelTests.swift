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

        func fetchWorkoutSummary(days: Int) async throws -> WorkoutSummaryResponse {
            summary
        }

        func fetchLastWorkoutSession(exercise: String) async throws -> WorkoutLastSessionResponse {
            lastRequests.append(exercise)
            return WorkoutLastSessionResponse(sets: lastByExercise[exercise] ?? [])
        }

        func fetchRecentWorkoutSessions(limit: Int) async throws -> WorkoutRecentSessionsResponse {
            WorkoutRecentSessionsResponse(sessions: recentSessions)
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
        // No /last data: falls back to the newest session.
        XCTAssertEqual(vm.repeatedSessionId, "s-legs")

        vm.repeatSession(id: "s-push")

        XCTAssertEqual(vm.exercises.map { $0.key }, ["bench press", "overhead press"])
        XCTAssertEqual(vm.exercises.first?.sets.count, 4)
        XCTAssertEqual(vm.repeatedSessionId, "s-push")
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
}
