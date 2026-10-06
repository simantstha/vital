import XCTest
import HealthKit
@testable import Vital

@MainActor
final class ProactiveNotificationsTests: XCTestCase {
    @MainActor
    func testConcurrentSyncRequestsJoinTheSameOperationUntilPersistenceCompletes() async {
        let coalescer = SyncOperationCoalescer()
        let started = expectation(description: "sync started")
        var release: CheckedContinuation<Void, Never>?
        var operationCount = 0
        var secondReturned = false

        let first = Task { @MainActor in
            await coalescer.run {
                operationCount += 1
                started.fulfill()
                await withCheckedContinuation { release = $0 }
            }
        }
        await fulfillment(of: [started], timeout: 1)

        let second = Task { @MainActor in
            await coalescer.run { operationCount += 1 }
            secondReturned = true
        }
        await Task.yield()

        XCTAssertEqual(operationCount, 1)
        XCTAssertFalse(secondReturned)
        release?.resume()
        await first.value
        await second.value
        XCTAssertTrue(secondReturned)
    }

    final class MockTransport: NotificationPreferencesTransport {
        var remote: NotificationPreferences
        var puts: [NotificationPreferences] = []
        var failPut = false
        var failGet = false
        var getCount = 0
        init(_ remote: NotificationPreferences) { self.remote = remote }
        func get() async throws -> NotificationPreferences {
            getCount += 1
            if failGet { throw URLError(.notConnectedToInternet) }
            return remote
        }
        func put(_ value: NotificationPreferences) async throws {
            if failPut { throw URLError(.notConnectedToInternet) }
            puts.append(value); remote = value
        }
    }
    struct StubEnvironmentResolver: APNSEnvironmentResolving { let value: APNSEnvironment?; func resolve() -> APNSEnvironment? { value } }
    func testAnalysisResponseDecodesOnlyPublicResult() throws {
        let data = Data(#"{"id":"8ba804f0-68b2-4d36-98bb-90c9eea911a1","date":"2026-07-12","result":{"headline":"Strong session","shortInsight":"You handled the load well.","narrative":"Recovery stayed stable.","observations":["Steady heart rate"],"nextSteps":["Hydrate"]},"createdAt":"2026-07-12T15:00:00.000Z"}"#.utf8)
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: data)
        XCTAssertEqual(value.result.headline, "Strong session")
        XCTAssertEqual(value.result.nextSteps, ["Hydrate"])
    }

    /// The exact `context` shape #248 (`lib/analysisContext.ts`) sends for a
    /// workout analysis (analysis-v2-contract.md §1) — pins that
    /// `AnalysisContext`'s custom `Decodable` accepts every sub-object,
    /// including `effort.avgPct` as a 0...1 fraction (not a percentage).
    func testAnalysisContextDecodesWorkoutShape() throws {
        let json = #"""
        {
          "id":"8ba804f0-68b2-4d36-98bb-90c9eea911a1","date":"2026-07-12",
          "result":{"headline":"h","shortInsight":"s","narrative":"n","observations":[],"nextSteps":[]},
          "createdAt":"2026-07-12T15:00:00.000Z",
          "context": {
            "usual": { "sessions": 6, "distanceM": 4800, "durationMin": 29, "paceMinPerKm": 6.1, "avgHr": 145 },
            "paceHistory": { "previous": [6.4, 6.2, 6.1, 6.3, 6, 6.2], "rank": 2 },
            "effort": { "restingHr": 52, "maxHr": 182, "avgPct": 0.738, "zone": "steady" },
            "goingIn": { "sleepMinutes": 412, "hrv": { "value": 61, "unit": "ms", "vsNormal": "normal", "source": "apple" }, "daysSinceLastSameType": 2 },
            "nextMorning": { "hrv": { "value": 58, "unit": "ms", "vsNormal": "below", "source": "apple" }, "restingHr": { "value": 54, "unit": "bpm", "vsNormal": "normal", "source": "apple" } }
          }
        }
        """#
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: Data(json.utf8))
        let context = try XCTUnwrap(value.context)
        XCTAssertEqual(context.usual?.sessions, 6)
        XCTAssertEqual(context.usual?.distanceM, 4800)
        XCTAssertNil(context.sleepUsual, "a workout context must not also decode a sleepUsual from the shared 'usual' key")
        XCTAssertEqual(context.paceHistory?.previous, [6.4, 6.2, 6.1, 6.3, 6, 6.2])
        XCTAssertEqual(context.paceHistory?.rank, 2)
        XCTAssertEqual(context.effort?.avgPct, 0.738)
        XCTAssertEqual(context.effort?.zone, "steady")
        XCTAssertEqual(context.goingIn?.sleepMinutes, 412)
        XCTAssertEqual(context.goingIn?.hrv?.vsNormal, "normal")
        XCTAssertEqual(context.goingIn?.daysSinceLastSameType, 2)
        XCTAssertEqual(context.nextMorning?.hrv?.vsNormal, "below")
        XCTAssertEqual(context.nextMorning?.restingHr?.value, 54)
    }

    /// Same shared-key ambiguity, sleep side — `usual` here is
    /// {nights, minutes, stages}, not the workout shape.
    func testAnalysisContextDecodesSleepShape() throws {
        let json = #"""
        {
          "id":"8ba804f0-68b2-4d36-98bb-90c9eea911a2","date":"2026-07-12",
          "result":{"headline":"h","shortInsight":"s","narrative":"n","observations":[],"nextSteps":[]},
          "createdAt":"2026-07-12T15:00:00.000Z",
          "context": {
            "goalMinutes": 480,
            "usual": { "nights": 14, "minutes": 440, "stages": { "core": 262, "deep": 70, "rem": 92, "awake": 14 } },
            "week": [ { "date": "2026-07-06", "minutes": 420 }, { "date": "2026-07-12", "minutes": 348 } ],
            "timing": { "bedTime": "2026-07-11T23:52:00.000Z", "wakeTime": "2026-07-12T06:10:00.000Z" },
            "beforeBed": { "lastWorkoutEndedAt": "2026-07-11T21:40:00.000Z" },
            "thisMorning": { "hrv": { "value": 48, "unit": "ms", "vsNormal": "below", "source": "apple" } }
          }
        }
        """#
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: Data(json.utf8))
        let context = try XCTUnwrap(value.context)
        XCTAssertNil(context.usual, "a sleep context must not also decode a workout usual from the shared 'usual' key")
        XCTAssertEqual(context.goalMinutes, 480)
        XCTAssertEqual(context.sleepUsual?.nights, 14)
        XCTAssertEqual(context.sleepUsual?.stages?.deep, 70)
        XCTAssertEqual(context.week?.count, 2)
        XCTAssertEqual(context.week?.last?.minutes, 348)
        XCTAssertNotNil(context.timing?.bedTime)
        XCTAssertNotNil(context.beforeBed?.lastWorkoutEndedAt)
        XCTAssertNil(context.beforeBed?.lastMealAt)
        XCTAssertEqual(context.thisMorning?.hrv?.value, 48)
        XCTAssertNil(context.thisMorning?.restingHr)
    }

    /// A response with no `context` key at all (older API / a kind that
    /// never carries one) must still decode — `context` stays nil rather
    /// than failing the whole response.
    func testAnalysisResponseWithoutContextDecodesContextAsNil() throws {
        let data = Data(#"{"id":"8ba804f0-68b2-4d36-98bb-90c9eea911a3","date":"2026-07-12","result":{"headline":"h","shortInsight":"s","narrative":"n","observations":[],"nextSteps":[]},"createdAt":"2026-07-12T15:00:00.000Z"}"#.utf8)
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: data)
        XCTAssertNil(value.context)
    }

    // MARK: - context.devices (phase 2 "both devices" contract, lib/analysisContext.ts)

    /// The exact `context.devices` shape `buildWorkoutDevicesContext` sends —
    /// primary session first, with `kcal`; the other session omits `kcal`
    /// (server: "the UI says not counted").
    func testAnalysisContextDecodesWorkoutDevicesShape() throws {
        let json = #"""
        {
          "id":"8ba804f0-68b2-4d36-98bb-90c9eea911a4","date":"2026-07-12",
          "result":{"headline":"h","shortInsight":"s","narrative":"n","observations":[],"nextSteps":[]},
          "createdAt":"2026-07-12T15:00:00.000Z",
          "context": {
            "devices": {
              "primary": "apple",
              "sessions": [
                {
                  "source": "apple", "durationMin": 52.23, "distanceM": 10200, "avgHr": 158, "maxHr": 176,
                  "kcal": 612, "zonesSec": [149, 209, 2448, 298, 30], "zoneBasis": "reserve",
                  "hrSeries": [110, 130, 150, 158, 176],
                  "running": { "cadenceSpm": 172, "groundContactMs": 238, "powerW": 268, "strideM": 1.14 }
                },
                {
                  "source": "whoop", "durationMin": 52, "avgHr": 156, "strain": 14.8,
                  "zonesSec": [242, 490, 1060, 1152, 190], "zoneBasis": "maxHr"
                }
              ]
            }
          }
        }
        """#
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: Data(json.utf8))
        let context = try XCTUnwrap(value.context)
        let devices = try XCTUnwrap(context.devices)
        XCTAssertEqual(devices.primary, .apple)
        XCTAssertEqual(devices.sessions?.count, 2)
        let apple = try XCTUnwrap(devices.sessions?.first)
        XCTAssertEqual(apple.source, .apple)
        XCTAssertEqual(apple.kcal, 612)
        XCTAssertEqual(apple.zonesSec, [149, 209, 2448, 298, 30])
        XCTAssertEqual(apple.zoneBasis, "reserve")
        XCTAssertEqual(apple.hrSeries, [110, 130, 150, 158, 176])
        XCTAssertEqual(apple.running?.cadenceSpm, 172)
        XCTAssertEqual(apple.running?.groundContactMs, 238)
        let whoop = try XCTUnwrap(devices.sessions?.last)
        XCTAssertEqual(whoop.source, .whoop)
        XCTAssertNil(whoop.kcal, "the non-primary session must omit kcal — 'not counted'")
        XCTAssertEqual(whoop.strain, 14.8)
        XCTAssertEqual(whoop.zoneBasis, "maxHr")
        XCTAssertNil(whoop.hrSeries)
        XCTAssertNil(whoop.running)
    }

    /// The exact `context.devices` shape `buildSleepDevicesContext` sends —
    /// `minutes` + optional `stages`, no workout-only fields.
    func testAnalysisContextDecodesSleepDevicesShape() throws {
        let json = #"""
        {
          "id":"8ba804f0-68b2-4d36-98bb-90c9eea911a5","date":"2026-07-12",
          "result":{"headline":"h","shortInsight":"s","narrative":"n","observations":[],"nextSteps":[]},
          "createdAt":"2026-07-12T15:00:00.000Z",
          "context": {
            "devices": {
              "primary": "whoop",
              "sessions": [
                { "source": "whoop", "minutes": 348, "stages": { "core": 242, "deep": 42, "rem": 64, "awake": 38 } },
                { "source": "apple", "minutes": 370, "stages": { "core": 250, "deep": 48, "rem": 58, "awake": 14 } }
              ]
            }
          }
        }
        """#
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: Data(json.utf8))
        let context = try XCTUnwrap(value.context)
        let devices = try XCTUnwrap(context.devices)
        XCTAssertEqual(devices.primary, .whoop)
        let whoop = try XCTUnwrap(devices.sessions?.first)
        XCTAssertEqual(whoop.minutes, 348)
        XCTAssertEqual(whoop.stages?.deep, 42)
        XCTAssertNil(whoop.durationMin, "sleep sessions never carry workout-only fields")
        let apple = try XCTUnwrap(devices.sessions?.last)
        XCTAssertEqual(apple.minutes, 370)
        XCTAssertEqual(apple.stages?.core, 250)
    }

    /// A context with no `devices` key at all must still decode, with
    /// `devices` nil — the common case for every non-endurance fixture
    /// scenario and every analysis before phase 2.
    func testAnalysisContextWithoutDevicesDecodesDevicesAsNil() throws {
        let json = #"""
        {
          "id":"8ba804f0-68b2-4d36-98bb-90c9eea911a6","date":"2026-07-12",
          "result":{"headline":"h","shortInsight":"s","narrative":"n","observations":[],"nextSteps":[]},
          "createdAt":"2026-07-12T15:00:00.000Z",
          "context": {
            "usual": { "sessions": 6, "distanceM": 4800, "durationMin": 29, "paceMinPerKm": 6.1, "avgHr": 145 }
          }
        }
        """#
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: Data(json.utf8))
        let context = try XCTUnwrap(value.context)
        XCTAssertNil(context.devices)
        XCTAssertEqual(context.usual?.sessions, 6, "the rest of the context must still decode normally")
    }

    func testPushRouteParsesAnalysisAndMorningBriefPayloads() {
        let id = "8ba804f0-68b2-4d36-98bb-90c9eea911a1"
        XCTAssertEqual(PushRoute(userInfo: ["type": "workout_analysis", "id": id, "deepLink": "vital://workout-analysis/\(id)"]), .workoutAnalysis(id))
        XCTAssertEqual(PushRoute(userInfo: ["type": "sleep_analysis", "id": id, "deepLink": "vital://sleep-analysis/\(id)"]), .sleepAnalysis(id))
        XCTAssertEqual(PushRoute(userInfo: ["type": "morning_brief", "id": id, "deepLink": "vital://morning-brief/\(id)"]), .morningBrief(id))
        XCTAssertEqual(PushRoute(userInfo: ["type": "morning_brief", "deepLink": "vital://today"]), .morningBrief(nil))
        XCTAssertNil(PushRoute(userInfo: ["type": "workout_analysis", "id": id, "deepLink": "https://example.com/\(id)"]))
        XCTAssertNil(PushRoute(userInfo: ["type": "workout_analysis", "id": id, "deepLink": "vital://sleep-analysis/\(id)"]))
        XCTAssertNil(PushRoute(userInfo: ["type": "morning_brief", "id": id, "deepLink": "vital://sleep-analysis/\(id)"]))
    }

    func testParsesCoachNudgeRoute() {
        let userInfo: [AnyHashable: Any] = [
            "type": "coach_nudge",
            "id": "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
            "deepLink": "vital://coach-nudge/3F2504E0-4F89-11D3-9A0C-0305E82C3301",
        ]
        XCTAssertEqual(PushRoute(userInfo: userInfo), .coachNudge("3F2504E0-4F89-11D3-9A0C-0305E82C3301"))
    }

    func testRejectsCoachNudgeWithMismatchedHost() {
        let userInfo: [AnyHashable: Any] = [
            "type": "coach_nudge",
            "id": "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
            "deepLink": "vital://something-else/3F2504E0-4F89-11D3-9A0C-0305E82C3301",
        ]
        XCTAssertNil(PushRoute(userInfo: userInfo))
    }

    /// Pins the shared UUID-format guard for `coach_nudge` specifically. The
    /// route deliberately sits *inside* that guard alongside its three
    /// siblings, so a non-UUID id is rejected before the type switch is ever
    /// reached — consistency with the sibling routes matters more than the
    /// fact that today's server re-scopes the id anyway.
    func testRejectsCoachNudgeWithNonUuidId() {
        let userInfo: [AnyHashable: Any] = [
            "type": "coach_nudge",
            "id": "abc-123",
            "deepLink": "vital://coach-nudge/abc-123",
        ]
        XCTAssertNil(PushRoute(userInfo: userInfo))
    }

    func testServerPreferencesPreserveLocalReminderSettings() {
        let mapped = NotificationPreferences.fromLocal(
            morningEnabled: false, morningMinutes: 510,
            workoutEnabled: true, sleepEnabled: false,
            mealsEnabled: false, breakfastMinutes: 500,
            lunchMinutes: 780, snackMinutes: 950, dinnerMinutes: 1140,
            timezone: "America/Chicago"
        )
        XCTAssertEqual(mapped.morningBriefTimeMinutes, 510)
        XCTAssertEqual(mapped.timezone, "America/Chicago")
        XCTAssertTrue(mapped.workoutNotificationsEnabled)
        XCTAssertFalse(mapped.sleepNotificationsEnabled)
        XCTAssertFalse(mapped.mealsEnabled)
        XCTAssertEqual(mapped.mealBreakfastTimeMinutes, 500)
        XCTAssertEqual(mapped.mealLunchTimeMinutes, 780)
        XCTAssertEqual(mapped.mealSnackTimeMinutes, 950)
        XCTAssertEqual(mapped.mealDinnerTimeMinutes, 1140)
    }

    func testPreferencesDecodeDefaultsCoachAndWeeklyReviewToTrueWhenMissing() throws {
        let legacy = """
        {"morningBriefEnabled":true,"morningBriefTimeMinutes":450,"workoutNotificationsEnabled":true,
         "sleepNotificationsEnabled":true,"mealsEnabled":true,"mealBreakfastTimeMinutes":480,
         "mealLunchTimeMinutes":765,"mealSnackTimeMinutes":960,"mealDinnerTimeMinutes":1170,"timezone":"UTC"}
        """
        let decoded = try JSONDecoder().decode(NotificationPreferences.self, from: Data(legacy.utf8))
        XCTAssertTrue(decoded.coachNudgesEnabled)
        XCTAssertTrue(decoded.weeklyReviewEnabled)

        let off = NotificationPreferences.fromLocal(
            morningEnabled: true, morningMinutes: 450, workoutEnabled: true, sleepEnabled: true,
            mealsEnabled: true, breakfastMinutes: 480, lunchMinutes: 765, snackMinutes: 960, dinnerMinutes: 1170,
            timezone: "UTC", coachNudgesEnabled: false, weeklyReviewEnabled: false
        )
        let roundTripped = try JSONDecoder().decode(NotificationPreferences.self, from: JSONEncoder().encode(off))
        XCTAssertFalse(roundTripped.coachNudgesEnabled)
        XCTAssertFalse(roundTripped.weeklyReviewEnabled)
        XCTAssertEqual(roundTripped, off)
    }

    func testLocalScheduleContainsNoMorningBrief() {
        XCTAssertFalse(ReminderScheduler.localReminderKinds.contains(.morningBrief))
        XCTAssertEqual(Set(ReminderScheduler.localReminderKinds), [.meal, .weighIn])
    }

    func testSleepBackgroundDeliveryIsImmediate() {
        XCTAssertEqual(HealthSyncCoordinator.sleepBackgroundFrequency, .immediate)
    }

    func testEntitlementEnvironmentMapping() {
        XCTAssertEqual(SignedEntitlementEnvironmentResolver.map("development"), .sandbox)
        XCTAssertEqual(SignedEntitlementEnvironmentResolver.map("production"), .production)
        XCTAssertNil(SignedEntitlementEnvironmentResolver.map("unknown"))
        XCTAssertNil(SignedEntitlementEnvironmentResolver.map(nil))
        XCTAssertNil(PushNotificationService(environmentResolver: StubEnvironmentResolver(value: nil)).resolvedEnvironment())
        XCTAssertEqual(PushNotificationService(environmentResolver: StubEnvironmentResolver(value: .production)).resolvedEnvironment(), .production)
    }

    func testHydrationChangesOnlyServerOwnedKeys() async {
        let suite = "hydrate-\(UUID())"; let defaults = UserDefaults(suiteName: suite)!
        defaults.set(false, forKey: NotificationPrefsKeys.mealsEnabled)
        defaults.set(900, forKey: NotificationPrefsKeys.mealsLunchMinutes)
        let remote = NotificationPreferences.fromLocal(
            morningEnabled: false, morningMinutes: 600, workoutEnabled: false, sleepEnabled: true,
            mealsEnabled: true, breakfastMinutes: 495, lunchMinutes: 780, snackMinutes: 975, dinnerMinutes: 1155,
            timezone: "UTC"
        )
        let service = PushNotificationService(transport: MockTransport(remote))
        await service.hydratePreferences(defaults: defaults, timezone: TimeZone(identifier: "UTC")!)
        XCTAssertFalse(defaults.bool(forKey: NotificationPrefsKeys.briefEnabled))
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.briefMinutes), 600)
        XCTAssertTrue(defaults.bool(forKey: NotificationPrefsKeys.mealsEnabled))
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.mealsBreakfastMinutes), 495)
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.mealsLunchMinutes), 780)
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.mealsSnackMinutes), 975)
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.mealsDinnerMinutes), 1155)
        defaults.removePersistentDomain(forName: suite)
    }

    func testGetFailureRetryActuallyHydratesAndClearsErrorOnlyAfterSuccess() async {
        let suite = "get-retry-\(UUID())"; let defaults = UserDefaults(suiteName: suite)!
        let remote = NotificationPreferences.fromLocal(
            morningEnabled: false, morningMinutes: 620, workoutEnabled: true, sleepEnabled: false,
            mealsEnabled: true, breakfastMinutes: 480, lunchMinutes: 765, snackMinutes: 960, dinnerMinutes: 1170,
            timezone: "UTC"
        )
        let transport = MockTransport(remote); transport.failGet = true
        let service = PushNotificationService(transport: transport, debounceMilliseconds: nil)
        await service.hydratePreferences(defaults: defaults, timezone: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(transport.getCount, 1); XCTAssertNotNil(service.preferencesError)
        await service.retryPreferences(defaults: defaults, timezone: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(transport.getCount, 2); XCTAssertNotNil(service.preferencesError)
        transport.failGet = false
        await service.retryPreferences(defaults: defaults, timezone: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(transport.getCount, 3); XCTAssertNil(service.preferencesError)
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.briefMinutes), 620)
        defaults.removePersistentDomain(forName: suite)
    }

    func testLatestPreferenceWriteWinsAndOfflineRetryPersistsPending() async {
        let suite = "sync-\(UUID())"; let defaults = UserDefaults(suiteName: suite)!
        let first = NotificationPreferences.fromLocal(
            morningEnabled: true, morningMinutes: 450, workoutEnabled: true, sleepEnabled: true,
            mealsEnabled: true, breakfastMinutes: 480, lunchMinutes: 765, snackMinutes: 960, dinnerMinutes: 1170,
            timezone: "UTC"
        )
        let latest = NotificationPreferences.fromLocal(
            morningEnabled: false, morningMinutes: 500, workoutEnabled: false, sleepEnabled: true,
            mealsEnabled: false, breakfastMinutes: 480, lunchMinutes: 765, snackMinutes: 960, dinnerMinutes: 1170,
            timezone: "UTC"
        )
        let transport = MockTransport(first); transport.failPut = true
        let service = PushNotificationService(transport: transport, debounceMilliseconds: nil)
        service.enqueuePreferences(first, defaults: defaults)
        service.enqueuePreferences(latest, defaults: defaults)
        await service.flush(defaults: defaults)
        XCTAssertTrue(service.preferencesPending)
        XCTAssertNotNil(service.preferencesError)
        transport.failPut = false
        let retryService = PushNotificationService(transport: transport, debounceMilliseconds: nil)
        await retryService.hydratePreferences(defaults: defaults, timezone: TimeZone(identifier: "UTC")!)
        await retryService.flush(defaults: defaults)
        XCTAssertEqual(transport.puts, [latest])
        XCTAssertFalse(retryService.preferencesPending)
        defaults.removePersistentDomain(forName: suite)
    }

    func testRouterRequiresSessionAndResetClearsSensitiveState() {
        let id = UUID().uuidString
        let payload: [AnyHashable: Any] = ["type": "sleep_analysis", "id": id, "deepLink": "vital://sleep-analysis/\(id)"]
        let router = AppRouter(); router.handle(payload); XCTAssertNil(router.route)
        router.activateSession(token: "session"); router.handle(payload); XCTAssertEqual(router.route, .sleepAnalysis(id))
        router.coachContext = "private analysis"; router.resetSession()
        XCTAssertNil(router.route); XCTAssertNil(router.coachContext)
    }

    func testDelegateRouterRoutesOnlyIntoActiveSession() {
        let id = UUID().uuidString
        let router = AppRouter(); router.activateSession(token: "session")
        NotificationDelegateRouter.route(["type": "workout_analysis", "id": id, "deepLink": "vital://workout-analysis/\(id)"], to: router)
        XCTAssertEqual(router.route, .workoutAnalysis(id))
    }

    func testForegroundReceiptPresentsWithoutRoutingUntilUserInteraction() {
        XCTAssertFalse(NotificationDeliveryPolicy.shouldRoute(.foregroundReceipt))
        XCTAssertTrue(NotificationDeliveryPolicy.shouldRoute(.userResponse))
        XCTAssertTrue(NotificationDeliveryPolicy.shouldRoute(.coldLaunchTap))
    }
}
