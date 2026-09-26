import Foundation

/// Pure grouping behind the grid's orphan-tile layout: `LazyVGrid` can't
/// span a cell across columns, so a 2-column section is instead laid out as
/// rows of up to 2 tiles each, with a lone last tile (an odd tile count)
/// landing alone in its own row rather than half-empty next to a gap.
enum TrendsRowGrouping {
    /// Chunks `tiles` into rows of at most 2 — every row but possibly the
    /// last has exactly 2; the last has 1 iff `tiles.count` is odd. Empty
    /// input produces no rows.
    static func pairedRows(_ tiles: [TrendsTile]) -> [[TrendsTile]] {
        stride(from: 0, to: tiles.count, by: 2).map { start in
            Array(tiles[start..<min(start + 2, tiles.count)])
        }
    }
}
