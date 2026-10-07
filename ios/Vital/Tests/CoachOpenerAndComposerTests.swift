import XCTest
@testable import Vital

/// Coach-first-impression fix: two pure, `nonisolated` rules lifted out of
/// `CoachViewModel`/`CoachView` so they're directly unit-testable with no
/// `@MainActor` hop, mock API, or view involved.
final class CoachOpenerAndComposerTests: XCTestCase {

    // MARK: - Offline banner

    func testOfflineBannerCopyReassuresAboutData() {
        XCTAssertTrue(CoachViewModel.offlineBannerText.contains("Coach is offline"))
        XCTAssertTrue(CoachViewModel.offlineBannerText.contains("your data is safe"))
    }

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

    // MARK: - Goal-aware openers

    private let en = Locale(identifier: "en_US")

    private var now: Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: DateComponents(year: 2026, month: 10, day: 6, hour: 12))!
    }

    private func progress(
        goal: String = "weight_loss",
        verdict: GoalVerdict = .onTrack,
        eta: String? = "2026-12-10",
        targetKg: Double? = 76,
        headline: String = "On track — about 6 kg to go, around Dec 10"
    ) -> GoalProgressDTO {
        GoalProgressDTO(
            goal: goal,
            target: .init(weightKg: targetKg, date: "2026-12-24", weeklySessions: nil),
            current: .init(weightKg: 82.0, startWeightKg: 83.7, changeKg: -1.7, progressPct: 22),
            ratePerWeek: .init(kg: -0.6, pctBodyweight: -0.73),
            safeBand: .init(minPct: 0.25, maxPct: 1),
            eta: eta,
            onPaceForTargetDate: true,
            verdict: verdict,
            headline: headline,
            reasons: [],
            dataSufficiency: .init(weighIns: 11, needed: 3, sessionsLast28d: 0)
        )
    }

    func testNewUserFallbackStatesTheOnboardingGoalInsteadOfAskingForIt() {
        let text = CoachViewModel.fallbackOpenerText(isVerifiedNewConversation: true, goal: "weight_loss")
        XCTAssertTrue(text.hasPrefix("Your goal is to lose weight."), text)
        XCTAssertTrue(text.contains("want to set a target weight?"), text)
        XCTAssertFalse(text.contains("Tell me your goal"), text)
    }

    func testNewUserFallbackWithUnknownGoalKeepsGenericOpener() {
        XCTAssertEqual(
            CoachViewModel.fallbackOpenerText(isVerifiedNewConversation: true, goal: nil),
            CoachViewModel.newUserFallbackOpener
        )
        XCTAssertEqual(
            CoachViewModel.fallbackOpenerText(isVerifiedNewConversation: true, goal: "mystery"),
            CoachViewModel.newUserFallbackOpener
        )
    }

    func testUnverifiedConversationIgnoresGoal() {
        XCTAssertEqual(
            CoachViewModel.fallbackOpenerText(isVerifiedNewConversation: false, goal: "weight_loss"),
            CoachViewModel.returningFallbackOpener
        )
    }

    func testNewUserGoalOpenerCoversEveryGoal() {
        XCTAssertTrue(CoachViewModel.newUserGoalOpener(goal: "muscle")?.hasPrefix("Your goal is to build muscle.") == true)
        XCTAssertTrue(CoachViewModel.newUserGoalOpener(goal: "endurance")?.hasPrefix("Your goal is to build endurance.") == true)
        XCTAssertTrue(CoachViewModel.newUserGoalOpener(goal: "general")?.hasPrefix("Your goal is general health.") == true)
        XCTAssertNil(CoachViewModel.newUserGoalOpener(goal: nil))
    }

    func testGoalStatusOpenerStatesAmountAndPaceInKg() {
        XCTAssertEqual(
            CoachViewModel.goalStatusOpener(progress(), system: .metric, now: now, locale: en),
            "You're 1.7 of 7.7 kg down and about 2 weeks ahead of your Dec 24 target. What would you like to dig into?"
        )
    }

    func testGoalStatusOpenerConvertsToPounds() {
        let text = CoachViewModel.goalStatusOpener(progress(), system: .imperial, now: now, locale: en) ?? ""
        XCTAssertTrue(text.hasPrefix("You're 3.7 of 17 lb down"), text)
    }

    func testGoalStatusOpenerOmitsPaceWithoutEta() {
        XCTAssertEqual(
            CoachViewModel.goalStatusOpener(progress(eta: nil), system: .metric, now: now, locale: en),
            "You're 1.7 of 7.7 kg down. What would you like to dig into?"
        )
    }

    func testGoalStatusOpenerFallsBackToHeadlineForNonWeightGoals() {
        let p = progress(goal: "endurance", verdict: .building, targetKg: nil, headline: "Building — distance up 12%")
        XCTAssertEqual(
            CoachViewModel.goalStatusOpener(p, system: .metric, now: now, locale: en),
            "Goal check-in: Building — distance up 12%. What would you like to dig into?"
        )
    }

    func testGoalStatusOpenerIsNilWithoutRealProgress() {
        XCTAssertNil(CoachViewModel.goalStatusOpener(progress(verdict: .needsTarget), system: .metric, now: now, locale: en))
        XCTAssertNil(CoachViewModel.goalStatusOpener(progress(verdict: .insufficientData), system: .metric, now: now, locale: en))
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
