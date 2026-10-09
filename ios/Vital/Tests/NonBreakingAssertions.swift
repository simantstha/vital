import XCTest

extension XCTestCase {

    /// Units whose number+unit pairs must be glued with U+00A0 (see
    /// `UnitFormat.nbsp`). "m" only matches as a whole word ("800 m"), never
    /// the start of "more"/"months".
    static let glueableUnits = [
        "kg", "lb", "km", "mi", "cm", "m", "t", "wk", "wks", "week", "weeks", "kcal", "bpm", "ms", "min",
    ]

    /// Fails when `text` has a plain, breakable space between a digit and one
    /// of `glueableUnits` ("140 kg", "11.5k lb", "4 wk"), or on either side of
    /// an arrow next to a digit ("153 → 163"). Wrapping may then only happen
    /// BETWEEN number+unit tokens, never inside one.
    func assertNoBreakableUnitSpace(
        _ text: String,
        units: [String] = XCTestCase.glueableUnits,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let alternation = units.joined(separator: "|")
        let patterns = [
            "[0-9]k? (\(alternation))\\b",
            "[0-9] \u{2192}",
            "\u{2192} [0-9]",
        ]
        for pattern in patterns {
            if let range = text.range(of: pattern, options: .regularExpression) {
                XCTFail(
                    "breakable space inside a value+unit token \"\(text[range])\" in \(text.debugDescription)",
                    file: file, line: line
                )
            }
        }
    }
}
