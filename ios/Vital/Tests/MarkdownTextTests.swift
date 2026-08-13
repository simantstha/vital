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

    func testParsingSameStringTwiceYieldsEqualBlocksWithEqualIds() {
        let markdown = """
        ## Heading

        First paragraph.

        - item one
        - item two
        """
        let first = MarkdownBlock.parse(markdown)
        let second = MarkdownBlock.parse(markdown)

        XCTAssertEqual(first, second)
        XCTAssertEqual(first.map(\.id), second.map(\.id))
    }

    /// Regression guard for the per-token identity churn that made the whole
    /// bubble flicker: growing the tail of a streaming reply must not change
    /// the id or text of any block that had already settled.
    func testAppendingToTailLeavesPrecedingBlockIdsAndValuesUnchanged() {
        let base = "## Heading\n\nFirst paragraph is done.\n\nSecond paragraph is st"
        let grown = base + "ill streaming in"

        let before = MarkdownBlock.parse(base)
        let after = MarkdownBlock.parse(grown)

        XCTAssertEqual(before.count, after.count)
        XCTAssertEqual(Array(before.dropLast()), Array(after.dropLast()))
        XCTAssertEqual(before.last?.id, after.last?.id)
        XCTAssertNotEqual(before.last?.text, after.last?.text)
    }
}
