import XCTest
@testable import Vital

/// Tests for ChatCopy.copyableText(_:) markdown stripping functionality.
/// Ensures that pasted text from Coach messages is clean and readable.
final class ChatCopyTests: XCTestCase {
    func testRemovesBoldAsterisks() {
        let input = "This is **bold text** here"
        let expected = "This is bold text here"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testRemovesUnderscoreBold() {
        let input = "This is __bold__ text"
        let expected = "This is bold text"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testRemovesBackticks() {
        let input = "Use `code` in your text"
        let expected = "Use code in your text"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testRemovesMultipleBackticks() {
        let input = "Call `function()` or use `variable`"
        let expected = "Call function() or use variable"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testConvertsDashBulletToUnicode() {
        let input = "- First item\n- Second item"
        let expected = "• First item\n• Second item"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testConvertsAsteriskBulletToUnicode() {
        let input = "* First item\n* Second item"
        let expected = "• First item\n• Second item"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testHandlesBulletsWithExtraWhitespace() {
        let input = "-  Item with spaces\n  *    Another item"
        let expected = "• Item with spaces\n• Another item"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testTrimsWhitespace() {
        let input = "  \n  Some text  \n  "
        let expected = "Some text"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testPlainTextUnchanged() {
        let input = "This is plain text with no formatting"
        let expected = "This is plain text with no formatting"
        XCTAssertEqual(ChatCopy.copyableText(input), expected)
    }

    func testComplexMarkdownRemoved() {
        let input = """
        Here are some tips:
        - **Tip 1**: Use `code` when needed
        - __Tip 2__: Keep it simple
        * `Important`: Always test
        """
        let result = ChatCopy.copyableText(input)
        XCTAssertFalse(result.contains("**"))
        XCTAssertFalse(result.contains("__"))
        XCTAssertFalse(result.contains("`"))
        XCTAssertTrue(result.contains("• Tip 1"))
        XCTAssertTrue(result.contains("• Tip 2"))
        XCTAssertTrue(result.contains("• Important"))
    }

    func testEmptyStringReturnsEmpty() {
        XCTAssertEqual(ChatCopy.copyableText(""), "")
    }

    func testOnlyWhitespaceReturnsEmpty() {
        XCTAssertEqual(ChatCopy.copyableText("   \n  \t  "), "")
    }
}
