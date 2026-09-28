import XCTest
@testable import Vital

/// `DailyIngestWorkout` is the wire shape posted to `POST /api/ingest/daily`
/// (`app/api/ingest/daily/route.ts`). phase2-contract.md's PR B adds
/// `hrSeries` and `running` — additive, optional keys the server whitelists
/// (`isValidWorkoutHrSeries` / `isValidWorkoutRunning`). These tests pin
/// that both are omitted (never sent as `null` or `0`) when nil, and encode
/// correctly when present.
final class DailyIngestWorkoutPayloadTests: XCTestCase {

    private func encodeToDictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeWorkout(hrSeries: [Double]?, running: DailyIngestRunning?) -> DailyIngestWorkout {
        DailyIngestWorkout(
            hkUuid: "ABCD-1234",
            type: "Running",
            durationMin: 32.5,
            kcal: 410,
            distanceM: 5200,
            avgHr: 152,
            maxHr: 178,
            paceMinPerKm: 6.25,
            elevationGainM: 40,
            startTime: "2026-09-27T06:30:00Z",
            sourceBundleId: "com.apple.health.ABCD.watch",
            hrSeries: hrSeries,
            running: running
        )
    }

    func testOmitsHrSeriesAndRunningWhenNil() throws {
        let workout = makeWorkout(hrSeries: nil, running: nil)
        let dict = try encodeToDictionary(workout)

        XCTAssertNil(dict["hrSeries"])
        XCTAssertNil(dict["running"])
    }

    func testEncodesHrSeriesAsAnArrayOfNumbers() throws {
        let workout = makeWorkout(hrSeries: [120.0, 121.5, 130.0], running: nil)
        let dict = try encodeToDictionary(workout)

        XCTAssertEqual(dict["hrSeries"] as? [Double], [120.0, 121.5, 130.0])
    }

    func testEncodesRunningWithOnlyItsPresentFields() throws {
        let running = DailyIngestRunning(cadenceSpm: 178, groundContactMs: nil, powerW: 285, strideM: nil)
        let workout = makeWorkout(hrSeries: nil, running: running)
        let dict = try encodeToDictionary(workout)

        let runningDict = try XCTUnwrap(dict["running"] as? [String: Any])
        XCTAssertEqual(runningDict["cadenceSpm"] as? Double, 178)
        XCTAssertEqual(runningDict["powerW"] as? Double, 285)
        // Never sent as 0/null for a field with no data — the key is absent.
        XCTAssertNil(runningDict["groundContactMs"])
        XCTAssertNil(runningDict["strideM"])
    }

    func testEncodesAllRunningFieldsWhenPresent() throws {
        let running = DailyIngestRunning(cadenceSpm: 178, groundContactMs: 238, powerW: 285, strideM: 1.15)
        let workout = makeWorkout(hrSeries: nil, running: running)
        let dict = try encodeToDictionary(workout)

        let runningDict = try XCTUnwrap(dict["running"] as? [String: Any])
        XCTAssertEqual(runningDict["cadenceSpm"] as? Double, 178)
        XCTAssertEqual(runningDict["groundContactMs"] as? Double, 238)
        XCTAssertEqual(runningDict["powerW"] as? Double, 285)
        XCTAssertEqual(runningDict["strideM"] as? Double, 1.15)
    }
}
