import XCTest
@testable import Vital

/// `DailyIngestSleep` is the wire shape posted to `POST /api/ingest/daily`
/// (`app/api/ingest/daily/route.ts`). analysis-v2-contract.md §3 adds
/// `bedTime`/`wakeTime` — additive ISO-8601 strings, omitted (not `null`)
/// when a night has no asleep time at all. These tests pin the JSON shape so
/// a future refactor can't silently drop or rename the new keys.
final class DailyIngestSleepPayloadTests: XCTestCase {

    private func encodeToDictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testEncodesBedTimeAndWakeTimeAsISOStrings() throws {
        let sleep = DailyIngestSleep(
            minutes: 430,
            stages: DailyIngestSleepStages(core: 240, deep: 70, rem: 90, awake: 30),
            bedTime: "2026-09-26T23:52:00Z",
            wakeTime: "2026-09-27T06:10:00Z"
        )
        let dict = try encodeToDictionary(sleep)
        XCTAssertEqual(dict["bedTime"] as? String, "2026-09-26T23:52:00Z")
        XCTAssertEqual(dict["wakeTime"] as? String, "2026-09-27T06:10:00Z")
        XCTAssertEqual(dict["minutes"] as? Int, 430)
    }

    /// `Encodable`'s default behaviour for a `nil` `String?` omits the key
    /// entirely (unlike `JSONSerialization`'s `NSNull`) — matching the
    /// contract's "omit a key rather than send null" rule.
    func testOmitsBedTimeAndWakeTimeWhenNil() throws {
        let sleep = DailyIngestSleep(minutes: 400, stages: nil, bedTime: nil, wakeTime: nil)
        let dict = try encodeToDictionary(sleep)
        XCTAssertNil(dict["bedTime"])
        XCTAssertNil(dict["wakeTime"])
    }
}
