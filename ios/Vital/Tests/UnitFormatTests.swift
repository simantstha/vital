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
        XCTAssertEqual(UnitFormat.height(cm: 167.6, .metric), "168\u{00A0}cm")
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
        XCTAssertEqual(UnitFormat.weight(kg: 62.5, .metric), "62.5\u{00A0}kg")
    }

    func testWeightImperialReproducesExistingProfileFormat() {
        XCTAssertEqual(UnitFormat.weight(kg: 70, .imperial), "154\u{00A0}lb")
    }

    func testWeightNilReturnsPlaceholder() {
        XCTAssertEqual(UnitFormat.weight(kg: nil, .metric), "--")
    }

    // MARK: - Distance

    func testDistanceMetresImperial() {
        XCTAssertEqual(UnitFormat.distance(metres: 8437, .imperial), "5.2\u{00A0}mi")
    }

    func testDistanceKmMetric() {
        XCTAssertEqual(UnitFormat.distance(km: 5, .metric), "5\u{00A0}km")
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

    // MARK: - Energy (kcal thousands separators)

    func testKcalGroupsThousandsLikeTodaysBudget() {
        let en = Locale(identifier: "en_US")
        XCTAssertEqual(UnitFormat.kcalNumber(1850, locale: en), "1,850")
        XCTAssertEqual(UnitFormat.kcalNumber(1020, locale: en), "1,020")
        XCTAssertEqual(UnitFormat.kcalNumber(999, locale: en), "999")
        XCTAssertEqual(UnitFormat.kcalNumber(0, locale: en), "0")
        // Same grouping Today's budget text gets from `Int.formatted()`.
        XCTAssertEqual(UnitFormat.kcalNumber(1850), Int(1850).formatted())
        XCTAssertEqual(UnitFormat.kcal(1850, locale: en), "1,850\u{00A0}kcal")
        XCTAssertEqual(UnitFormat.kcal(nil, locale: en), "--")
        XCTAssertEqual(UnitFormat.kcal(nil, locale: en, placeholder: "n/a"), "n/a")
    }

    // MARK: - Non-breaking number + unit

    /// "30" / "km/wk" must never strand on separate lines in a narrow row, so
    /// the display formatters join value and unit with U+00A0 — never U+0020.
    func testDisplayFormattersJoinNumberAndUnitWithNoBreakSpace() {
        let nb = "\u{00A0}"
        XCTAssertEqual(UnitFormat.nbsp, nb)
        XCTAssertEqual(UnitFormat.weight(kg: 61, .metric), "61\(nb)kg")
        XCTAssertEqual(UnitFormat.weight(kg: 61, .imperial), "134\(nb)lb")
        XCTAssertEqual(UnitFormat.height(cm: 168, .metric), "168\(nb)cm")
        XCTAssertEqual(UnitFormat.distance(km: 30, .metric), "30\(nb)km")
        XCTAssertEqual(UnitFormat.distance(metres: 8437, .imperial), "5.2\(nb)mi")
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: -0.6, .metric), "\u{2212}0.6\(nb)kg/wk")
        XCTAssertEqual(UnitFormat.weightDelta(kgPerWeek: -0.6, .imperial), "\u{2212}1.3\(nb)lb/wk")
        for text in [
            UnitFormat.weight(kg: 61, .metric), UnitFormat.weight(kg: 61, .imperial),
            UnitFormat.height(cm: 168, .metric), UnitFormat.distance(km: 30, .metric),
            UnitFormat.distance(km: 30, .imperial), UnitFormat.weightDelta(kgPerWeek: 0.4, .metric),
        ] {
            XCTAssertFalse(text.contains(" "), "plain space left in \(text.debugDescription)")
        }
    }

    /// The editable fields keep bare digits (no unit, no NBSP) and still parse,
    /// including a stray NBSP from pasted display text.
    func testEntryTextStaysBareDigitsAndParsesWithStrayNoBreakSpace() {
        for system in [UnitSystem.metric, .imperial] {
            let weightText = UnitFormat.weightEntryText(kg: 61, system)
            XCTAssertFalse(weightText.contains("\u{00A0}"))
            XCTAssertNotNil(Double(weightText), "weight entry text must be a bare number: \(weightText)")
            XCTAssertEqual(UnitFormat.kg(fromEntry: weightText, system) ?? 0, 61, accuracy: 0.5)

            let distanceText = UnitFormat.distanceEntryText(km: 30, system)
            XCTAssertFalse(distanceText.contains("\u{00A0}"))
            XCTAssertNotNil(Double(distanceText), "distance entry text must be a bare number: \(distanceText)")
            XCTAssertEqual(UnitFormat.km(fromDistanceEntry: distanceText, system) ?? 0, 30, accuracy: 0.5)
        }
        XCTAssertEqual(UnitFormat.kg(fromEntry: "\u{00A0}62,5\u{00A0}", .metric), 62.5)
        XCTAssertEqual(UnitFormat.kg(fromEntry: "62.5", .metric), 62.5)
        XCTAssertEqual(UnitFormat.km(fromDistanceEntry: " 30\u{00A0}", .metric), 30)
    }
}
