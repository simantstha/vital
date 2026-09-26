import XCTest
@testable import Vital

final class TrendsRowGroupingTests: XCTestCase {

    private func tile(_ key: String) -> TrendsTile {
        TrendsTile(key: key, content: .sparse(value: 1, readingCount: 1))
    }

    func testEmptyInputProducesNoRows() {
        XCTAssertEqual(TrendsRowGrouping.pairedRows([]), [])
    }

    func testEvenCountProducesFullPairsOnly() {
        let tiles = ["a", "b", "c", "d"].map(tile)
        let rows = TrendsRowGrouping.pairedRows(tiles)
        XCTAssertEqual(rows.map { $0.map(\.key) }, [["a", "b"], ["c", "d"]])
    }

    func testOddCountLeavesTheLastTileAloneInItsOwnRow() {
        let tiles = ["a", "b", "c"].map(tile)
        let rows = TrendsRowGrouping.pairedRows(tiles)
        XCTAssertEqual(rows.map { $0.map(\.key) }, [["a", "b"], ["c"]])
        XCTAssertEqual(rows.last?.count, 1)
    }

    func testSingleTileProducesOneRowOfOne() {
        let rows = TrendsRowGrouping.pairedRows([tile("only")])
        XCTAssertEqual(rows.map { $0.map(\.key) }, [["only"]])
    }
}
