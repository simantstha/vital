import XCTest
@testable import Vital

/// New-user clarity: one calibration count on Today and Trends, no weekly
/// review card for an insufficient-data week, the "first review" date, and
/// the checklist's goal-target rule.
final class NewUserClarityTests: XCTestCase {

    private func calibration(hrv: Int, rhr: Int, sleep: Int) throws -> CalibrationStatus {
        let json = """
        {"status":"calibrating","metrics":{
          "hrv_sdnn":{"dataDays":\(hrv),"established":false},
          "resting_hr":{"dataDays":\(rhr),"established":false},
          "sleep_minutes":{"dataDays":\(sleep),"established":false}}}
        """
        return try JSONDecoder().decode(CalibrationStatus.self, from: Data(json.utf8))
    }

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    func testCalibrationProgressIsSmallestDataDaysClamped() throws {
        XCTAssertEqual(CalibrationProgress.daysDone(try calibration(hrv: 5, rhr: 1, sleep: 9)), 1)
        XCTAssertEqual(CalibrationProgress.daysDone(try calibration(hrv: 40, rhr: 30, sleep: 22)), 14)
        XCTAssertEqual(CalibrationProgress.daysDone(nil), 0)
    }

    @MainActor
    func testTrendsLearningRingUsesSharedCalibrationCount() throws {
        let cal = try calibration(hrv: 1, rhr: 1, sleep: 1)
        // No tile has a verdict yet -> headline defaults to 14 remaining (0/14).
        let status = TrendsHeadline.status(verdicts: [], goodCount: 0, watchCount: 0, period: .thirtyDays)
        let unified = TrendsViewModel.applyingSharedCalibration(status, calibration: cal)
        guard case .learning(let progress) = unified else { return XCTFail("expected learning") }
        XCTAssertEqual(progress.ringLabel, "1/14")
        XCTAssertTrue(progress.bodyText.contains("(1 of 14)"))
        // Today's card number is the same helper.
        XCTAssertEqual(Int((CalibrationProgress.fraction(cal) * 14).rounded()), progress.daysDone)
    }

    @MainActor
    func testNeedsVarietyStateIsLeftAlone() throws {
        let cal = try calibration(hrv: 3, rhr: 3, sleep: 3)
        let status = TrendsHeadline.Status.learning(.init(daysRemaining: 0))
        XCTAssertEqual(TrendsViewModel.applyingSharedCalibration(status, calibration: cal), status)
    }

    func testInsufficientReviewNeverShowsTodayCard() {
        let review = WeeklyReviewDTO(weekStart: "2026-09-28", weekEnd: "2026-10-04", headline: "Not enough data for a weekly review yet", stats: [])
        let response = WeeklyReviewResponse(id: "r", review: review)
        let monday = utc.date(from: DateComponents(year: 2026, month: 10, day: 5, hour: 9))!
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(response, now: monday, calendar: utc))
        XCTAssertFalse(WeeklyReviewLogic.shouldShowCard(response, now: monday, calendar: utc, ignoreWindow: true))
    }

    func testNextMondayIsStrictlyAfterNow() {
        let wed = utc.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: 9))!
        let mon = utc.date(from: DateComponents(year: 2026, month: 10, day: 5, hour: 9))!
        XCTAssertEqual(utc.component(.day, from: WeeklyReviewLogic.nextMonday(after: wed, calendar: utc)), 12)
        XCTAssertEqual(utc.component(.day, from: WeeklyReviewLogic.nextMonday(after: mon, calendar: utc)), 12)
        XCTAssertTrue(WeeklyReviewLogic.firstReviewText(now: wed, calendar: utc).hasPrefix("First review on Mon Oct 12"))
    }
}
