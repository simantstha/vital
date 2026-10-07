import XCTest
@testable import Vital

/// Every fixture meal must be physically plausible: 4P + 4C + 9F is within
/// 10% of its kcal (persona review caught a 240 kcal smoothie with ~457 kcal
/// of macros). Also pins that new_user has no sleep series (Apple Health is
/// not connected for that persona).
#if DEBUG
final class FixtureMealMacroTests: XCTestCase {

    private func json(_ scenario: FixtureMode.Scenario, _ path: String, _ query: String = "") -> [String: Any] {
        let (status, data) = FixtureData.response(scenario: scenario, method: "GET", path: path, query: query)
        XCTAssertEqual(status, 200, path)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func test_fixtureMealMacrosMatchTheirCalories() {
        for scenario in [FixtureMode.Scenario.weightLoss, .muscle, .endurance] {
            let items = json(scenario, "/api/meals/log")["items"] as? [[String: Any]] ?? []
            XCTAssertFalse(items.isEmpty, "\(scenario) meals")
            for item in items {
                let name = item["name"] as? String ?? "?"
                let kcal = Double(item["kcal"] as? Int ?? 0)
                let p = Double(item["protein"] as? Int ?? 0)
                let c = Double(item["carbs"] as? Int ?? 0)
                let f = Double(item["fat"] as? Int ?? 0)
                let fromMacros = 4 * p + 4 * c + 9 * f
                XCTAssertEqual(fromMacros, kcal, accuracy: kcal * 0.10, "\(scenario) \(name): \(fromMacros) kcal from macros vs \(kcal)")
            }
        }
    }

    func test_newUserHasNoSleepSeries() {
        let single = json(.newUser, "/api/trends", "metric=sleep")
        XCTAssertEqual((single["points"] as? [[String: Any]])?.count, 0)
    }
}
#endif
