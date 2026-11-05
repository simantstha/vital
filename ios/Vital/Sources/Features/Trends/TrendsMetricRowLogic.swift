import Foundation

/// Pure, network-free logic behind `TrendsMetricRowView`'s list-row layout
/// (Trends calm-layout revamp, W1/W2 designs) — the grouped list rows that
/// replaced the old 2-column `MetricTileView` grid tile. No SwiftUI import,
/// same convention as `TrendsSummary`/`TrendsVerdict`, so every branch here
/// is cheap to pin exactly in `TrendsMetricRowLogicTests`.
enum TrendsMetricRowLogic {

    /// The calibrating row's small progress bar + "N of 14 days" label
    /// (W2 design) — distinct from `TrendsHeadline.LearningProgress`, which
    /// is the SAME arithmetic applied to the smallest remaining across every
    /// metric shown, for the header card, not one row.
    struct CalibratingProgress: Equatable {
        /// Days of history counted toward the 14-day baseline window so far,
        /// clamped to 0...14.
        let daysDone: Int
        static let totalDays = 14

        /// "2 of 14 days" — the row's secondary line while calibrating.
        var text: String { "\(daysDone) of \(Self.totalDays) days" }
        /// 0...1 fill fraction for the progress bar.
        var fraction: Double { Double(daysDone) / Double(Self.totalDays) }
    }

    /// `daysRemaining` is `Verdict.calibrating`'s own payload — `daysDone` is
    /// just its complement against the fixed 14-day window (the same
    /// arithmetic `MetricDetailView.calibratingDaysElapsed` already uses),
    /// clamped to 0...14 so a corrupt/negative `daysRemaining` can't produce
    /// a nonsensical "17 of 14 days" or a negative fill.
    static func calibratingProgress(daysRemaining: Int) -> CalibratingProgress {
        let daysDone = max(0, min(CalibratingProgress.totalDays, CalibratingProgress.totalDays - daysRemaining))
        return CalibratingProgress(daysDone: daysDone)
    }

    /// The above/below row's secondary line — "↑ 7 above normal" / "↓ 3
    /// below normal" — plus whether it tints positive or caution. Identical
    /// copy to the old `MetricTileView.deltaLineForChart`'s `.above`/`.below`
    /// branch (unchanged on purpose: this is a layout change, not a copy
    /// change).
    static func movedSecondary(
        value: Double,
        mean30: Double,
        spec: MetricSpec,
        rising: Bool,
        unitSystem: UnitSystem
    ) -> (text: String, isGood: Bool) {
        let delta = value - mean30
        let isGood = TrendDirection.resolve(spec.polarity, rising: rising).isGood
        let text = "\(TrendsDeltaFormat.arrow(delta)) \(TrendsDeltaFormat.magnitudeText(delta, spec: spec, system: unitSystem, includeUnit: false)) \(rising ? "above" : "below") normal"
        return (text, isGood)
    }

    /// The "your normal" band a row's sparkline shades: `mean30 ± sd30`, in
    /// the same display units as the sparkline values (the view model scales
    /// the baseline once, alongside the points). Only an established metric
    /// that has a verdict (`.normal` / `.above` / `.below`) gets one — never
    /// while calibrating or without data — and only from finite stats with a
    /// positive spread, so a flat or broken baseline can't draw a band of
    /// zero height or a NaN rectangle.
    static func normalBand(verdict: Verdict, baseline: TrendsBaselineDTO?) -> (lower: Double, upper: Double)? {
        switch verdict {
        case .normal, .above, .below: break
        case .noData, .calibrating: return nil
        }
        guard let mean = baseline?.mean30, let sd = baseline?.sd30,
              mean.isFinite, sd.isFinite, sd > 0 else { return nil }
        let lower = mean - sd
        let upper = mean + sd
        guard lower.isFinite, upper.isFinite else { return nil }
        return (lower, upper)
    }
}
