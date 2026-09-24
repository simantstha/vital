import XCTest
@testable import Vital

final class LogDeepLinkRouteTests: XCTestCase {

    // MARK: - mode=voice|text

    func testModeVoiceParsesToComposeVoice() {
        let url = URL(string: "vital://log?mode=voice")!
        XCTAssertEqual(LogDeepLinkRoute(url: url), .compose(.voice))
    }

    func testModeTextParsesToComposeText() {
        let url = URL(string: "vital://log?mode=text")!
        XCTAssertEqual(LogDeepLinkRoute(url: url), .compose(.text))
    }

    func testUnknownModeIsNil() {
        let url = URL(string: "vital://log?mode=barcode")!
        XCTAssertNil(LogDeepLinkRoute(url: url))
    }

    // MARK: - event=<id>

    func testEventParsesToEventCase() {
        let url = URL(string: "vital://log?event=abc-123")!
        XCTAssertEqual(LogDeepLinkRoute(url: url), .event("abc-123"))
    }

    func testEmptyEventIsNil() {
        let url = URL(string: "vital://log?event=")!
        XCTAssertNil(LogDeepLinkRoute(url: url))
    }

    // MARK: - Rejections

    func testWrongSchemeIsNil() {
        let url = URL(string: "https://log?mode=text")!
        XCTAssertNil(LogDeepLinkRoute(url: url))
    }

    func testWrongHostIsNil() {
        let url = URL(string: "vital://whoop?mode=text")!
        XCTAssertNil(LogDeepLinkRoute(url: url))
    }

    func testNoRecognizedQueryIsNil() {
        let url = URL(string: "vital://log")!
        XCTAssertNil(LogDeepLinkRoute(url: url))
    }

    // MARK: - id

    func testIdIsStableForComposeAndEvent() {
        XCTAssertEqual(LogDeepLinkRoute.compose(.voice).id, "compose:Voice")
        XCTAssertEqual(LogDeepLinkRoute.event("abc").id, "event:abc")
    }
}
