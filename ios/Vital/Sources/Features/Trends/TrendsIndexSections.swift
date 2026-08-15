import Foundation

/// What one tile on the Trends grid index renders, per the plan's
/// empty/hidden rules table. A metric that's fully hidden (key absent from
/// `loaded`, or `dataDays == 0`) never produces a `TrendsTile` at all — see
/// `TrendsIndexSections.build`.
enum TileContent: Equatable {
    /// `dataDays > 0` but no points landed in the requested window — synced
    /// before, just not recently (a stale `vo2_max` / `body_mass_kg`).
    /// Rendered as name + "Last synced …" rather than hidden, so the tile
    /// doesn't read as "this metric vanished".
    case dimmed(lastDate: Date?)
    /// 1–2 points: too few for a sparkline or a verdict. Value + reading
    /// count only.
    case sparse(value: Double, readingCount: Int)
    /// ≥3 points: the full tile — value, sparkline series, and a verdict.
    /// The verdict may itself still be `.calibrating` (rendered as a gray
    /// chip) or `.noData` — that's not a separate rendering branch, it's
    /// just what `TrendsVerdict` returned for this reading.
    case chart(value: Double, sparklineValues: [Double?], verdict: Verdict)
}

/// One metric's tile in the grid index.
struct TrendsTile: Equatable {
    let key: String
    let content: TileContent
}

/// One section of the grid index — a `MetricGroup` plus the tiles that
/// aren't fully hidden. A section with zero tiles is never constructed
/// (see `TrendsIndexSections.build`), which is what makes "every metric in
/// the group hidden ⇒ the whole section, header included, is hidden" and
/// "no `whoop_*` has data ⇒ WHOOP section hidden entirely" true for free —
/// there's no separate "is this section visible" check to keep in sync.
struct TrendsSection: Equatable {
    let group: MetricGroup
    let tiles: [TrendsTile]
}

/// Pure assembly of the Trends grid index from a batch of loaded series.
/// No network, no `MetricCatalog` mutation — just the hide/dim/degrade
/// table from the plan applied to whatever `loaded` already contains.
enum TrendsIndexSections {
    /// Fixed section display order.
    private static let groupOrder: [MetricGroup] = [.recovery, .sleep, .activity, .body, .whoop]

    /// `today` is accepted (mirroring `TrendsSummary.weekWindow`'s injected-
    /// clock pattern) even though the current rules don't need it — the
    /// server-side `points` array already reflects the requested window, so
    /// "dimmed" is determined purely by `dataDays > 0 && points.isEmpty`.
    /// Kept as a seam for a future staleness threshold (e.g. "dimmed only if
    /// `lastDate` is more than N days before `today`") without changing the
    /// signature call sites depend on.
    static func build(loaded: [String: MetricSeries], today: Date) -> [TrendsSection] {
        groupOrder.compactMap { group in
            let tiles = MetricCatalog.keys(in: group).compactMap { key -> TrendsTile? in
                guard let series = loaded[key], series.dataDays > 0 else { return nil } // hidden
                guard let spec = MetricCatalog.spec(for: key) else { return nil }

                guard !series.points.isEmpty else {
                    return TrendsTile(key: key, content: .dimmed(lastDate: series.lastDate))
                }

                let sortedPoints = series.points.sorted { $0.date < $1.date }
                let latestValue = sortedPoints.last!.value

                guard sortedPoints.count >= 3 else {
                    return TrendsTile(
                        key: key,
                        content: .sparse(value: latestValue, readingCount: sortedPoints.count)
                    )
                }

                let verdict = TrendsVerdict.evaluate(
                    latest: latestValue,
                    established: series.established,
                    dataDays: series.dataDays,
                    mean30: series.baseline?.mean30,
                    sd30: series.baseline?.sd30,
                    minMeaningfulSD: spec.minMeaningfulSD
                )
                return TrendsTile(
                    key: key,
                    content: .chart(
                        value: latestValue,
                        sparklineValues: sortedPoints.map(\.value),
                        verdict: verdict
                    )
                )
            }
            return tiles.isEmpty ? nil : TrendsSection(group: group, tiles: tiles)
        }
    }
}
