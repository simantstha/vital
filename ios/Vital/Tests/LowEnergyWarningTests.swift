import XCTest
@testable import Vital

/// `lowEnergyWarning` (lib/brain/dietBudget.ts) was added to the wire by
/// PR #136 but never decoded/rendered on iOS. These tests pin the two things
/// that matter: an older backend response (field absent) must still decode —
/// `TodayDietBudget`/`DietBudgetDTO` declare it `Optional` for exactly this
/// reason — and Today's banner title must flip on `appliedFloor`.
final class LowEnergyWarningTests: XCTestCase {

    private let flooredJSON = """
    {"targetKcal":1200,"consumedKcal":400,"remaining":800,"protein":90,"carbs":100,"fat":40,
     "proteinTarget":90,"carbsTarget":100,"fatTarget":40,"mode":"auto","goal":"weight_loss",
     "lowEnergyWarning":{"thresholdKcal":1200,"appliedFloor":true,"message":"We eased the deficit."}}
    """

    private let noWarningJSON = """
    {"targetKcal":2400,"consumedKcal":400,"remaining":2000,"protein":90,"carbs":100,"fat":40,
     "proteinTarget":90,"carbsTarget":100,"fatTarget":40,"mode":"auto","goal":"general",
     "lowEnergyWarning":null}
    """

    // An older backend that predates PR #136 — the key is entirely absent,
    // not just null. Backwards-compat is the whole point of the field being
    // Optional rather than defaulted server-side.
    private let fieldAbsentJSON = """
    {"targetKcal":2400,"consumedKcal":400,"remaining":2000,"protein":90,"carbs":100,"fat":40,
     "proteinTarget":90,"carbsTarget":100,"fatTarget":40,"mode":"auto","goal":"general"}
    """

    func testDecodesWithLowEnergyWarningPresent() throws {
        let budget = try JSONDecoder().decode(TodayDietBudget.self, from: Data(flooredJSON.utf8))

        XCTAssertEqual(budget.lowEnergyWarning?.thresholdKcal, 1200)
        XCTAssertEqual(budget.lowEnergyWarning?.appliedFloor, true)
        XCTAssertEqual(budget.lowEnergyWarning?.message, "We eased the deficit.")
    }

    func testDecodesWithLowEnergyWarningExplicitNull() throws {
        let budget = try JSONDecoder().decode(TodayDietBudget.self, from: Data(noWarningJSON.utf8))

        XCTAssertNil(budget.lowEnergyWarning)
    }

    func testDecodesWhenFieldIsEntirelyAbsent_backwardsCompat() throws {
        let budget = try JSONDecoder().decode(TodayDietBudget.self, from: Data(fieldAbsentJSON.utf8))

        XCTAssertNil(budget.lowEnergyWarning)
        XCTAssertEqual(budget.targetKcal, 2400)
    }

    func testDietBudgetDTOAlsoDecodesTheField() throws {
        // DietBudgetDTO (the /api/diet-goal editor shape) carries the same
        // optional field, plus `tdee` which TodayDietBudget doesn't have.
        let json = """
        {"mode":"custom","goal":"weight_loss","targetKcal":1000,"protein":100,"carbs":80,"fat":30,
         "lowEnergyWarning":{"thresholdKcal":1200,"appliedFloor":false,"message":"Flagging this."}}
        """
        let budget = try JSONDecoder().decode(DietBudgetDTO.self, from: Data(json.utf8))

        XCTAssertEqual(budget.lowEnergyWarning?.appliedFloor, false)
        XCTAssertNil(budget.tdee)
    }

    func testBannerTitleFlipsOnAppliedFloor() {
        XCTAssertEqual(CautionBanner.lowEnergyTitle(appliedFloor: true), "We eased your deficit")
        XCTAssertEqual(CautionBanner.lowEnergyTitle(appliedFloor: false), "Below the safe floor")
    }
}
