import Foundation

/// Pure downsampling for the metric detail chart. A daily 1Y series is ~365
/// marks; `TrendLineChart`/Swift Charts performance and legibility both
/// degrade well before that, so the plan calls for weekly means once a
/// series exceeds 90 points (~52 marks for a year). Band, stats, and
/// distribution always compute from the **raw** (non-downsampled) points —
/// only the line/area marks in the chart itself downsample. Callers must
/// change the chart's subtitle to "weekly average" whenever downsampling
/// actually occurred — rendering weekly means in the same visual language as
/// daily readings would claim a precision the data doesn't have.
enum TrendsDownsample {
    /// Series of 90 points or fewer pass through unchanged. Above that,
    /// buckets by ISO calendar week (`yearForWeekOfYear` + `weekOfYear`, so
    /// buckets align to calendar weeks regardless of which weekday the
    /// series happens to start on) and returns one point per week: the mean
    /// value, dated to the bucket's most recent day (reads as "week ending
    /// …", matching how a viewer scans a chart right-to-left from "now").
    static func weekly(_ points: [ChartPoint], calendar: Calendar) -> [ChartPoint] {
        guard points.count > 90 else { return points }

        var cal = calendar
        cal.timeZone = TimeZone.current

        var bucketOrder: [DateComponents] = []
        var buckets: [DateComponents: [ChartPoint]] = [:]
        for point in points.sorted(by: { $0.date < $1.date }) {
            let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: point.date)
            if buckets[comps] == nil { bucketOrder.append(comps) }
            buckets[comps, default: []].append(point)
        }

        return bucketOrder.compactMap { comps in
            guard let bucketPoints = buckets[comps], !bucketPoints.isEmpty else { return nil }
            let meanValue = bucketPoints.map(\.value).reduce(0, +) / Double(bucketPoints.count)
            let representativeDate = bucketPoints.map(\.date).max()!
            return ChartPoint(date: representativeDate, value: meanValue)
        }
    }
}
