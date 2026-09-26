import XCTest
@testable import Vital

/// Covers `APIClient.validate(_:)` — the single choke point every request
/// (including the notification/push endpoints that used to bypass it, see
/// `ProactiveNotifications.swift`) now routes 401 handling through.
final class APIClientValidateTests: XCTestCase {

    private func makeResponse(statusCode: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "https://vital-coach.fly.dev/api/notifications")!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: nil
        )!
    }

    func testValidateThrowsAndPostsSessionExpiredOn401() {
        let expectation = expectation(forNotification: .vitalSessionExpired, object: nil)

        XCTAssertThrowsError(try APIClient.shared.validate(makeResponse(statusCode: 401))) { error in
            guard case APIError.serverError(let status) = error else {
                return XCTFail("Expected APIError.serverError, got \(error)")
            }
            XCTAssertEqual(status, 401)
        }

        wait(for: [expectation], timeout: 1)
    }

    func testValidateThrowsWithoutPostingSessionExpiredOnOtherServerError() {
        let notPosted = expectation(forNotification: .vitalSessionExpired, object: nil)
        notPosted.isInverted = true

        XCTAssertThrowsError(try APIClient.shared.validate(makeResponse(statusCode: 500)))

        wait(for: [notPosted], timeout: 0.3)
    }

    func testValidateDoesNotThrowOnSuccess() {
        XCTAssertNoThrow(try APIClient.shared.validate(makeResponse(statusCode: 200)))
    }
}
