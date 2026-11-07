import XCTest
@testable import Vital

/// `EnduranceHeroLogic.sessionOutsideTimeline` — the endurance hero shows
/// today's session only when the "Rest of today" timeline has dropped it.
final class EnduranceSessionOutsideTimelineTests: XCTestCase {

    private func item(id: String, status: PlanItem.Status = .later, title: String = "10km tempo run") -> PlanItem {
        PlanItem(
            id: id, timeMinutes: 600, title: title, subtitle: "",
            sfSymbol: "figure.run", status: status, source: .coach, kind: .move
        )
    }

    func testNilSessionReturnsNil() {
        let upcoming = [item(id: "other")]
        XCTAssertNil(EnduranceHeroLogic.sessionOutsideTimeline(session: nil, upcoming: upcoming))
    }

    func testSessionInUpcomingReturnsNil() {
        let session = item(id: "run")
        let upcoming = [item(id: "meal", status: .next), session]
        XCTAssertNil(EnduranceHeroLogic.sessionOutsideTimeline(session: session, upcoming: upcoming))
    }

    func testSessionAbsentFromUpcomingReturnsSession() {
        let session = item(id: "run")
        let upcoming = [item(id: "meal", status: .next)]
        XCTAssertEqual(EnduranceHeroLogic.sessionOutsideTimeline(session: session, upcoming: upcoming), session)
    }

    func testDoneSessionAbsentFromUpcomingReturnsSession() {
        let session = item(id: "run", status: .done)
        XCTAssertEqual(EnduranceHeroLogic.sessionOutsideTimeline(session: session, upcoming: []), session)
    }

    func testHasHeroContentCountsSessionOutsideTimeline() {
        let session = item(id: "run", status: .done)
        XCTAssertTrue(EnduranceHeroLogic.hasHeroContent(
            calibratingText: nil, raceText: nil, hasSession: true,
            reconciliationText: nil, hasWeekRow: false, sessionOutsideTimeline: session
        ))
    }

    func testHasHeroContentFalseWithoutSessionOutsideTimeline() {
        XCTAssertFalse(EnduranceHeroLogic.hasHeroContent(
            calibratingText: nil, raceText: nil, hasSession: true,
            reconciliationText: nil, hasWeekRow: false, sessionOutsideTimeline: nil
        ))
    }
}
