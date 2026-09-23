import XCTest
@testable import Vital

final class TrendsGoalOrderingTests: XCTestCase {

    private let allGroups: Set<MetricGroup> = Set(MetricGroup.allCases)

    // MARK: - groupOrder(for:available:) — every group present

    func testWeightLossPromotesActivityAheadOfRecoveryWhenAllGroupsAvailable() {
        let order = TrendsGoalOrdering.groupOrder(for: "weight_loss", available: allGroups)
        XCTAssertEqual(order, [.activity, .recovery, .sleep, .body, .whoop])
    }

    func testMuscleKeepsRecoveryFirstWhenAllGroupsAvailable() {
        // No protein/training-specific MetricGroup exists in the catalog —
        // recovery leads, per the plan's explicit fallback.
        let order = TrendsGoalOrdering.groupOrder(for: "muscle", available: allGroups)
        XCTAssertEqual(order, TrendsGoalOrdering.defaultOrder)
        XCTAssertEqual(order.first, .recovery)
    }

    func testEnduranceLeadsWithRecoveryThenSleepThenActivity() {
        let order = TrendsGoalOrdering.groupOrder(for: "endurance", available: allGroups)
        XCTAssertEqual(order, [.recovery, .sleep, .activity, .body, .whoop])
    }

    func testGeneralGoalKeepsTodaysOrderExactly() {
        let order = TrendsGoalOrdering.groupOrder(for: "general", available: allGroups)
        XCTAssertEqual(order, TrendsGoalOrdering.defaultOrder)
    }

    func testUnknownGoalFallsBackToDefaultOrderExactly() {
        let order = TrendsGoalOrdering.groupOrder(for: "some_future_goal", available: allGroups)
        XCTAssertEqual(order, TrendsGoalOrdering.defaultOrder)
    }

    func testEmptyGoalFallsBackToDefaultOrder() {
        let order = TrendsGoalOrdering.groupOrder(for: "", available: allGroups)
        XCTAssertEqual(order, TrendsGoalOrdering.defaultOrder)
    }

    // MARK: - Missing metrics — groups absent from `available` are skipped, never inserted empty

    func testWeightLossSkipsActivityEntirelyWhenNoActivityMetricsExist() {
        let available: Set<MetricGroup> = [.recovery, .sleep, .body, .whoop]
        let order = TrendsGoalOrdering.groupOrder(for: "weight_loss", available: available)
        XCTAssertEqual(order, [.recovery, .sleep, .body, .whoop])
        XCTAssertFalse(order.contains(.activity))
    }

    func testWeightLossWithOnlyActivityAvailableReturnsJustActivity() {
        let order = TrendsGoalOrdering.groupOrder(for: "weight_loss", available: [.activity])
        XCTAssertEqual(order, [.activity])
    }

    func testMuscleSkipsRecoveryWhenNoRecoveryMetricsExist() {
        let available: Set<MetricGroup> = [.sleep, .activity, .body]
        let order = TrendsGoalOrdering.groupOrder(for: "muscle", available: available)
        XCTAssertEqual(order, [.sleep, .activity, .body])
        XCTAssertFalse(order.contains(.recovery))
    }

    func testEnduranceWithOnlyBodyAndWhoopAvailableKeepsThatRelativeOrder() {
        let available: Set<MetricGroup> = [.whoop, .body]
        let order = TrendsGoalOrdering.groupOrder(for: "endurance", available: available)
        XCTAssertEqual(order, [.body, .whoop])
    }

    func testNoGroupsAvailableReturnsEmptyOrderForEveryGoal() {
        for goal in ["weight_loss", "muscle", "endurance", "general", ""] {
            XCTAssertEqual(TrendsGoalOrdering.groupOrder(for: goal, available: []), [], "goal: \(goal)")
        }
    }

    // MARK: - sections(for:available:) — reorders built sections, never invents or drops tiles

    private func section(_ group: MetricGroup, tileKeys: [String]) -> TrendsSection {
        TrendsSection(group: group, tiles: tileKeys.map { TrendsTile(key: $0, content: .sparse(value: 1, readingCount: 1)) })
    }

    func testSectionsReordersWeightLossActivityAheadOfRecoveryWithoutChangingTileContent() {
        let built = [
            section(.recovery, tileKeys: ["hrv_sdnn"]),
            section(.sleep, tileKeys: ["sleep_minutes"]),
            section(.activity, tileKeys: ["steps"]),
        ]
        let reordered = TrendsGoalOrdering.sections(for: "weight_loss", available: built)
        XCTAssertEqual(reordered.map(\.group), [.activity, .recovery, .sleep])
        XCTAssertEqual(reordered.first?.tiles.map(\.key), ["steps"])
    }

    func testSectionsForGeneralGoalPreservesTheBuiltOrderExactly() {
        let built = [
            section(.recovery, tileKeys: ["hrv_sdnn"]),
            section(.sleep, tileKeys: ["sleep_minutes"]),
            section(.activity, tileKeys: ["steps"]),
            section(.body, tileKeys: ["body_mass_kg"]),
        ]
        let reordered = TrendsGoalOrdering.sections(for: "general", available: built)
        XCTAssertEqual(reordered, built)
    }

    func testSectionsNeverInventsASectionThatWasNotBuilt() {
        // Only .sleep was built (e.g. every other metric hidden) — weight_loss's
        // priority list mentions .activity/.recovery first, but neither exists
        // here, so the result must be exactly the one built section.
        let built = [section(.sleep, tileKeys: ["sleep_minutes"])]
        let reordered = TrendsGoalOrdering.sections(for: "weight_loss", available: built)
        XCTAssertEqual(reordered.map(\.group), [.sleep])
    }

    func testSectionsWithEmptyBuiltInputReturnsEmpty() {
        for goal in ["weight_loss", "muscle", "endurance", "general"] {
            XCTAssertEqual(TrendsGoalOrdering.sections(for: goal, available: []), [], "goal: \(goal)")
        }
    }
}
