import XCTest
@testable import Vital

/// A pending plan item more than 45 min in the past reads EARLIER (neutral —
/// we have no signal it was missed), not LATER; hero/Next up skip it.
@MainActor
final class PlanEarlierStatusTests: XCTestCase {

    private func item(_ id: String, _ minutes: Int, kind: PlanItem.Kind = .move,
                      status: PlanItem.Status = .later) -> PlanItem {
        PlanItem(id: id, timeMinutes: minutes, title: id, subtitle: "",
                 sfSymbol: "circle", status: status, source: .coach, kind: kind)
    }

    func testMissedFivePMRunReadsEarlierAtSevenPM() {
        let out = TodayViewModel.computeStatuses([item("run", 17 * 60)], nowMinutes: 19 * 60)
        XCTAssertEqual(out.first?.status, .earlier)
        XCTAssertEqual(PlanItem.Status.earlier.label, "Earlier")
    }

    func testWindowBoundariesAndFutureStatusesUnchanged() {
        let items = [item("past", 17 * 60), item("edge", 18 * 60 + 15), item("next", 21 * 60), item("later", 22 * 60),
                     item("done", 8 * 60, status: .done)]
        let out = Dictionary(uniqueKeysWithValues:
            TodayViewModel.computeStatuses(items, nowMinutes: 19 * 60).map { ($0.id, $0.status) })
        XCTAssertEqual(out["past"], .earlier)
        XCTAssertEqual(out["edge"], .now)
        XCTAssertEqual(out["next"], .next)
        XCTAssertEqual(out["later"], .later)
        XCTAssertEqual(out["done"], .done)
    }

    func testHeroSessionPrefersUpcomingOverEarlier() {
        let items = [item("am", 8 * 60, status: .earlier), item("pm", 18 * 60, status: .next)]
        XCTAssertEqual(MuscleHeroLogic.todaySession(from: items)?.id, "pm")
        XCTAssertEqual(EnduranceHeroLogic.todaySession(from: items)?.id, "pm")
    }

    func testHeroSessionFallsBackToEarlierWhenNothingElse() {
        let items = [item("am", 8 * 60, status: .earlier)]
        XCTAssertEqual(MuscleHeroLogic.todaySession(from: items)?.id, "am")
    }

    func testNextUpSkipsEarlierItem() {
        let items = [item("past", 8 * 60, kind: .meal, status: .earlier),
                     item("soon", 20 * 60, kind: .meal, status: .next)]
        XCTAssertEqual(WeightHeroLogic.nextUpItem(from: items, nowMinutes: 19 * 60)?.id, "soon")
    }
}
