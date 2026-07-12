import XCTest
import HealthKit
@testable import Vital

final class ProactiveNotificationsTests: XCTestCase {
    func testAnalysisResponseDecodesOnlyPublicResult() throws {
        let data = Data(#"{"id":"8ba804f0-68b2-4d36-98bb-90c9eea911a1","date":"2026-07-12","result":{"headline":"Strong session","shortInsight":"You handled the load well.","narrative":"Recovery stayed stable.","observations":["Steady heart rate"],"nextSteps":["Hydrate"]},"createdAt":"2026-07-12T15:00:00.000Z"}"#.utf8)
        let value = try JSONDecoder.vital.decode(AnalysisResponse.self, from: data)
        XCTAssertEqual(value.result.headline, "Strong session")
        XCTAssertEqual(value.result.nextSteps, ["Hydrate"])
    }

    func testPushRouteParsesAnalysisAndMorningBriefPayloads() {
        let id = "8ba804f0-68b2-4d36-98bb-90c9eea911a1"
        XCTAssertEqual(PushRoute(userInfo: ["type": "workout_analysis", "id": id]), .workoutAnalysis(id))
        XCTAssertEqual(PushRoute(userInfo: ["type": "sleep_analysis", "id": id]), .sleepAnalysis(id))
        XCTAssertEqual(PushRoute(userInfo: ["type": "morning_brief"]), .morningBrief)
        XCTAssertNil(PushRoute(userInfo: ["type": "workout_analysis", "id": "hidden-queue-key"]))
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
}
