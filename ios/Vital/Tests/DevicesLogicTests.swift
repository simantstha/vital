import XCTest
@testable import Vital

final class DevicesLogicTests: XCTestCase {

    // MARK: - Available options

    func testAvailableOptionsAlwaysOffersAutomatic() {
        let options = DevicesLogic.availableOptions(appleConnected: false, whoopConnected: false)
        XCTAssertEqual(options, [.automatic])
    }

    func testAvailableOptionsOffersOnlyConnectedDevices() {
        let appleOnly = DevicesLogic.availableOptions(appleConnected: true, whoopConnected: false)
        XCTAssertEqual(appleOnly, [.automatic, .device(.apple)])

        let both = DevicesLogic.availableOptions(appleConnected: true, whoopConnected: true)
        XCTAssertEqual(both, [.automatic, .device(.apple), .device(.whoop)])

        let whoopOnly = DevicesLogic.availableOptions(appleConnected: false, whoopConnected: true)
        XCTAssertEqual(whoopOnly, [.automatic, .device(.whoop)])
    }

    // MARK: - Patch value

    func testPatchValueForAutomaticIsNil() {
        XCTAssertNil(DevicesLogic.patchValue(for: .automatic))
    }

    func testPatchValueForDeviceIsThatDevice() {
        XCTAssertEqual(DevicesLogic.patchValue(for: .device(.whoop)), .whoop)
        XCTAssertEqual(DevicesLogic.patchValue(for: .device(.apple)), .apple)
    }

    // MARK: - Selected option

    func testSelectedOptionFromExplicitNilIsAutomatic() {
        XCTAssertEqual(DevicesLogic.selectedOption(explicit: nil), .automatic)
    }

    func testSelectedOptionFromExplicitDevice() {
        XCTAssertEqual(DevicesLogic.selectedOption(explicit: .whoop), .device(.whoop))
    }

    // MARK: - Row value label

    func testRowValueLabelShowsExplicitDeviceNameAlone() {
        XCTAssertEqual(DevicesLogic.rowValueLabel(explicit: .whoop, resolved: .whoop), "WHOOP")
        XCTAssertEqual(DevicesLogic.rowValueLabel(explicit: .apple, resolved: .whoop), "Apple Watch")
    }

    func testRowValueLabelShowsAutomaticWithResolvedDevice() {
        XCTAssertEqual(DevicesLogic.rowValueLabel(explicit: nil, resolved: .apple), "Automatic · Apple Watch")
        XCTAssertEqual(DevicesLogic.rowValueLabel(explicit: nil, resolved: .whoop), "Automatic · WHOOP")
    }

    // MARK: - Device name

    func testDeviceNameMapping() {
        XCTAssertEqual(DevicesLogic.deviceName(.apple), "Apple Watch")
        XCTAssertEqual(DevicesLogic.deviceName(.whoop), "WHOOP")
    }

    // MARK: - Sync status

    func testSyncStatusLabelNotConnected() {
        XCTAssertEqual(DevicesLogic.syncStatusLabel(connected: false, lastSyncAt: nil), "Not connected")
        // Even a stale/garbage lastSyncAt is ignored when not connected.
        XCTAssertEqual(DevicesLogic.syncStatusLabel(connected: false, lastSyncAt: Date()), "Not connected")
    }

    func testSyncStatusLabelConnectedWithNoTimestampReadsNotConnected() {
        // connected==true with a nil lastSyncAt is treated the same as "not
        // connected" — there's nothing to report a sync time for.
        XCTAssertEqual(DevicesLogic.syncStatusLabel(connected: true, lastSyncAt: nil), "Not connected")
    }

    func testSyncStatusLabelJustNow() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let thirtySecondsAgo = now.addingTimeInterval(-30)
        XCTAssertEqual(
            DevicesLogic.syncStatusLabel(connected: true, lastSyncAt: thirtySecondsAgo, now: now),
            "Synced just now"
        )
    }

    func testSyncStatusLabelMinutesAgoUsesSyncedPrefix() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let fourMinutesAgo = now.addingTimeInterval(-4 * 60)
        let label = DevicesLogic.syncStatusLabel(connected: true, lastSyncAt: fourMinutesAgo, now: now)
        // The exact relative phrase is `RelativeDateTimeFormatter`'s own
        // (locale/OS-dependent) output — only the "Synced " prefix and the
        // absence of the "Not connected"/"just now" fallbacks are ours to
        // guarantee here.
        XCTAssertTrue(label.hasPrefix("Synced "), "expected a 'Synced …' label, got \(label)")
        XCTAssertNotEqual(label, "Synced just now")
        XCTAssertNotEqual(label, "Not connected")
    }

    // MARK: - Sync freshness

    func testSyncFreshnessThresholds() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        func f(_ hoursAgo: Double) -> DevicesLogic.SyncFreshness {
            DevicesLogic.syncFreshness(connected: true, lastSyncAt: now.addingTimeInterval(-hoursAgo * 3600), now: now)
        }
        XCTAssertEqual(f(0.1), .fresh)
        XCTAssertEqual(f(6), .fresh)
        XCTAssertEqual(f(6.5), .stale)
        XCTAssertEqual(f(12), .stale)
        XCTAssertEqual(f(48), .stale)
        XCTAssertEqual(f(49), .veryStale)
        XCTAssertEqual(DevicesLogic.syncFreshness(connected: false, lastSyncAt: now, now: now), .disconnected)
        XCTAssertEqual(DevicesLogic.syncFreshness(connected: true, lastSyncAt: nil, now: now), .disconnected)
    }

    func testStaleSyncLabelHintsPullToSync() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let stale = DevicesLogic.syncStatusLabel(connected: true, lastSyncAt: now.addingTimeInterval(-12 * 3600), now: now)
        XCTAssertTrue(stale.hasSuffix("Pull to sync"), stale)
        let fresh = DevicesLogic.syncStatusLabel(connected: true, lastSyncAt: now.addingTimeInterval(-2 * 3600), now: now)
        XCTAssertFalse(fresh.contains("Pull to sync"), fresh)
    }

    func testStatusRowTitleUsesAppleHealthName() {
        XCTAssertEqual(DevicesLogic.statusRowTitle(.apple), "Apple Health (Apple Watch)")
        XCTAssertEqual(DevicesLogic.statusRowTitle(.whoop), "WHOOP")
    }

    // MARK: - Duplicates caption

    func testDuplicatesCaptionOmittedWhenZero() {
        XCTAssertNil(DevicesLogic.duplicatesCaption(mergedThisMonth: 0))
    }

    func testDuplicatesCaptionShowsCount() {
        XCTAssertEqual(DevicesLogic.duplicatesCaption(mergedThisMonth: 3), "3 merged this month")
        XCTAssertEqual(DevicesLogic.duplicatesCaption(mergedThisMonth: 1), "1 merged this month")
    }

    // MARK: - Explicit preferences subscript

    func testExplicitPreferencesSubscriptGetSet() {
        var prefs = DevicesLogic.ExplicitPreferences()
        XCTAssertNil(prefs[.workouts])
        prefs[.workouts] = .whoop
        prefs[.sleep] = .apple
        XCTAssertEqual(prefs[.workouts], .whoop)
        XCTAssertEqual(prefs[.sleep], .apple)
        XCTAssertNil(prefs[.recovery])
    }

    // MARK: - Resolved primaries subscript

    func testResolvedPrimariesSubscript() {
        let primaries = DevicesLogic.ResolvedPrimaries(workouts: .apple, sleep: .whoop, recovery: .whoop)
        XCTAssertEqual(primaries[.workouts], .apple)
        XCTAssertEqual(primaries[.sleep], .whoop)
        XCTAssertEqual(primaries[.recovery], .whoop)
    }

    // MARK: - Metric copy

    func testMetricTitlesAndSubtitles() {
        XCTAssertEqual(DevicesLogic.Metric.workouts.title, "Workouts")
        XCTAssertEqual(DevicesLogic.Metric.workouts.subtitle, "Heart rate, pace, route, calories")
        XCTAssertEqual(DevicesLogic.Metric.sleep.title, "Sleep")
        XCTAssertEqual(DevicesLogic.Metric.sleep.subtitle, "Duration, stages, sleep need")
        XCTAssertEqual(DevicesLogic.Metric.recovery.title, "Recovery")
        XCTAssertEqual(DevicesLogic.Metric.recovery.subtitle, "HRV, resting heart rate")
    }
}
