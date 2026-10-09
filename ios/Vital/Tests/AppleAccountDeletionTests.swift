import AuthenticationServices
import XCTest
@testable import Vital

/// Fake `AppleAuthorizing` — never presents a system sheet.
@MainActor
private final class FakeAppleAuthorizer: AppleAuthorizing {
    private let result: Result<String, Error>
    private(set) var callCount = 0

    init(_ result: Result<String, Error>) { self.result = result }

    func requestAuthorizationCode() async throws -> String {
        callCount += 1
        return try result.get()
    }
}

private struct SomeAppleFailure: Error {}

@MainActor
final class AppleAccountDeletionTests: XCTestCase {

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: SignInMethod.defaultsKey)
        super.tearDown()
    }

    // MARK: - AppleDeletionGate

    func testNonAppleSignInProceedsWithoutCodeAndNeverAsksApple() async {
        let authorizer = FakeAppleAuthorizer(.success("code"))

        let decision = await AppleDeletionGate.decide(usesAppleSignIn: false, authorizer: authorizer)

        XCTAssertEqual(decision, .proceed(appleAuthorizationCode: nil))
        XCTAssertEqual(authorizer.callCount, 0)
    }

    func testAppleSuccessProceedsWithTheCode() async {
        let authorizer = FakeAppleAuthorizer(.success("fresh-code"))

        let decision = await AppleDeletionGate.decide(usesAppleSignIn: true, authorizer: authorizer)

        XCTAssertEqual(decision, .proceed(appleAuthorizationCode: "fresh-code"))
        XCTAssertEqual(authorizer.callCount, 1)
    }

    func testBlankCodeProceedsWithoutCode() async {
        let authorizer = FakeAppleAuthorizer(.success("  \n"))

        let decision = await AppleDeletionGate.decide(usesAppleSignIn: true, authorizer: authorizer)

        XCTAssertEqual(decision, .proceed(appleAuthorizationCode: nil))
    }

    func testUserCancelAbortsTheDeletion() async {
        let authorizer = FakeAppleAuthorizer(.failure(AppleReauthError.cancelled))

        let decision = await AppleDeletionGate.decide(usesAppleSignIn: true, authorizer: authorizer)

        XCTAssertEqual(decision, .abort)
    }

    func testRawAppleCanceledErrorAlsoAborts() async {
        let authorizer = FakeAppleAuthorizer(.failure(ASAuthorizationError(.canceled)))

        let decision = await AppleDeletionGate.decide(usesAppleSignIn: true, authorizer: authorizer)

        XCTAssertEqual(decision, .abort)
    }

    func testTaskCancellationAborts() async {
        let authorizer = FakeAppleAuthorizer(.failure(CancellationError()))

        let decision = await AppleDeletionGate.decide(usesAppleSignIn: true, authorizer: authorizer)

        XCTAssertEqual(decision, .abort)
    }

    func testOtherAppleFailuresProceedWithoutCode() async {
        let failures: [Error] = [
            AppleReauthError.failed,
            ASAuthorizationError(.failed),
            ASAuthorizationError(.unknown),
            SomeAppleFailure(),
        ]
        for failure in failures {
            let authorizer = FakeAppleAuthorizer(.failure(failure))

            let decision = await AppleDeletionGate.decide(usesAppleSignIn: true, authorizer: authorizer)

            XCTAssertEqual(
                decision, .proceed(appleAuthorizationCode: nil),
                "a non-cancel Apple failure must not trap the user: \(failure)"
            )
            XCTAssertEqual(authorizer.callCount, 1)
        }
    }

    // MARK: - AppleReauthError.classify

    func testClassifyMapsCancelAndEverythingElse() {
        XCTAssertEqual(AppleReauthError.classify(ASAuthorizationError(.canceled)), .cancelled)
        XCTAssertEqual(AppleReauthError.classify(ASAuthorizationError(.failed)), .failed)
        XCTAssertEqual(AppleReauthError.classify(ASAuthorizationError(.notHandled)), .failed)
        XCTAssertEqual(AppleReauthError.classify(SomeAppleFailure()), .failed)
        XCTAssertEqual(
            AppleReauthError.classify(NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.canceled.rawValue)),
            .cancelled
        )
    }

    // MARK: - SignInMethod

    func testResolveUsesStoredMethod() {
        XCTAssertEqual(SignInMethod.resolve(stored: "apple", isDebugBuild: true), .apple)
        XCTAssertEqual(SignInMethod.resolve(stored: "dev", isDebugBuild: false), .dev)
    }

    func testResolveDefaultsLegacySessionsByBuildType() {
        // Release: dev sign-in is compiled out, so a legacy session is Apple.
        XCTAssertEqual(SignInMethod.resolve(stored: nil, isDebugBuild: false), .apple)
        // Debug: never surprise a simulator/dev run with an Apple sheet.
        XCTAssertEqual(SignInMethod.resolve(stored: nil, isDebugBuild: true), .dev)
        XCTAssertEqual(SignInMethod.resolve(stored: "garbage", isDebugBuild: false), .apple)
    }

    // MARK: - Request body

    func testDeleteAccountBodyEncodesTheAppleCode() throws {
        let data = try XCTUnwrap(APIClient.deleteAccountBody(appleAuthorizationCode: "abc.def"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(json, ["appleAuthorizationCode": "abc.def"])
    }

    func testDeleteAccountBodyIsNilWithoutACode() {
        XCTAssertNil(APIClient.deleteAccountBody(appleAuthorizationCode: nil))
        XCTAssertNil(APIClient.deleteAccountBody(appleAuthorizationCode: ""))
    }

    // MARK: - AccountDeletionError copy

    func testNeedsAppleConfirmationMessageLeadsWithRequiredCopy() {
        let message = AccountDeletionError.needsAppleConfirmation.userMessage
        XCTAssertTrue(message.hasPrefix("Deletion needs Apple confirmation"), message)
        XCTAssertTrue(message.contains("not deleted"), message)
    }

    // MARK: - AuthViewModel wiring

    /// Cancelling the Apple sheet must throw before any network call and leave
    /// the session intact (nothing deleted, still signed in).
    func testAuthViewModelDeleteAccountThrowsAndKeepsSessionWhenAppleIsCancelled() async {
        UserDefaults.standard.set(SignInMethod.apple.rawValue, forKey: SignInMethod.defaultsKey)
        let authorizer = FakeAppleAuthorizer(.failure(AppleReauthError.cancelled))
        let viewModel = AuthViewModel(appleAuthorizer: authorizer)
        let wasAuthenticated = viewModel.isAuthenticated

        do {
            try await viewModel.deleteAccount()
            XCTFail("expected deleteAccount to throw when Apple confirmation is cancelled")
        } catch let error as AccountDeletionError {
            XCTAssertEqual(error, .needsAppleConfirmation)
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        XCTAssertEqual(authorizer.callCount, 1)
        XCTAssertEqual(viewModel.isAuthenticated, wasAuthenticated)
        XCTAssertEqual(viewModel.signInMethod, .apple, "cancelled deletion must keep the session's method")
    }
}
