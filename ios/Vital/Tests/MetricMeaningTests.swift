import XCTest
@testable import Vital

final class MetricMeaningTests: XCTestCase {

    // MARK: - HRV

    func testHRVAboveWithRestingHRBelowCorroborates() {
        let message = MetricMeaning.message(metricKey: "hrv_sdnn", verdict: .above(z: 1.2), relatedVerdict: .below(z: -1.1))
        XCTAssertEqual(message, "Your recovery markers look good today. See Today for what to do.")
        XCTAssertFalse(message?.lowercased().contains("hardest") ?? true)
    }

    func testHRVAboveWithoutCorroborationOmitsAgreesClause() {
        let message = MetricMeaning.message(metricKey: "hrv_sdnn", verdict: .above(z: 1.2), relatedVerdict: .normal)
        XCTAssertEqual(message, "Your HRV is above your normal today — a sign of good recovery.")
    }

    func testHRVAboveWithUnloadedRelatedOmitsAgreesClause() {
        let message = MetricMeaning.message(metricKey: "hrv_sdnn", verdict: .above(z: 1.2), relatedVerdict: nil)
        XCTAssertEqual(message, "Your HRV is above your normal today — a sign of good recovery.")
    }

    func testHRVBelowNeverDiagnoses() {
        let message = MetricMeaning.message(metricKey: "whoop_hrv_rmssd", verdict: .below(z: -1.4), relatedVerdict: nil)
        XCTAssertEqual(message, "Your HRV is below your normal today — your body may still be recovering. See Today for what to do.")
        XCTAssertFalse(message?.lowercased().contains("sick") ?? true)
        XCTAssertFalse(message?.lowercased().contains("illness") ?? true)
    }

    func testHRVNormalIsDescriptive() {
        let message = MetricMeaning.message(metricKey: "hrv_sdnn", verdict: .normal, relatedVerdict: .below(z: -1.1))
        XCTAssertEqual(message, "Your HRV is right in your normal range today.")
    }

    /// The HRV card only sees HRV + resting HR, so no tier may prescribe
    /// training intensity (it contradicted the coach and Today for a user
    /// with a deficit goal and a knee injury).
    func testNoHRVTierPrescribesTraining() {
        let verdicts: [Verdict] = [.above(z: 1.2), .below(z: -1.4), .normal]
        let related: [Verdict?] = [nil, .normal, .below(z: -1.1), .above(z: 1.0)]
        let banned = ["hardest", "go hard", "push", "keep today easy", "train", "session", "workout"]
        for key in ["hrv_sdnn", "whoop_hrv_rmssd"] {
            for verdict in verdicts {
                for rel in related {
                    let text = (MetricMeaning.message(metricKey: key, verdict: verdict, relatedVerdict: rel) ?? "").lowercased()
                    XCTAssertFalse(text.isEmpty)
                    for word in banned {
                        XCTAssertFalse(text.contains(word), "\(key) \(verdict) \(String(describing: rel)): \"\(text)\" contains \"\(word)\"")
                    }
                }
            }
        }
    }

    func testHRVCalibratingHidesCard() {
        XCTAssertNil(MetricMeaning.message(metricKey: "hrv_sdnn", verdict: .calibrating(daysRemaining: 3), relatedVerdict: nil))
    }

    // MARK: - Resting HR

    func testRestingHRBelowWithHRVAboveCorroborates() {
        let message = MetricMeaning.message(metricKey: "resting_hr", verdict: .below(z: -1.2), relatedVerdict: .above(z: 1.0))
        XCTAssertTrue(message?.contains("HRV") ?? false)
    }

    func testRestingHRAboveSuggestsEasierDay() {
        let message = MetricMeaning.message(metricKey: "resting_hr", verdict: .above(z: 1.5), relatedVerdict: nil)
        XCTAssertEqual(message, "Your resting heart rate is higher than your normal today. Consider an easier day and extra rest.")
    }

    // MARK: - Sleep / steps

    func testSleepBelowMessage() {
        let message = MetricMeaning.message(metricKey: "sleep_minutes", verdict: .below(z: -1.0), relatedVerdict: nil)
        XCTAssertNotNil(message)
    }

    func testStepsNormalMessage() {
        let message = MetricMeaning.message(metricKey: "steps", verdict: .normal, relatedVerdict: nil)
        XCTAssertEqual(message, "Today's activity is right in your normal range.")
    }

    // MARK: - Unsupported metrics hide the card

    func testUnsupportedMetricReturnsNil() {
        XCTAssertNil(MetricMeaning.message(metricKey: "body_mass_kg", verdict: .above(z: 1.0), relatedVerdict: nil))
        XCTAssertNil(MetricMeaning.message(metricKey: "vo2_max", verdict: .normal, relatedVerdict: nil))
    }

    func testNoDataHidesCardForEveryCoveredMetric() {
        for key in ["hrv_sdnn", "resting_hr", "sleep_minutes", "steps"] {
            XCTAssertNil(MetricMeaning.message(metricKey: key, verdict: .noData, relatedVerdict: nil))
        }
    }
}
