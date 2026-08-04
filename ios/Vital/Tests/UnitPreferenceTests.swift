import Combine
import XCTest
@testable import Vital

@MainActor
final class UnitPreferenceTests: XCTestCase {

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "UnitPreferenceTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - resolve(stored:)

    func testResolveNilFallsBackToDeviceDefault() {
        XCTAssertEqual(UnitPreference.resolve(stored: nil), UnitSystem.deviceDefault)
    }

    func testResolveValidStoredValue() {
        XCTAssertEqual(UnitPreference.resolve(stored: "metric"), .metric)
        XCTAssertEqual(UnitPreference.resolve(stored: "imperial"), .imperial)
    }

    func testResolveGarbageFallsBackToDeviceDefault() {
        XCTAssertEqual(UnitPreference.resolve(stored: "not-a-unit-system"), UnitSystem.deviceDefault)
    }

    // MARK: - init reads synchronously from the injected defaults

    func testInitResolvesStoredValueSynchronously() {
        defaults.set("imperial", forKey: "vital.unitSystem")
        let pref = UnitPreference(defaults: defaults)
        XCTAssertEqual(pref.current, .imperial)
    }

    // MARK: - applyServerValue

    func testApplyServerValueNilIsANoOp() {
        defaults.set("imperial", forKey: "vital.unitSystem")
        let pref = UnitPreference(defaults: defaults)
        pref.applyServerValue(nil)
        XCTAssertEqual(pref.current, .imperial)
    }

    func testApplyServerValueGarbageIsANoOp() {
        let pref = UnitPreference(defaults: defaults)
        let before = pref.current
        pref.applyServerValue("bogus")
        XCTAssertEqual(pref.current, before)
    }

    func testApplyServerValueAppliesAndPersistsValidValue() {
        let pref = UnitPreference(defaults: defaults)
        pref.applyServerValue("imperial")
        XCTAssertEqual(pref.current, .imperial)
        XCTAssertEqual(defaults.string(forKey: "vital.unitSystem"), "imperial")
    }

    func testApplyServerValueIsIdempotent() {
        let pref = UnitPreference(defaults: defaults)
        pref.applyServerValue("imperial")
        pref.applyServerValue("imperial")
        XCTAssertEqual(pref.current, .imperial)
    }

    // MARK: - set

    func testSetPublishesOnceWhenValueChanges() {
        // Start from a known, deterministic value rather than the device
        // default (which varies by simulator locale).
        defaults.set(UnitSystem.metric.rawValue, forKey: "vital.unitSystem")
        let pref = UnitPreference(defaults: defaults)

        var changeCount = 0
        let cancellable = pref.objectWillChange.sink { changeCount += 1 }
        pref.set(.imperial)
        pref.set(.imperial) // same value again — must not publish a second time
        cancellable.cancel()

        XCTAssertEqual(changeCount, 1)
        XCTAssertEqual(pref.current, .imperial)
    }

    // MARK: - clear

    func testClearRemovesStoredValueAndRevertsToDeviceDefault() {
        let pref = UnitPreference(defaults: defaults)
        pref.set(.imperial)
        pref.clear()
        XCTAssertEqual(pref.current, UnitSystem.deviceDefault)
        XCTAssertNil(defaults.string(forKey: "vital.unitSystem"))
    }
}
