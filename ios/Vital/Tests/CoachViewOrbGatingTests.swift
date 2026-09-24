import XCTest
@testable import Vital

/// Coverage for the `CoachView.showsConversationOrb` helper that gates when
/// the `CoachOrb` replaces the composer. The helper ensures the mic button
/// remains mounted while pressed so its `DragGesture` is not torn down
/// during a hold — without this, push-to-talk holds were never recognised
/// and pauses ended the turn abruptly.
final class CoachViewOrbGatingTests: XCTestCase {

    func testShowsOrbInConversationModeWhenNotPressed() {
        let result = CoachView.showsConversationOrb(
            mode: .conversation,
            isMicPressed: false
        )
        XCTAssertTrue(result)
    }

    func testHidesOrbInConversationModeWhenPressed() {
        let result = CoachView.showsConversationOrb(
            mode: .conversation,
            isMicPressed: true
        )
        XCTAssertFalse(result)
    }

    func testHidesOrbInSingleModeWhenNotPressed() {
        let result = CoachView.showsConversationOrb(
            mode: .single,
            isMicPressed: false
        )
        XCTAssertFalse(result)
    }

    func testHidesOrbInSingleModeWhenPressed() {
        let result = CoachView.showsConversationOrb(
            mode: .single,
            isMicPressed: true
        )
        XCTAssertFalse(result)
    }
}
