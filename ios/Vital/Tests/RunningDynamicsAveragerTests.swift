import XCTest
@testable import Vital

/// `RunningDynamicsAverager` turns the raw `HKWorkout.statistics(for:)`
/// numbers `HealthKitBackfill.fetchWorkouts` reads for a running workout
/// into the `DailyIngestRunning` block (phase2-contract.md, PR B).
final class RunningDynamicsAveragerTests: XCTestCase {

    func testAllFieldsPresent() throws {
        let result = try XCTUnwrap(RunningDynamicsAverager.average(
            stepSum: 900,
            durationMin: 5,
            avgPowerW: 280,
            avgGroundContactMs: 240,
            avgStrideM: 1.1
        ))

        XCTAssertEqual(result.cadenceSpm, 180) // 900 steps / 5 min
        XCTAssertEqual(result.powerW, 280)
        XCTAssertEqual(result.groundContactMs, 240)
        XCTAssertEqual(result.strideM, 1.1)
    }

    func testEachFieldIsNilWhenItsOwnSampleIsMissing() throws {
        let result = try XCTUnwrap(RunningDynamicsAverager.average(
            stepSum: nil,
            durationMin: 5,
            avgPowerW: 280,
            avgGroundContactMs: nil,
            avgStrideM: 1.1
        ))

        XCTAssertNil(result.cadenceSpm)
        XCTAssertEqual(result.powerW, 280)
        XCTAssertNil(result.groundContactMs)
        XCTAssertEqual(result.strideM, 1.1)
    }

    func testNilWhenEveryFieldWouldBeNil() {
        let result = RunningDynamicsAverager.average(
            stepSum: nil,
            durationMin: 5,
            avgPowerW: nil,
            avgGroundContactMs: nil,
            avgStrideM: nil
        )

        XCTAssertNil(result)
    }

    func testCadenceIsNilWhenDurationIsZero() throws {
        let result = try XCTUnwrap(RunningDynamicsAverager.average(
            stepSum: 500,
            durationMin: 0,
            avgPowerW: 200,
            avgGroundContactMs: nil,
            avgStrideM: nil
        ))

        XCTAssertNil(result.cadenceSpm)
        XCTAssertEqual(result.powerW, 200)
    }
}
