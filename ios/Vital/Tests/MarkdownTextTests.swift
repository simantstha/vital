import XCTest
@testable import Vital

final class MarkdownTextTests: XCTestCase {
    func testParseRendersHeadingsWithoutMarkdownMarkers() {
        let blocks = MarkdownBlock.parse("""
        ## Carb Loading for Sunday's 15-Miler

        ### Your Timeline
        Short answer: **start tonight**.
        """)

        XCTAssertEqual(blocks.map(\.kind), [
            .heading(level: 2),
            .heading(level: 3),
            .paragraph,
        ])
        XCTAssertEqual(blocks.map(\.text), [
            "Carb Loading for Sunday's 15-Miler",
            "Your Timeline",
            "Short answer: **start tonight**.",
        ])
    }

    func testParseTreatsHorizontalRulesAsDividers() {
        let blocks = MarkdownBlock.parse("""
        First paragraph.

        ---

        Second paragraph.
        """)

        XCTAssertEqual(blocks.map(\.kind), [
            .paragraph,
            .divider,
            .paragraph,
        ])
        XCTAssertEqual(blocks.map(\.text), [
            "First paragraph.",
            "",
            "Second paragraph.",
        ])
    }
}
