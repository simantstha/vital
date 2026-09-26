import Foundation

/// One row in the "What moved" card — a metric whose latest reading is
/// `.above`/`.below` its 30-day normal (the same gated `Verdict`
/// `TrendsIndexSections` already computed; this never re-derives a verdict).
struct WhatMovedRow: Equatable {
    let key: String
    let value: Double
    /// The tile's own sparkline series — reused verbatim so the mini chart
    /// here can never disagree with the grid tile's.
    let sparklineValues: [Double?]
    let mean30: Double
    let sd30: Double
    /// The delta this row's pill renders: latest − mean30 (signed).
    var delta: Double { value - mean30 }
    /// `TrendDirection.resolve(spec.polarity, rising:).isGood` for this
    /// reading's direction — true tints the row/pill positive, false tints
    /// it caution.
    let isGood: Bool
    /// `|z|` — `|value − mean30| / sd30` — the sort key, descending: the
    /// metric that's drifted furthest from its own normal (in σ terms, not
    /// raw units, so a HRV reading and a step count are comparable) leads.
    let absZ: Double
}

/// Pure selection/sort behind the "What moved" section — no SwiftUI, no
/// network. Walks the already-built (pre goal-reordered) `TrendsSection`s
/// `TrendsIndexSections.build` produced, since a moved metric belongs in
/// this card regardless of which group it lives in or how goal ordering
/// later reshuffles those groups.
enum TrendsWhatMoved {
    /// The card renders at most this many rows even when more metrics moved.
    static let maxRows = 4

    /// Every `.above`/`.below` metric across every section, sorted by `|z|`
    /// descending — unbounded, so callers needing the true good/watch counts
    /// (the headline) don't have to special-case rows a `maxRows` cap
    /// dropped from the card itself.
    static func movedRows(sections: [TrendsSection]) -> [WhatMovedRow] {
        var rows: [WhatMovedRow] = []
        for section in sections {
            for tile in section.tiles {
                guard case .chart(let value, let sparklineValues, let verdict) = tile.content,
                      let baseline = tile.baseline,
                      let mean30 = baseline.mean30,
                      let sd30 = baseline.sd30, sd30 > 0,
                      let spec = MetricCatalog.spec(for: tile.key)
                else { continue }

                let isGood: Bool
                let absZ: Double
                switch verdict {
                case .above(let z):
                    isGood = TrendDirection.resolve(spec.polarity, rising: true).isGood
                    absZ = abs(z)
                case .below(let z):
                    isGood = TrendDirection.resolve(spec.polarity, rising: false).isGood
                    absZ = abs(z)
                default:
                    continue
                }

                rows.append(WhatMovedRow(
                    key: tile.key,
                    value: value,
                    sparklineValues: sparklineValues,
                    mean30: mean30,
                    sd30: sd30,
                    isGood: isGood,
                    absZ: absZ
                ))
            }
        }
        return rows.sorted { $0.absZ > $1.absZ }
    }

    /// The at-most-`maxRows` rows the card actually renders.
    static func topRows(sections: [TrendsSection]) -> [WhatMovedRow] {
        Array(movedRows(sections: sections).prefix(maxRows))
    }
}
