import XCTest
@testable import Vital

/// Roadmap 1.1 / ux-spec-v4 §10 row P1: the Coach composer's starter chips
/// are goal-aware instead of a fixed marathon-flavored list. `CoachStarterChips`
/// is a pure function of the user's diet goal (`weight_loss | muscle |
/// endurance | general`, `DietBudgetDTO.goal`'s vocabulary), so it's tested
/// directly with no view or view-model involved.
final class CoachStarterChipsTests: XCTestCase {
    func testWeightLossGoalGetsTrackingNutritionAndWeighInChips() {
        XCTAssertEqual(
            CoachStarterChips.chips(for: "weight_loss"),
            [
                "How am I tracking this week?",
                "What should I eat for dinner?",
                "Log my weigh-in",
            ]
        )
    }

    func testMuscleGoalGetsTrainingProteinAndWorkoutChips() {
        XCTAssertEqual(
            CoachStarterChips.chips(for: "muscle"),
            [
                "What should I train today?",
                "Am I eating enough protein?",
                "Log my workout",
            ]
        )
    }

    func testEnduranceGoalGetsSessionRecoveryAndWeekChips() {
        XCTAssertEqual(
            CoachStarterChips.chips(for: "endurance"),
            [
                "Plan tomorrow's session",
                "Am I recovered?",
                "How was my week?",
            ]
        )
    }

    func testGeneralGoalGetsGenericChips() {
        XCTAssertEqual(
            CoachStarterChips.chips(for: "general"),
            [
                "How am I doing today?",
                "What should I eat for dinner?",
                "Give me a quick win",
            ]
        )
    }

    func testUnknownGoalFallsBackToGeneralChips() {
        XCTAssertEqual(
            CoachStarterChips.chips(for: "lose_fat"),
            CoachStarterChips.chips(for: "general")
        )
    }

    func testNilGoalFallsBackToGeneralChips() {
        XCTAssertEqual(
            CoachStarterChips.chips(for: nil),
            CoachStarterChips.chips(for: "general")
        )
    }

    func testEveryGoalReturnsExactlyThreeChips() {
        for goal in ["weight_loss", "muscle", "endurance", "general", nil] {
            XCTAssertEqual(CoachStarterChips.chips(for: goal).count, 3, "goal: \(goal ?? "nil")")
        }
    }
}
