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
}
