import XCTest
@testable import Vital

/// The Targets card's view model against a fake profile API: a target date that
/// has passed must read as "passed", offer "Pick a new date" / "Remove date",
/// and — unless the user changes it — never go back to the server (which only
/// accepts a NEW date after today), so it can't make every other edit fail.
@MainActor
final class GoalTargetsViewModelTests: XCTestCase {

    private final class FakeAPI: GoalTargetsAPIProviding {
        struct Call: Equatable {
            let targetWeightKg: Double?
            let targetDate: String?
            let includeTargetDate: Bool
            let weeklySessionsTarget: Int?
        }

        var profile: ProfileResponse
        var updateError: Error?
        var calls: [Call] = []

        init(profile: ProfileResponse) { self.profile = profile }

        func fetchProfile() async throws -> ProfileResponse { profile }

        func updateGoalTargets(
            targetWeightKg: Double?,
            targetDate: String?,
            includeTargetDate: Bool,
            weeklySessionsTarget: Int?,
            weeklyDistanceKmTarget: Double?,
            raceDate: String?,
            raceDistanceKm: Double?
        ) async throws {
            calls.append(Call(
                targetWeightKg: targetWeightKg, targetDate: targetDate,
                includeTargetDate: includeTargetDate, weeklySessionsTarget: weeklySessionsTarget
            ))
            if let updateError { throw updateError }
        }
    }

    /// 2026-10-09 12:00 UTC — "2026-09-30" is past and "2026-12-01" future in every time zone.
    private var now: Date { ISO8601DateFormatter().date(from: "2026-10-09T12:00:00Z")! }

    private func profile(targetDate: String?, weightKg: Double = 81.6) throws -> ProfileResponse {
        let date = targetDate.map { "\"\($0)\"" } ?? "null"
        let json = """
        {
          "name": "Alex", "integrations": [],
          "stats": {"loggedDays": 40, "mealsLogged": 80, "avgHrv": 55, "workouts": 12},
          "profile": {"age": 30, "biologicalSex": "male", "heightCm": 180, "weightKg": \(weightKg)},
          "createdAt": "2026-04-01T09:00:00.000Z",
          "targetWeightKg": 76,
          "targetDate": \(date),
          "goalStartWeightKg": 90,
          "goalStartedAt": "2026-06-01T09:00:00.000Z"
        }
        """
        return try JSONDecoder().decode(ProfileResponse.self, from: Data(json.utf8))
    }

    private func loaded(targetDate: String?, weightKg: Double = 81.6) async throws -> (GoalTargetsViewModel, FakeAPI) {
        let api = FakeAPI(profile: try profile(targetDate: targetDate, weightKg: weightKg))
        let vm = GoalTargetsViewModel(api: api, now: { self.now })
        await vm.load()
        return (vm, api)
    }

    // MARK: - Decoding

    func testProfileWithAPastTargetDateDecodes() throws {
        let response = try profile(targetDate: "2020-01-15")
        XCTAssertEqual(response.targetDate, "2020-01-15")
        XCTAssertEqual(response.targetWeightKg, 76)
        XCTAssertNil(try profile(targetDate: nil).targetDate)
    }

    // MARK: - A passed date

    func testAPassedTargetDateShowsAsPassedAndLeavesTheSheetClean() async throws {
        let (vm, _) = try await loaded(targetDate: "2026-09-30")

        XCTAssertEqual(vm.passedTargetDay, "2026-09-30")
        XCTAssertEqual(vm.passedTargetDateText, "Target date passed (Sep 30)")
        XCTAssertNil(vm.activeTargetDate, "a past date is not a deadline for the pace warning")
        XCTAssertEqual(vm.payload.targetDate, "2026-09-30")
        XCTAssertFalse(vm.targetDateChanged)
        XCTAssertFalse(vm.isDirty)
        XCTAssertFalse(vm.canSave)
    }

    func testEditingAnotherTargetDoesNotResendAPassedDate() async throws {
        let (vm, api) = try await loaded(targetDate: "2026-09-30")
        vm.hasWeeklySessions = true
        vm.weeklySessions = 3
        XCTAssertTrue(vm.canSave)

        let saved = await vm.save()

        XCTAssertTrue(saved)
        XCTAssertNil(vm.errorMessage)
        XCTAssertEqual(api.calls.count, 1)
        XCTAssertEqual(api.calls[0].includeTargetDate, false, "an untouched passed date must not be sent")
        XCTAssertEqual(api.calls[0].weeklySessionsTarget, 3)
        XCTAssertEqual(api.calls[0].targetWeightKg, 76, "the untouched weight round-trips exactly")
        XCTAssertEqual(vm.passedTargetDay, "2026-09-30", "still passed until the user resolves it")
    }

    func testPickANewDateLeavesThePassedStateWithAFutureDateAndSendsIt() async throws {
        let (vm, api) = try await loaded(targetDate: "2026-09-30")

        vm.pickNewTargetDate()

        XCTAssertNil(vm.passedTargetDay)
        XCTAssertNil(vm.passedTargetDateText)
        XCTAssertTrue(vm.hasTargetDate)
        XCTAssertNotNil(vm.activeTargetDate)
        XCTAssertTrue(vm.targetDateChanged)
        XCTAssertTrue(vm.canSave)
        let newDay = try XCTUnwrap(vm.payload.targetDate)
        XCTAssertFalse(GoalTargetLogic.isPassedTargetDay(newDay, now: now), "the fresh date is after today")

        let saved = await vm.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(api.calls[0].includeTargetDate, true)
        XCTAssertEqual(api.calls[0].targetDate, newDay)
    }

    func testRemoveDateSendsAnExplicitNull() async throws {
        let (vm, api) = try await loaded(targetDate: "2026-09-30")

        vm.removeTargetDate()

        XCTAssertNil(vm.passedTargetDay)
        XCTAssertFalse(vm.hasTargetDate)
        XCTAssertNil(vm.payload.targetDate)
        XCTAssertTrue(vm.canSave)

        let saved = await vm.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(api.calls[0].includeTargetDate, true)
        XCTAssertNil(api.calls[0].targetDate, "null clears the stored date")
    }

    func testTodayCountsAsPassedBecauseTheServerOnlyAcceptsLaterDates() async throws {
        let today = GoalTargetLogic.dayString(from: now)
        let (vm, _) = try await loaded(targetDate: today)
        XCTAssertEqual(vm.passedTargetDay, today)
        XCTAssertTrue(try XCTUnwrap(vm.passedTargetDateText).hasPrefix("Target date is today ("))
    }

    func testTheServerRefusingANewPastDateSurfacesAsPickADateAfterToday() async throws {
        let (vm, api) = try await loaded(targetDate: "2026-09-30")
        api.updateError = APIError.targetDateInPast
        vm.pickNewTargetDate()

        let saved = await vm.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(vm.errorMessage, "Pick a date after today")
    }

    // MARK: - A date that is still ahead

    func testAFutureDateIsEditableAndAnUntouchedOneIsNotResent() async throws {
        let (vm, api) = try await loaded(targetDate: "2026-12-01")

        XCTAssertNil(vm.passedTargetDay)
        XCTAssertNil(vm.passedTargetDateText)
        XCTAssertTrue(vm.hasTargetDate)
        XCTAssertNotNil(vm.activeTargetDate)
        XCTAssertFalse(vm.isDirty)

        vm.hasWeeklySessions = true
        vm.weeklySessions = 4
        let saved = await vm.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(api.calls[0].includeTargetDate, false)
        XCTAssertEqual(api.calls[0].weeklySessionsTarget, 4)
    }

    func testChangingAFutureDateSendsIt() async throws {
        let (vm, api) = try await loaded(targetDate: "2026-12-01")
        vm.targetDate = try XCTUnwrap(GoalTargetLogic.date(fromDay: "2027-02-14"))

        XCTAssertTrue(vm.targetDateChanged)
        let saved = await vm.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(api.calls[0].includeTargetDate, true)
        XCTAssertEqual(api.calls[0].targetDate, "2027-02-14")
    }

    func testNoStoredDateLoadsCleanAndAddingOneIsSent() async throws {
        let (vm, api) = try await loaded(targetDate: nil)
        XCTAssertNil(vm.passedTargetDay)
        XCTAssertFalse(vm.hasTargetDate)
        XCTAssertFalse(vm.isDirty)

        vm.hasTargetDate = true
        XCTAssertTrue(vm.targetDateChanged)
        _ = await vm.save()

        XCTAssertEqual(api.calls[0].includeTargetDate, true)
        XCTAssertNotNil(api.calls[0].targetDate)
    }

    // MARK: - Reached target vs a newly typed one

    func testSavedTargetTheWeightAlreadyMeetsReadsAsReachedUntilANewOneIsTyped() async throws {
        // Saved target 76 kg, current weight 75 kg: the goal is met.
        let (vm, _) = try await loaded(targetDate: nil, weightKg: 75)
        XCTAssertEqual(vm.storedTargetKg, 76)
        XCTAssertEqual(vm.targetKg, 76)
        func warning() -> String? {
            GoalTargetLogic.sanityWarning(
                goal: "weight_loss", currentKg: vm.currentWeightKg, targetKg: vm.targetKg,
                targetDate: vm.activeTargetDate, units: UnitPreference.shared.current,
                storedTargetKg: vm.storedTargetKg, from: now
            )
        }
        XCTAssertEqual(warning(), GoalTargetLogic.reachedTargetMessage)

        // The user types a NEW target above their current weight: a validation warning again.
        vm.targetWeightText = UnitFormat.weightEntryText(kg: 90, UnitPreference.shared.current)
        XCTAssertNotEqual(vm.targetKg, 76)
        XCTAssertEqual(warning(), "Your target should be below your current weight.")

        // A new, valid target below the current weight: no warning at all.
        vm.targetWeightText = UnitFormat.weightEntryText(kg: 70, UnitPreference.shared.current)
        XCTAssertNil(warning())
    }
}
