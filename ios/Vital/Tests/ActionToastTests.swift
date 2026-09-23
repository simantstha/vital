import XCTest
@testable import Vital

/// `ActionToastPresenter` is the only part of `ActionToast.swift` with pure
/// logic worth unit-testing directly — replacement/queue semantics and the
/// timing table (§6, §5.5 of `docs/ux-spec-v4.md`). The gesture/animation/
/// haptic view code needs a device or simulator to exercise meaningfully.
@MainActor
final class ActionToastTests: XCTestCase {

    // MARK: - Replacement semantics ("one at a time")

    func testShowReplacesCurrentToast() {
        let presenter = ActionToastPresenter()
        presenter.show(message: "First")
        let firstId = presenter.current?.id

        presenter.show(message: "Second")

        XCTAssertEqual(presenter.current?.message, "Second")
        XCTAssertNotEqual(presenter.current?.id, firstId)
    }

    func testShowWithNoPriorToastSetsCurrent() {
        let presenter = ActionToastPresenter()
        XCTAssertNil(presenter.current)

        presenter.show(message: "Logged — nice work")

        XCTAssertEqual(presenter.current?.message, "Logged — nice work")
    }

    // MARK: - Dismiss guards against stale callbacks

    func testDismissWithStaleIdDoesNotClearNewerToast() {
        let presenter = ActionToastPresenter()
        presenter.show(message: "First")
        let staleId = presenter.current!.id

        presenter.show(message: "Second")
        presenter.dismiss(id: staleId)

        XCTAssertEqual(presenter.current?.message, "Second", "a stale dismiss must not clear a toast that replaced it")
    }

    func testDismissWithMatchingIdClearsCurrent() {
        let presenter = ActionToastPresenter()
        presenter.show(message: "Logged 181.8 lb")
        let id = presenter.current!.id

        presenter.dismiss(id: id)

        XCTAssertNil(presenter.current)
    }

    func testDismissCurrentAlwaysClears() {
        let presenter = ActionToastPresenter()
        presenter.show(message: "Logged 181.8 lb")

        presenter.dismissCurrent()

        XCTAssertNil(presenter.current)
    }

    // MARK: - isUndoable

    func testItemIsUndoableOnlyWithBothActionTitleAndAction() {
        let plain = ActionToastItem(message: "Logged — nice work")
        XCTAssertFalse(plain.isUndoable)

        let titleOnly = ActionToastItem(message: "Logged — nice work", actionTitle: "Undo")
        XCTAssertFalse(titleOnly.isUndoable, "no action closure means there's nothing to reach")

        let undoable = ActionToastItem(message: "Logged Chicken bowl", actionTitle: "Undo", action: {})
        XCTAssertTrue(undoable.isUndoable)
    }

    // MARK: - Timing table (§6 `toast` row, §5.5)

    func testBaseDurationIsFiveSecondsForUndoableToasts() {
        XCTAssertEqual(ActionToastPresenter.baseDuration(isUndoable: true), 5.0)
    }

    func testBaseDurationIsTwoPointFourSecondsForPlainToasts() {
        XCTAssertEqual(ActionToastPresenter.baseDuration(isUndoable: false), 2.4)
    }

    func testVoiceOverDoublesDurationForUndoableToasts() {
        // §5.5: "5 s, paused while touched; 10 s under VoiceOver."
        XCTAssertEqual(ActionToastPresenter.duration(isUndoable: true, voiceOverRunning: true), 10.0)
        XCTAssertEqual(ActionToastPresenter.duration(isUndoable: true, voiceOverRunning: false), 5.0)
    }

    func testVoiceOverDoublesDurationForPlainToasts() {
        XCTAssertEqual(ActionToastPresenter.duration(isUndoable: false, voiceOverRunning: true), 4.8)
        XCTAssertEqual(ActionToastPresenter.duration(isUndoable: false, voiceOverRunning: false), 2.4)
    }

    // MARK: - Equatable identity

    func testItemEqualityIsByIdNotContent() {
        let a = ActionToastItem(message: "Logged — nice work")
        let b = ActionToastItem(message: "Logged — nice work")
        XCTAssertNotEqual(a, b, "two separately-constructed items get distinct UUIDs even with identical text")
        XCTAssertEqual(a, a)
    }
}
