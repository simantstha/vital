import Foundation

/// Pure interval-union math shared by `HealthKitManager.fetchLastNightSleep`
/// (today's live sleep figure) and `HealthKitBackfill.fetchDailySleep` (the
/// nightly backfill/re-aggregation). When multiple HealthKit sources write
/// sleep for the same night (e.g. Apple Watch staging + a 3rd-party app like
/// AutoSleep/Oura, or WHOOP's copy alongside the Watch's own), summing raw
/// sample durations double-counts overlapping time. Unioning the intervals
/// first makes every real minute of sleep count exactly once, regardless of
/// how many sources reported it.
enum SleepIntervalMath {

    /// A half-open time interval `[start, end)`.
    struct Interval {
        let start: Date
        let end: Date

        init(start: Date, end: Date) {
            self.start = start
            self.end = end
        }
    }

    /// Total minutes covered by the union of the given intervals — overlapping
    /// (and nested) ranges are counted once, not summed. Disjoint intervals
    /// contribute their full lengths, gaps included between them but not
    /// counted. Empty input yields 0.
    static func unionMinutes(_ intervals: [Interval]) -> Double {
        let sorted = intervals
            .filter { $0.end > $0.start }
            .sorted { $0.start < $1.start }
        guard let first = sorted.first else { return 0 }

        var totalSeconds = 0.0
        var curStart = first.start
        var curEnd = first.end
        for iv in sorted.dropFirst() {
            if iv.start > curEnd {
                totalSeconds += curEnd.timeIntervalSince(curStart)
                curStart = iv.start
                curEnd = iv.end
            } else if iv.end > curEnd {
                curEnd = iv.end
            }
        }
        totalSeconds += curEnd.timeIntervalSince(curStart)
        return totalSeconds / 60
    }

    /// The earliest `start` and latest `end` across the given intervals —
    /// used to derive a night's overall bedTime/wakeTime from its (possibly
    /// multi-source, overlapping) asleep intervals, independent of
    /// `unionMinutes`'s gap-aware duration math. `nil` for empty input.
    static func boundingRange(_ intervals: [Interval]) -> (start: Date, end: Date)? {
        guard let firstStart = intervals.map(\.start).min(),
              let lastEnd = intervals.map(\.end).max() else { return nil }
        return (firstStart, lastEnd)
    }
}
