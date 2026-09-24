import XCTest
@testable import Vital

/// Coach-first-impression fix: two pure, `nonisolated` rules lifted out of
/// `CoachViewModel`/`CoachView` so they're directly unit-testable with no
/// `@MainActor` hop, mock API, or view involved.
final class CoachOpenerAndComposerTests: XCTestCase {

    // MARK: - Opener fallback selection

    /// A verified fresh conversation (restoration succeeded and found no
    /// history to restore) must not get the returning-user greeting — there's
    /// no history yet to reference.
    func testVerifiedNewConversationGetsNewUserOpener() {
        XCTAssertEqual(
            CoachViewModel.fallbackOpenerText(isVerifiedNewConversation: true),
            CoachViewModel.newUserFallbackOpener
        )
    }

    /// When restoration itself failed (older/feature-flagged backend), new
    /// vs. returning is unknown — falls back to the original neutral
    /// greeting rather than assuming either state.
    func testUnverifiedConversationGetsReturningUserOpener() {
        XCTAssertEqual(
            CoachViewModel.fallbackOpenerText(isVerifiedNewConversation: false),
            CoachViewModel.returningFallbackOpener
        )
    }

    func testNewAndReturningFallbackOpenersAreDistinct() {
        XCTAssertNotEqual(
            CoachViewModel.newUserFallbackOpener,
            CoachViewModel.returningFallbackOpener
        )
    }

    /// The customer-panel regression this fix targets: the new-user fallback
    /// must never read as praise for history the user doesn't have.
    func testNewUserFallbackNeverPraisesConsistency() {
        XCTAssertFalse(CoachViewModel.newUserFallbackOpener.contains("Nice work staying consistent"))
    }

    // MARK: - Send-enabled rule

    func testEmptyInputIsNotSendable() {
        XCTAssertFalse(CoachViewModel.isSendableInput(""))
    }

    func testWhitespaceOnlyInputIsNotSendable() {
        XCTAssertFalse(CoachViewModel.isSendableInput("   "))
        XCTAssertFalse(CoachViewModel.isSendableInput("\n\t "))
    }

    func testNonEmptyInputIsSendable() {
        XCTAssertTrue(CoachViewModel.isSendableInput("How am I doing today?"))
    }

    func testInputWithSurroundingWhitespaceIsSendable() {
        XCTAssertTrue(CoachViewModel.isSendableInput("  hi  "))
    }
}
