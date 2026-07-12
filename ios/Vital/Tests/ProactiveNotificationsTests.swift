import XCTest
import HealthKit
@testable import Vital

@MainActor
final class ProactiveNotificationsTests: XCTestCase {
    final class MockTransport: NotificationPreferencesTransport {
        var remote: NotificationPreferences
        var puts: [NotificationPreferences] = []
        var failPut = false
        init(_ remote: NotificationPreferences) { self.remote = remote }
        func get() async throws -> NotificationPreferences { remote }
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

    func testPushRouteParsesAnalysisAndMorningBriefPayloads() {
        let id = "8ba804f0-68b2-4d36-98bb-90c9eea911a1"
        XCTAssertEqual(PushRoute(userInfo: ["type": "workout_analysis", "id": id, "deepLink": "vital://workout-analysis/\(id)"]), .workoutAnalysis(id))
        XCTAssertEqual(PushRoute(userInfo: ["type": "sleep_analysis", "id": id, "deepLink": "vital://sleep-analysis/\(id)"]), .sleepAnalysis(id))
        XCTAssertEqual(PushRoute(userInfo: ["type": "morning_brief", "deepLink": "vital://today"]), .morningBrief)
        XCTAssertNil(PushRoute(userInfo: ["type": "workout_analysis", "id": id, "deepLink": "https://example.com/\(id)"]))
        XCTAssertNil(PushRoute(userInfo: ["type": "workout_analysis", "id": id, "deepLink": "vital://sleep-analysis/\(id)"]))
    }

    func testServerPreferencesPreserveLocalReminderSettings() {
        let mapped = NotificationPreferences.fromLocal(
            morningEnabled: false, morningMinutes: 510,
            workoutEnabled: true, sleepEnabled: false, timezone: "America/Chicago"
        )
        XCTAssertEqual(mapped.morningBriefTimeMinutes, 510)
        XCTAssertEqual(mapped.timezone, "America/Chicago")
        XCTAssertTrue(mapped.workoutNotificationsEnabled)
        XCTAssertFalse(mapped.sleepNotificationsEnabled)
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
        let remote = NotificationPreferences.fromLocal(morningEnabled: false, morningMinutes: 600, workoutEnabled: false, sleepEnabled: true, timezone: "UTC")
        let service = PushNotificationService(transport: MockTransport(remote))
        await service.hydratePreferences(defaults: defaults, timezone: TimeZone(identifier: "UTC")!)
        XCTAssertFalse(defaults.bool(forKey: NotificationPrefsKeys.briefEnabled))
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.briefMinutes), 600)
        XCTAssertFalse(defaults.bool(forKey: NotificationPrefsKeys.mealsEnabled))
        XCTAssertEqual(defaults.integer(forKey: NotificationPrefsKeys.mealsLunchMinutes), 900)
        defaults.removePersistentDomain(forName: suite)
    }

    func testLatestPreferenceWriteWinsAndOfflineRetryPersistsPending() async {
        let suite = "sync-\(UUID())"; let defaults = UserDefaults(suiteName: suite)!
        let first = NotificationPreferences.fromLocal(morningEnabled: true, morningMinutes: 450, workoutEnabled: true, sleepEnabled: true, timezone: "UTC")
        let latest = NotificationPreferences.fromLocal(morningEnabled: false, morningMinutes: 500, workoutEnabled: false, sleepEnabled: true, timezone: "UTC")
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
}
