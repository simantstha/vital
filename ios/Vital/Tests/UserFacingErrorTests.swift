import XCTest
@testable import Vital

/// Pins the presentation-layer error mapping introduced to stop
/// `error.localizedDescription` (Apple's developer-facing copy, or our own
/// `"Server returned HTTP 500."`) from reaching real users. See
/// `docs/superpowers/plans/2026-09-05-user-facing-error-copy.md`.
final class UserFacingErrorTests: XCTestCase {

    // MARK: - Offline

    func testOfflineURLErrorProducesConnectionCopyNotServerCopy() {
        let error = URLError(.notConnectedToInternet)
        let read = UserFacingError.copy(for: error, context: .read)
        let write = UserFacingError.copy(for: error, context: .write)

        XCTAssertTrue(read.localizedCaseInsensitiveContains("offline") || read.localizedCaseInsensitiveContains("connection"))
        XCTAssertTrue(write.localizedCaseInsensitiveContains("offline") || write.localizedCaseInsensitiveContains("connection"))
        XCTAssertFalse(read.localizedCaseInsensitiveContains("server"))
        XCTAssertFalse(write.localizedCaseInsensitiveContains("server"))
    }

    // MARK: - Server 5xx

    func test500ProducesServerCopyWithNoStatusCodeOrRawString() {
        let copy = UserFacingError.copy(for: APIError.serverError(500), context: .read)
        XCTAssertFalse(copy.contains("500"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("HTTP"))
        XCTAssertFalse(copy.contains(APIError.serverError(500).errorDescription ?? "unreachable"))
    }

    func testServerErrorCopyDiffersByContext() {
        let read = UserFacingError.copy(for: APIError.serverError(503), context: .read)
        let write = UserFacingError.copy(for: APIError.serverError(503), context: .write)
        XCTAssertNotEqual(read, write)
    }

    // MARK: - Auth / session expired

    func testUnauthorizedProducesSignInCopyNotRetryCopy() {
        for code in [401, 403] {
            let copy = UserFacingError.copy(for: APIError.serverError(code), context: .read)
            XCTAssertTrue(copy.localizedCaseInsensitiveContains("session") || copy.localizedCaseInsensitiveContains("sign in"))
            XCTAssertFalse(copy.contains("\(code)"))
        }
    }

    // MARK: - Decoding / unrecognized

    func testDecodingErrorProducesGenericCopy() {
        let decodingError = DecodingError.dataCorrupted(
            DecodingError.Context(codingPath: [], debugDescription: "The data couldn't be read because it isn't in the correct format.")
        )
        let copy = UserFacingError.copy(for: decodingError, context: .read)
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("decod"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("json"))
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("correct format"))
    }

    func testDecodingErrorStillLogsFullDetail() {
        let decodingError = DecodingError.dataCorrupted(
            DecodingError.Context(codingPath: [], debugDescription: "corrupted payload marker")
        )
        var logged: String?
        _ = UserFacingError.message(for: decodingError, context: .read, tag: "test", log: { logged = $0 })

        XCTAssertNotNil(logged)
        XCTAssertTrue(logged?.contains("corrupted payload marker") ?? false, "raw error detail must still reach the log")
        XCTAssertTrue(logged?.contains("[Vital] test failed") ?? false)
    }

    // MARK: - Read vs write must differ (the copy constraint)

    func testGenericCopyDiffersBetweenReadAndWrite() {
        struct SomeOtherError: Error {}
        let read = UserFacingError.copy(for: SomeOtherError(), context: .read)
        let write = UserFacingError.copy(for: SomeOtherError(), context: .write)
        XCTAssertNotEqual(read, write, "a failed read and a failed write must not collapse into identical copy")
    }

    // MARK: - Already-human-safe APIError cases pass through unchanged

    func testAlreadyHumanSafeCasesPassThroughUnchanged() {
        XCTAssertEqual(
            UserFacingError.copy(for: APIError.barcodeNotFound, context: .read),
            APIError.barcodeNotFound.errorDescription
        )
        XCTAssertEqual(
            UserFacingError.copy(for: APIError.whoopAuthorizeURLMissing, context: .write),
            APIError.whoopAuthorizeURLMissing.errorDescription
        )
        XCTAssertEqual(
            UserFacingError.copy(for: APIError.whoopConnectFailed, context: .write),
            APIError.whoopConnectFailed.errorDescription
        )
    }

    // MARK: - Server-supplied text is untrusted

    func testCoachStreamErrorNeverPassesServerTextThroughVerbatim() {
        let maliciousOrJustWeirdServerText = "raw-backend-internal-detail-should-never-render"
        let copy = UserFacingError.copy(for: APIError.coachStreamError(maliciousOrJustWeirdServerText), context: .write)
        XCTAssertFalse(copy.contains(maliciousOrJustWeirdServerText))
    }

    // MARK: - .invalidURL must not leak the word "URL" to the user

    func testInvalidURLDoesNotLeakURLWord() {
        let copy = UserFacingError.copy(for: APIError.invalidURL, context: .read)
        XCTAssertFalse(copy.localizedCaseInsensitiveContains("url"))
    }

    // MARK: - Blanket assertion over the mapping's outputs

    /// The verification note in the spec calls this out explicitly: check
    /// this as an actual assertion, not by eye, so the next person who adds
    /// a case can't quietly reintroduce a leak.
    func testNoOutputEverLeaksImplementationDetail() {
        let sampleErrors: [Error] = [
            URLError(.notConnectedToInternet),
            URLError(.timedOut),
            URLError(.cannotFindHost),
            APIError.invalidURL,
            APIError.serverError(400),
            APIError.serverError(401),
            APIError.serverError(403),
            APIError.serverError(404),
            APIError.serverError(429),
            APIError.serverError(500),
            APIError.serverError(503),
            APIError.coachStreamError("some server text"),
            DecodingError.dataCorrupted(DecodingError.Context(codingPath: [], debugDescription: "bad JSON")),
            DecodingError.keyNotFound(
                CodingKeys.placeholder,
                DecodingError.Context(codingPath: [], debugDescription: "missing key")
            ),
        ]

        let bannedSubstrings = ["http", "decode", "json", "url"]
        let statusCodePattern = try! NSRegularExpression(pattern: "\\b\\d{3}\\b")

        for error in sampleErrors {
            for context in [ErrorContext.read, .write] {
                let copy = UserFacingError.copy(for: error, context: context)
                let lowered = copy.lowercased()

                for banned in bannedSubstrings {
                    XCTAssertFalse(
                        lowered.contains(banned),
                        "copy for \(error) [\(context)] leaked forbidden substring \"\(banned)\": \(copy)"
                    )
                }

                let range = NSRange(copy.startIndex..., in: copy)
                XCTAssertNil(
                    statusCodePattern.firstMatch(in: copy, range: range),
                    "copy for \(error) [\(context)] contains a bare 3-digit status code: \(copy)"
                )
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case placeholder
    }
}
