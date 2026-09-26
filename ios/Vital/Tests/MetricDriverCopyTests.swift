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

    // MARK: - sentence(driver:outcomeSpec:unitSystem:)

    func testSentenceLagZeroReadsThatDay() {
        let d = driver(lag: 0, direction: "up")
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.contains("that day"), text)
        XCTAssertFalse(text.contains("the next day"), text)
    }

    func testSentenceLagOneReadsTheNextDay() {
        let d = driver(lag: 1)
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.contains("the next day"), text)
    }

    func testSentenceDirectionDownReadsLower() {
        let d = driver(direction: "down")
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.contains("tends to be lower"), text)
    }

    func testSentenceDirectionUpReadsHigher() {
        let d = driver(direction: "up")
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.contains("tends to be higher"), text)
    }

    /// Names the high side of the input, e.g. "on days with higher steps".
    func testSentenceNamesHighSideOfInput() {
        let d = driver(input: "steps")
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.contains("higher steps"), text)
    }

    /// Input display name/unit come from `MetricCatalog`, not a hard-coded
    /// table — `steps` is a catalog metric.
    func testSentenceUsesCatalogDisplayNameForCatalogInput() {
        let d = driver(input: "steps")
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertEqual(MetricCatalog.spec(for: "steps")?.displayName.lowercased(), "steps")
        XCTAssertTrue(text.contains("higher steps"), text)
    }

    /// `dietary_carbs_g` has no `MetricCatalog` entry — must fall back
    /// gracefully rather than printing the raw key.
    func testSentenceFallsBackForNonCatalogDietInput() {
        let d = driver(input: "dietary_carbs_g", lag: 0, direction: "up")
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.contains("higher dietary carbs"), text)
        XCTAssertFalse(text.contains("dietary_carbs_g"), text)
    }

    /// Both `high` and `low` present → the concrete comparison is appended,
    /// high-input side first, in the outcome's own catalog unit/decimals.
    func testSentenceAppendsComparisonWhenBothBucketsPresent() {
        let d = driver(high: DriverBucketDTO(mean: 48, n: 21), low: DriverBucketDTO(mean: 56, n: 21))
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(text.contains("48 vs 56 ms"), text)
    }

    /// A null `high` (or `low`) omits the comparison clause entirely, rather
    /// than rendering a partial/misleading one.
    func testSentenceOmitsComparisonWhenHighIsNil() {
        let d = driver(high: nil, low: DriverBucketDTO(mean: 56, n: 21))
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertFalse(text.contains("vs"), text)
    }

    func testSentenceOmitsComparisonWhenLowIsNil() {
        let d = driver(high: DriverBucketDTO(mean: 48, n: 21), low: nil)
        let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertFalse(text.contains("vs"), text)
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
            let text = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric).lowercased()
            for word in forbidden {
                XCTAssertFalse(text.contains(word), "\(text) unexpectedly contains \"\(word)\"")
            }
        }
    }

    func testFooterCopy() {
        XCTAssertEqual(MetricDriverCopy.footer, "Patterns in your own data, not proof of cause.")
    }

    // MARK: - accessibilityLabel(driver:outcomeSpec:unitSystem:)

    func testAccessibilityLabelCombinesSentenceAndSampleSize() {
        let d = driver()
        let label = MetricDriverCopy.accessibilityLabel(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        let sentence = MetricDriverCopy.sentence(driver: d, outcomeSpec: Self.hrvSpec, unitSystem: .metric)
        XCTAssertTrue(label.hasPrefix(sentence), label)
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
