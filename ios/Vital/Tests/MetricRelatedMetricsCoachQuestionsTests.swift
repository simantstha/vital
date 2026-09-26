import XCTest
@testable import Vital

/// Coverage for `MetricRelatedMetrics.coachQuestions(for:displayName:direction:)` —
/// every directional chip must agree with the direction it's given, and must
/// never assert the opposite of it (the bug: HRV offering "lower than usual"
/// while the hero pill showed HRV above normal).
final class MetricRelatedMetricsCoachQuestionsTests: XCTestCase {

    private let allDirections: [MetricRelatedMetrics.Direction] = [.above, .below, .normal, .unknown]

    // MARK: - HRV

    func testHRVBelowAsksLower() {
        for key in ["hrv_sdnn", "whoop_hrv_rmssd"] {
            let questions = MetricRelatedMetrics.coachQuestions(for: key, displayName: "HRV", direction: .below)
            XCTAssertTrue(questions.contains("Why is my HRV lower than usual?"), key)
        }
    }

    func testHRVAboveAsksHigher() {
        for key in ["hrv_sdnn", "whoop_hrv_rmssd"] {
            let questions = MetricRelatedMetrics.coachQuestions(for: key, displayName: "HRV", direction: .above)
            XCTAssertTrue(questions.contains("Why is my HRV higher than usual?"), key)
        }
    }

    func testHRVNormalAndUnknownAskNeutral() {
        for direction: MetricRelatedMetrics.Direction in [.normal, .unknown] {
            let questions = MetricRelatedMetrics.coachQuestions(for: "hrv_sdnn", displayName: "HRV", direction: direction)
            XCTAssertTrue(questions.contains("What affects my HRV?"))
        }
    }

    // MARK: - Resting heart rate

    func testRestingHRAboveAsksUpToday() {
        for key in ["resting_hr", "whoop_resting_hr"] {
            let questions = MetricRelatedMetrics.coachQuestions(for: key, displayName: "Resting HR", direction: .above)
            XCTAssertTrue(questions.contains("Why is my resting heart rate up today?"), key)
        }
    }

    func testRestingHRBelowAsksLowerToday() {
        for key in ["resting_hr", "whoop_resting_hr"] {
            let questions = MetricRelatedMetrics.coachQuestions(for: key, displayName: "Resting HR", direction: .below)
            XCTAssertTrue(questions.contains("Why is my resting heart rate lower today?"), key)
        }
    }

    func testRestingHRNormalAndUnknownAskNeutral() {
        for direction: MetricRelatedMetrics.Direction in [.normal, .unknown] {
            let questions = MetricRelatedMetrics.coachQuestions(for: "resting_hr", displayName: "Resting HR", direction: direction)
            XCTAssertTrue(questions.contains("What affects my resting heart rate?"))
        }
    }

    // MARK: - Sleep

    func testSleepBelowAsksWhyLess() {
        for key in ["sleep_minutes", "whoop_sleep_min"] {
            let questions = MetricRelatedMetrics.coachQuestions(for: key, displayName: "Sleep", direction: .below)
            XCTAssertTrue(questions.contains("Why did I sleep less last night?"), key)
        }
    }

    func testSleepAboveNormalUnknownDoNotAskWhyLess() {
        for direction: MetricRelatedMetrics.Direction in [.above, .normal, .unknown] {
            let questions = MetricRelatedMetrics.coachQuestions(for: "sleep_minutes", displayName: "Sleep", direction: direction)
            XCTAssertFalse(questions.contains("Why did I sleep less last night?"))
        }
    }

    // MARK: - Steps

    func testStepsBelowAsksWhyDown() {
        let questions = MetricRelatedMetrics.coachQuestions(for: "steps", displayName: "Steps", direction: .below)
        XCTAssertTrue(questions.contains("Why is my step count down this week?"))
    }

    func testStepsAboveNormalUnknownDoNotAskWhyDown() {
        for direction: MetricRelatedMetrics.Direction in [.above, .normal, .unknown] {
            let questions = MetricRelatedMetrics.coachQuestions(for: "steps", displayName: "Steps", direction: direction)
            XCTAssertFalse(questions.contains("Why is my step count down this week?"))
        }
    }

    // MARK: - No chip ever asserts the opposite direction

    /// For every directional metric and every direction it can be given, no
    /// chip in the returned list ever states the OPPOSITE direction — e.g.
    /// while HRV reads above normal, no chip may claim it's lower, and
    /// vice-versa. This is the regression guard for the original bug.
    func testNoChipEverAssertsTheOppositeDirection() {
        let directionalMetrics: [(key: String, above: String, below: String)] = [
            ("hrv_sdnn", "Why is my HRV higher than usual?", "Why is my HRV lower than usual?"),
            ("whoop_hrv_rmssd", "Why is my HRV higher than usual?", "Why is my HRV lower than usual?"),
            ("resting_hr", "Why is my resting heart rate up today?", "Why is my resting heart rate lower today?"),
            ("whoop_resting_hr", "Why is my resting heart rate up today?", "Why is my resting heart rate lower today?"),
        ]

        for metric in directionalMetrics {
            for direction in allDirections {
                let questions = MetricRelatedMetrics.coachQuestions(for: metric.key, displayName: metric.key, direction: direction)
                switch direction {
                case .above:
                    XCTAssertFalse(questions.contains(metric.below), "\(metric.key) above should never offer the below-normal chip")
                case .below:
                    XCTAssertFalse(questions.contains(metric.above), "\(metric.key) below should never offer the above-normal chip")
                case .normal, .unknown:
                    XCTAssertFalse(questions.contains(metric.above), "\(metric.key) \(direction) should never assert above")
                    XCTAssertFalse(questions.contains(metric.below), "\(metric.key) \(direction) should never assert below")
                }
            }
        }

        // Sleep/steps only assert a single "below" direction chip; every
        // other direction must omit it entirely (covered above), and no
        // direction should ever introduce an "above" claim these metrics
        // don't make in the first place.
        let belowOnlyMetrics: [(key: String, belowChip: String)] = [
            ("sleep_minutes", "Why did I sleep less last night?"),
            ("whoop_sleep_min", "Why did I sleep less last night?"),
            ("steps", "Why is my step count down this week?"),
        ]
        for metric in belowOnlyMetrics {
            for direction in allDirections where direction != .below {
                let questions = MetricRelatedMetrics.coachQuestions(for: metric.key, displayName: metric.key, direction: direction)
                XCTAssertFalse(questions.contains(metric.belowChip), "\(metric.key) \(direction) should never offer the below chip")
            }
        }
    }
}
