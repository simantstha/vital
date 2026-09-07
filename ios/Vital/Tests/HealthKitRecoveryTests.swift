import XCTest
@testable import Vital

@MainActor
final class HealthKitRecoveryTests: XCTestCase {

    // MARK: - shouldShowHealthKitRecoveryBanner inference rule
    //
    // The rule is pure and static, requiring no HealthKit or UserDefaults
    // access — only two inputs: whether the authorization prompt was ever
    // shown, and whether any data has been collected. All four combinations
    // are tested to prevent regression in the inference logic itself, which
    // is the part most likely to break under future changes.
    //
    // The rule: show the banner only when BOTH conditions are true:
    // 1. The system prompt has been shown at least once
    // 2. Zero data exists across all requested HealthKit types
    //
    // When either condition is false:
    // - A fresh user pre-prompt sees neither the banner nor accusation
    // - A user with ANY data (even partial grant) sees neither
    //   (critical: a user who granted sleep but not HRV must never be
    //    told they refused something they didn't)

    func testNeverAskedNoDataShowsBannerFalse() {
        // Fresh launch: prompt hasn't been shown yet, no data in Health.
        // Must not show banner — a user who simply hasn't answered yet
        // should not be accused of denying.
        let result = TodayViewModel.shouldShowHealthKitRecoveryBanner(
            didRequestAuthorization: false,
            hasAnyHealthData: false
        )
        XCTAssertFalse(result)
    }

    func testNeverAskedHasDataShowsBannerFalse() {
        // Unlikely path (how would data arrive without prompt?), but
        // included for completeness: even with data present, never show
        // the banner if we never asked.
        let result = TodayViewModel.shouldShowHealthKitRecoveryBanner(
            didRequestAuthorization: false,
            hasAnyHealthData: true
        )
        XCTAssertFalse(result)
    }

    func testAskedHasDataShowsBannerFalse() {
        // User was prompted and granted at least partial access (sleep
        // but not HRV, or some data logged under a granted type). CRITICAL:
        // must not show banner — we cannot tell the difference between
        // "denied HRV but granted sleep" and "has sleep data". Showing
        // the banner would falsely accuse them of denial.
        let result = TodayViewModel.shouldShowHealthKitRecoveryBanner(
            didRequestAuthorization: true,
            hasAnyHealthData: true
        )
        XCTAssertFalse(result)
    }

    func testAskedNoDataShowsBannerTrue() {
        // User was prompted at least once, and every requested read type
        // has zero samples. This is the probable-denial case: show the
        // banner with recovery instructions. HealthKit never reports read
        // denial explicitly (by design — Apple prevents apps inferring
        // health conditions from refusal), so this inference is the best
        // we can do. The copy must not assert denial (uses
        // "isn't seeing your Health data" not "you denied access").
        let result = TodayViewModel.shouldShowHealthKitRecoveryBanner(
            didRequestAuthorization: true,
            hasAnyHealthData: false
        )
        XCTAssertTrue(result)
    }
}
