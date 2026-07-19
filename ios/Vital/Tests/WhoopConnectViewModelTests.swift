import XCTest
@testable import Vital

@MainActor
final class WhoopConnectViewModelTests: XCTestCase {

    // MARK: - WhoopStatusResponse decoding

    func testWhoopStatusResponseDecodesNotConnected() throws {
        let data = Data("""
        { "connected": false, "status": null, "last_synced_at": null }
        """.utf8)

        let response = try JSONDecoder().decode(WhoopStatusResponse.self, from: data)

        XCTAssertFalse(response.connected)
        XCTAssertNil(response.status)
        XCTAssertNil(response.lastSyncedAt)
    }

    func testWhoopStatusResponseDecodesConnectedWithLastSync() throws {
        let data = Data("""
        { "connected": true, "status": "active", "last_synced_at": "2026-07-19T08:00:00.000Z" }
        """.utf8)

        let response = try JSONDecoder().decode(WhoopStatusResponse.self, from: data)

        XCTAssertTrue(response.connected)
        XCTAssertEqual(response.status, "active")
        XCTAssertEqual(response.lastSyncedAt, "2026-07-19T08:00:00.000Z")
    }

    // MARK: - state(from:) mapping

    func testStateMapsDisconnectedResponseToNotConnected() {
        let response = WhoopStatusResponse(connected: false, status: nil, lastSyncedAt: nil)
        XCTAssertEqual(WhoopConnectViewModel.state(from: response), .notConnected)
    }

    func testStateMapsErrorStatusToNeedsReconnectEvenWhenConnectedTrue() {
        let response = WhoopStatusResponse(connected: true, status: "error", lastSyncedAt: nil)
        XCTAssertEqual(WhoopConnectViewModel.state(from: response), .needsReconnect)
    }

    func testStateMapsActiveStatusToConnectedWithParsedLastSync() {
        let response = WhoopStatusResponse(
            connected: true, status: "active", lastSyncedAt: "2026-07-19T08:00:00Z"
        )
        guard case .connected(let lastSyncedAt) = WhoopConnectViewModel.state(from: response) else {
            return XCTFail("expected .connected")
        }
        XCTAssertNotNil(lastSyncedAt)
    }

    func testStateMapsConnectedWithNilLastSyncToConnectedWithNilDate() {
        let response = WhoopStatusResponse(connected: true, status: "active", lastSyncedAt: nil)
        guard case .connected(let lastSyncedAt) = WhoopConnectViewModel.state(from: response) else {
            return XCTFail("expected .connected")
        }
        XCTAssertNil(lastSyncedAt)
    }

    // MARK: - lastSyncedLabel

    func testLastSyncedLabelReadsNotYetSyncedForNilDate() {
        XCTAssertEqual(WhoopConnectViewModel.lastSyncedLabel(nil), "Not yet synced")
    }

    func testLastSyncedLabelFormatsRelativeTimeAgo() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let threeHoursAgo = now.addingTimeInterval(-3 * 3600)
        let label = WhoopConnectViewModel.lastSyncedLabel(threeHoursAgo, now: now)
        XCTAssertTrue(label.hasPrefix("Last synced "), "unexpected label: \(label)")
        XCTAssertTrue(label.contains("3"), "expected a '3 hours ago'-style label, got: \(label)")
    }

    // MARK: - parseISODate

    func testParseISODateHandlesFractionalAndPlainFormats() {
        XCTAssertNotNil(WhoopConnectViewModel.parseISODate("2026-07-19T08:00:00.123Z"))
        XCTAssertNotNil(WhoopConnectViewModel.parseISODate("2026-07-19T08:00:00Z"))
        XCTAssertNil(WhoopConnectViewModel.parseISODate(nil))
        XCTAssertNil(WhoopConnectViewModel.parseISODate("not-a-date"))
    }

    // MARK: - WhoopCallbackResult(url:)

    func testCallbackResultParsesConnectedStatus() {
        let url = URL(string: "vital://whoop?status=connected")!
        XCTAssertEqual(WhoopCallbackResult(url: url), .connected)
    }

    func testCallbackResultParsesErrorStatus() {
        let url = URL(string: "vital://whoop?status=error")!
        XCTAssertEqual(WhoopCallbackResult(url: url), .error)
    }

    func testCallbackResultIsNilForWrongScheme() {
        let url = URL(string: "https://whoop?status=connected")!
        XCTAssertNil(WhoopCallbackResult(url: url))
    }

    func testCallbackResultIsNilForWrongHost() {
        let url = URL(string: "vital://oura?status=connected")!
        XCTAssertNil(WhoopCallbackResult(url: url))
    }

    func testCallbackResultIsNilForMissingOrUnknownStatus() {
        XCTAssertNil(WhoopCallbackResult(url: URL(string: "vital://whoop")!))
        XCTAssertNil(WhoopCallbackResult(url: URL(string: "vital://whoop?status=bogus")!))
    }

    // MARK: - APIClient.extractAuthorizeURL (redirect-interception result)

    func testExtractAuthorizeURLReadsLocationHeaderFrom302() throws {
        let response = HTTPURLResponse(
            url: URL(string: "http://localhost:3000/api/whoop/connect")!,
            statusCode: 302,
            httpVersion: nil,
            headerFields: ["Location": "https://api.prod.whoop.com/oauth/oauth2/auth?client_id=abc"]
        )!

        let authorizeURL = try APIClient.extractAuthorizeURL(from: response)

        XCTAssertEqual(authorizeURL.absoluteString, "https://api.prod.whoop.com/oauth/oauth2/auth?client_id=abc")
    }

    func testExtractAuthorizeURLThrowsWhenStatusIsNot302() {
        let response = HTTPURLResponse(
            url: URL(string: "http://localhost:3000/api/whoop/connect")!,
            statusCode: 401,
            httpVersion: nil,
            headerFields: ["Location": "https://api.prod.whoop.com/oauth/oauth2/auth"]
        )!

        XCTAssertThrowsError(try APIClient.extractAuthorizeURL(from: response)) { error in
            XCTAssertEqual(error as? APIError, APIError.whoopAuthorizeURLMissing)
        }
    }

    func testExtractAuthorizeURLThrowsWhenLocationHeaderMissing() {
        let response = HTTPURLResponse(
            url: URL(string: "http://localhost:3000/api/whoop/connect")!,
            statusCode: 302,
            httpVersion: nil,
            headerFields: [:]
        )!

        XCTAssertThrowsError(try APIClient.extractAuthorizeURL(from: response)) { error in
            XCTAssertEqual(error as? APIError, APIError.whoopAuthorizeURLMissing)
        }
    }

    // MARK: - RedirectInterceptingDelegate

    func testRedirectInterceptingDelegateCompletesWithNilToStopTheRedirect() {
        let delegate = RedirectInterceptingDelegate()
        let expectation = expectation(description: "completion called with nil")
        let redirectResponse = HTTPURLResponse(
            url: URL(string: "http://localhost:3000/api/whoop/connect")!,
            statusCode: 302,
            httpVersion: nil,
            headerFields: ["Location": "https://api.prod.whoop.com/oauth/oauth2/auth"]
        )!
        let newRequest = URLRequest(url: URL(string: "https://api.prod.whoop.com/oauth/oauth2/auth")!)
        let session = URLSession(configuration: .ephemeral)
        let task = session.dataTask(with: newRequest)

        delegate.urlSession(
            session, task: task, willPerformHTTPRedirection: redirectResponse, newRequest: newRequest
        ) { request in
            XCTAssertNil(request, "the redirect must be stopped, not followed")
            expectation.fulfill()
        }

        wait(for: [expectation], timeout: 1)
        task.cancel()
    }
}
