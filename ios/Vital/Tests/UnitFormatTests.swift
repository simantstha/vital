import XCTest
@testable import Vital

final class UnitFormatTests: XCTestCase {

    // MARK: - UnitConvert round-trip

    func testKgLbRoundTrip() {
        let kg = 70.0
        let lb = UnitConvert.kgToLb(kg)
        XCTAssertEqual(UnitConvert.lbToKg(lb), kg, accuracy: 0.0001)
    }

    // MARK: - Height

    func testHeightPartsRoundsTotalInchesBeforeSplitting() {
        // 182.88cm is exactly 72 inches — must land on (6, 0), never (5, 12)
        // from rounding a feet quotient and inches remainder independently.
        let parts = UnitFormat.heightParts(cm: 182.88)
        XCTAssertEqual(parts.feet, 6)
        XCTAssertEqual(parts.inches, 0)
    }

    func testHeightMetricReproducesExistingProfileFormat() {
        XCTAssertEqual(UnitFormat.height(cm: 167.6, .metric), "168 cm")
    }

    func testHeightImperialFormat() {
        XCTAssertEqual(UnitFormat.height(cm: 167.6, .imperial), "5' 6\"")
    }

    func testHeightImperialReproducesExistingProfileFormat() {
        XCTAssertEqual(UnitFormat.height(cm: 175.3, .imperial), "5' 9\"")
    }

    func testHeightNilReturnsPlaceholder() {
        XCTAssertEqual(UnitFormat.height(cm: nil, .metric), "--")
        XCTAssertEqual(UnitFormat.height(cm: nil, .imperial, placeholder: "n/a"), "n/a")
    }

    // MARK: - Weight

    func testWeightMetricReproducesExistingProfileFormat() {
        XCTAssertEqual(UnitFormat.weight(kg: 62.5, .metric), "62.5 kg")
    }

    func testWeightImperialReproducesExistingProfileFormat() {
        XCTAssertEqual(UnitFormat.weight(kg: 70, .imperial), "154 lb")
    }

    func testWeightNilReturnsPlaceholder() {
        XCTAssertEqual(UnitFormat.weight(kg: nil, .metric), "--")
    }

    // MARK: - Distance

    func testDistanceMetresImperial() {
        XCTAssertEqual(UnitFormat.distance(metres: 8437, .imperial), "5.2 mi")
    }

    func testDistanceKmMetric() {
        XCTAssertEqual(UnitFormat.distance(km: 5, .metric), "5 km")
    }

    func testDistanceNilReturnsPlaceholder() {
        XCTAssertEqual(UnitFormat.distance(metres: nil, .metric), "--")
        XCTAssertEqual(UnitFormat.distance(km: nil, .imperial), "--")
    }

    // MARK: - Pace

    func testPaceImperialMultipliesByKmPerMile() {
        XCTAssertEqual(UnitFormat.pace(minPerKm: 5.383, .imperial), "8′40″")
    }

    func testPaceMetricCarriesSixtySecondsIntoNextMinute() {
        XCTAssertEqual(UnitFormat.pace(minPerKm: 5.999, .metric), "6′00″")
    }

    // MARK: - Entry-field text

    func testWeightEntryTextRoundTripsThroughKgFromEntry() {
        let text = UnitFormat.weightEntryText(kg: 70, .imperial)
        XCTAssertEqual(text, "154")
        let kg = UnitFormat.kg(fromEntry: text, .imperial)
        XCTAssertEqual(kg ?? 0, 70, accuracy: 0.5)
    }

    func testWeightEntryTextNilReturnsEmptyString() {
        XCTAssertEqual(UnitFormat.weightEntryText(kg: nil, .metric), "")
    }

    func testKgFromEntryAcceptsCommaDecimalSeparator() {
        XCTAssertEqual(UnitFormat.kg(fromEntry: "62,5", .metric), 62.5)
    }

    func testKgFromEntryReturnsNilForUnparseableInput() {
        XCTAssertNil(UnitFormat.kg(fromEntry: "not a number", .metric))
    }
}
