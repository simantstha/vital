import XCTest
@testable import Vital

/// Covers `MetricDriverCopy`'s pure sentence-building (both lags, both
/// directions, missing tercile buckets, the sample-size line, the forbidden-
/// word guard) plus `DriverDTO`/`TrendsMarkerDTO` decoding, including an
/// unknown marker `kind`.
final class MetricDriverCopyTests: XCTestCase {

    private static let hrvSpec = MetricCatalog.spec(for: "hrv_sdnn")!

    private func driver(
        input: String = "steps",
        lag: Int = 1,
        direction: String = "down",
        rho: Double = -0.42,
        pairs: Int = 64,
        high: DriverBucketDTO? = DriverBucketDTO(mean: 48, n: 21),
        low: DriverBucketDTO? = DriverBucketDTO(mean: 56, n: 21)
    ) -> DriverDTO {
        DriverDTO(input: input, lag: lag, direction: direction, rho: rho, pairs: pairs, high: high, low: low, highInputMean: 11000, lowInputMean: 6500)
    }

    /// Convenience matching `MetricDetailView`'s own call — the outcome
    /// metric is always `hrv_sdnn` in these tests, same as `Self.hrvSpec`.
    private func sentence(_ d: DriverDTO) -> String {
        MetricDriverCopy.sentence(driver: d, outcomeMetricKey: "hrv_sdnn", outcomeSpec: Self.hrvSpec, unitSystem: .metric)
    }

    // MARK: - sentence(driver:outcomeMetricKey:outcomeSpec:unitSystem:)

    func testSentenceLagZeroReadsThatDay() {
        let d = driver(lag: 0, direction: "up")
        let text = sentence(d)
        XCTAssertTrue(text.contains("that day"), text)
        XCTAssertFalse(text.contains("the next day"), text)
    }

    func testSentenceLagOneReadsTheNextDay() {
        let d = driver(lag: 1)
        let text = sentence(d)
        XCTAssertTrue(text.contains("the next day"), text)
    }

    func testSentenceDirectionDownReadsLower() {
        let d = driver(direction: "down")
        let text = sentence(d)
        XCTAssertTrue(text.contains("tends to be lower"), text)
    }

    func testSentenceDirectionUpReadsHigher() {
        let d = driver(direction: "up")
        let text = sentence(d)
        XCTAssertTrue(text.contains("tends to be higher"), text)
    }

    /// Exact copy for the steps driver, matching the fixture/spec example.
    func testSentenceExactCopyForSteps() {
        let d = driver(input: "steps", lag: 1, direction: "down", high: DriverBucketDTO(mean: 54, n: 21), low: DriverBucketDTO(mean: 62, n: 21))
        XCTAssertEqual(
            sentence(d),
            "On days with more steps, your HRV the next day tends to be lower — 54 vs 62 ms."
        )
    }

    /// Exact copy for the dietary carbs driver.
    func testSentenceExactCopyForDietaryCarbs() {
        let d = driver(input: "dietary_carbs_g", lag: 0, direction: "up", high: DriverBucketDTO(mean: 61, n: 19), low: DriverBucketDTO(mean: 55, n: 19))
        XCTAssertEqual(
            sentence(d),
            "On higher-carb days, your HRV that day tends to be higher — 61 vs 55 ms."
        )
    }

    /// Every one of the 9 server `INPUT_METRICS` keys gets an explicit,
    /// natural-English lead phrase — never the old generic "higher steps"/
    /// "higher dietary carbs" framing, and never a raw underscored key.
    func testLeadPhraseCoversEveryInputMetric() {
        let inputMetrics = [
            "whoop_day_strain", "steps", "exercise_min", "distance_m", "active_energy_kcal",
            "dietary_energy_kcal", "dietary_protein_g", "dietary_carbs_g", "dietary_fat_g",
        ]
        for key in inputMetrics {
            let phrase = MetricDriverCopy.leadPhrase(for: key)
            XCTAssertFalse(phrase.contains("higher steps"), "\(key) -> \(phrase)")
            XCTAssertFalse(phrase.lowercased().contains("dietary"), "\(key) -> \(phrase)")
            XCTAssertFalse(phrase.contains("_"), "\(key) -> \(phrase)")
        }
    }

    /// Both `high` and `low` present → the concrete comparison is appended,
    /// high-input side first, in the outcome's own catalog unit/decimals.
    func testSentenceAppendsComparisonWhenBothBucketsPresent() {
        let d = driver(high: DriverBucketDTO(mean: 48, n: 21), low: DriverBucketDTO(mean: 56, n: 21))
        let text = sentence(d)
        XCTAssertTrue(text.contains("48 vs 56 ms"), text)
    }

    /// A null `high` (or `low`) omits the comparison clause entirely, rather
    /// than rendering a partial/misleading one.
    func testSentenceOmitsComparisonWhenHighIsNil() {
        let d = driver(high: nil, low: DriverBucketDTO(mean: 56, n: 21))
        let text = sentence(d)
        XCTAssertFalse(text.contains("vs"), text)
    }

    func testSentenceOmitsComparisonWhenLowIsNil() {
        let d = driver(high: DriverBucketDTO(mean: 48, n: 21), low: nil)
        let text = sentence(d)
        XCTAssertFalse(text.contains("vs"), text)
    }

    /// The BUG this test guards: the outcome-name fallback must use the
    /// OUTCOME metric key, never `driver.input` (the input metric) — a
    /// missing `outcomeSpec` for an `hrv_sdnn` outcome must still say "HRV"-
    /// adjacent copy about `hrv_sdnn`, not about `steps`.
    func testSentenceOutcomeNameFallsBackToOutcomeKeyNotInputKey() {
        let d = driver(input: "steps")
        let text = MetricDriverCopy.sentence(driver: d, outcomeMetricKey: "hrv_sdnn", outcomeSpec: nil, unitSystem: .metric)
        XCTAssertTrue(text.contains("your hrv_sdnn"), text)
        XCTAssertFalse(text.contains("your steps"), text)
    }

    // MARK: - sampleSizeLine(pairs:)

    func testSampleSizeLine() {
        XCTAssertEqual(MetricDriverCopy.sampleSizeLine(pairs: 64), "Based on 64 days")
    }

    func testSampleSizeLineSingularForOnePair() {
        XCTAssertEqual(MetricDriverCopy.sampleSizeLine(pairs: 1), "Based on 1 day")
    }

    // MARK: - Forbidden words — never implies causation

    func testSentenceNeverContainsForbiddenCausalWords() {
        let cases: [DriverDTO] = [
            driver(lag: 0, direction: "up"),
            driver(lag: 1, direction: "down"),
            driver(high: nil, low: nil),
        ]
        let forbidden = ["cause", "causes", "caused", "because", "leads to", "leading to"]
        for d in cases {
            let text = sentence(d).lowercased()
            for word in forbidden {
                XCTAssertFalse(text.contains(word), "\(text) unexpectedly contains \"\(word)\"")
            }
        }
    }

    func testFooterCopy() {
        XCTAssertEqual(MetricDriverCopy.footer, "Patterns in your own data, not proof of cause.")
    }

    // MARK: - accessibilityLabel(driver:outcomeMetricKey:outcomeSpec:unitSystem:)

    func testAccessibilityLabelCombinesSentenceAndSampleSize() {
        let d = driver()
        let label = MetricDriverCopy.accessibilityLabel(driver: d, outcomeMetricKey: "hrv_sdnn", outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(label.hasPrefix(sentence(d)), label)
        XCTAssertTrue(label.contains("Based on 64 days"), label)
    }

    // MARK: - DriverDTO / TrendsDriversResponse decoding

    func testDriverDTODecodesWithBothBuckets() throws {
        let json = """
        {
            "input": "steps", "lag": 1, "direction": "down", "rho": -0.42, "pairs": 64,
            "high": {"mean": 48, "n": 21}, "low": {"mean": 56, "n": 21},
            "highInputMean": 11000, "lowInputMean": 6500
        }
        """.data(using: .utf8)!
        let dto = try JSONDecoder().decode(DriverDTO.self, from: json)
        XCTAssertEqual(dto.input, "steps")
        XCTAssertEqual(dto.lag, 1)
        XCTAssertEqual(dto.direction, "down")
        XCTAssertEqual(dto.pairs, 64)
        XCTAssertEqual(dto.high?.mean, 48)
        XCTAssertEqual(dto.low?.n, 21)
    }

    func testDriverDTODecodesWithNullBuckets() throws {
        let json = """
        {
            "input": "dietary_carbs_g", "lag": 0, "direction": "up", "rho": 0.38, "pairs": 30,
            "high": null, "low": null, "highInputMean": null, "lowInputMean": null
        }
        """.data(using: .utf8)!
        let dto = try JSONDecoder().decode(DriverDTO.self, from: json)
        XCTAssertNil(dto.high)
        XCTAssertNil(dto.low)
        XCTAssertNil(dto.highInputMean)
    }

    func testTrendsDriversResponseDecodesEmptyDrivers() throws {
        let json = """
        {"metric": "hrv_sdnn", "computedFor": null, "drivers": []}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(TrendsDriversResponse.self, from: json)
        XCTAssertEqual(response.metric, "hrv_sdnn")
        XCTAssertNil(response.computedFor)
        XCTAssertTrue(response.drivers.isEmpty)
    }

    // MARK: - TrendsMarkerDTO / TrendsMarkersResponse decoding

    func testTrendsMarkerDTODecodesWorkoutKind() throws {
        let json = """
        {"date": "2026-09-20", "kind": "workout", "label": "Run", "count": 1}
        """.data(using: .utf8)!
        let dto = try JSONDecoder().decode(TrendsMarkerDTO.self, from: json)
        XCTAssertEqual(dto.date, "2026-09-20")
        XCTAssertEqual(dto.kind, "workout")
        XCTAssertEqual(dto.label, "Run")
        XCTAssertEqual(dto.count, 1)
    }

    /// `kind` is a plain `String` — an unrecognized future kind (e.g.
    /// `"weight_logged"`) must decode without throwing, and the client is
    /// responsible for only ever drawing `"workout"`.
    func testTrendsMarkerDTODecodesUnknownKindWithoutFailing() throws {
        let json = """
        {"date": "2026-09-21", "kind": "weight_logged", "label": "Weigh-in", "count": 1}
        """.data(using: .utf8)!
        let dto = try JSONDecoder().decode(TrendsMarkerDTO.self, from: json)
        XCTAssertEqual(dto.kind, "weight_logged")
    }

    func testTrendsMarkersResponseDecodes() throws {
        let json = """
        {"days": 30, "markers": [{"date": "2026-09-20", "kind": "workout", "label": "Run", "count": 1}]}
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(TrendsMarkersResponse.self, from: json)
        XCTAssertEqual(response.days, 30)
        XCTAssertEqual(response.markers.count, 1)
        XCTAssertEqual(response.markers.first?.kind, "workout")
    }
}
