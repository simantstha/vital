import Foundation

// MARK: - HeartRateResampler

/// Pure heart-rate resampling for the Watch ingest contract
/// (phase2-contract.md, PR B). Turns raw timestamped bpm samples from a
/// workout into `hrSeries` — the evenly-spaced array `DailyIngestWorkout`
/// posts to `/api/ingest/daily`, which the server stores as-is and the
/// analysis UI renders as a heart-rate curve / heart-rate-reserve zones.
///
/// Kept free of HealthKit types so it's trivially unit-testable —
/// `HealthKitBackfill.fetchWorkouts` is the only caller, and it does the one
/// `HKSampleQuery` (predicated on the workout's own start/end) that produces
/// the `Sample` array this consumes. No querying happens per bin.
enum HeartRateResampler {

    /// One raw heart-rate sample: a timestamp and a bpm value.
    struct Sample {
        let date: Date
        let bpm: Double
    }

    /// Resamples `samples` into evenly spaced bins spanning `[start, end]`.
    ///
    /// - Bin count is `min(120, durationSec / 15)`, at least 1 as long as the
    ///   workout has positive duration.
    /// - Each bin holds the mean bpm of the samples whose timestamp falls
    ///   inside it.
    /// - A bin with no samples carries the previous bin's value forward;
    ///   leading empty bins (before the first sample) take the first
    ///   non-empty bin's value.
    /// - Values are rounded to 1 decimal place.
    /// - Returns nil when fewer than 10 samples are given, or the workout
    ///   window is zero/negative length — too sparse or malformed to be a
    ///   meaningful curve.
    static func resample(samples: [Sample], start: Date, end: Date) -> [Double]? {
        guard samples.count >= 10 else { return nil }

        let duration = end.timeIntervalSince(start)
        guard duration > 0 else { return nil }

        let binCount = max(1, min(120, Int(duration / 15)))
        let binWidth = duration / Double(binCount)

        var sums = [Double](repeating: 0, count: binCount)
        var counts = [Int](repeating: 0, count: binCount)

        for sample in samples {
            let offset = sample.date.timeIntervalSince(start)
            guard offset >= 0, offset <= duration else { continue }
            var index = Int(offset / binWidth)
            index = min(max(index, 0), binCount - 1)
            sums[index] += sample.bpm
            counts[index] += 1
        }

        guard let firstNonEmpty = (0..<binCount).first(where: { counts[$0] > 0 }) else {
            // Every sample landed outside [start, end] (shouldn't happen for
            // samples the caller already predicated on this same window).
            return nil
        }

        var result = [Double](repeating: 0, count: binCount)
        // Seeded with the first non-empty bin's mean, so bins before it (none
        // exist, by construction, since firstNonEmpty is the first index with
        // counts > 0) and any later empty bin both carry the right value
        // forward.
        var lastValue = sums[firstNonEmpty] / Double(counts[firstNonEmpty])

        for i in 0..<binCount {
            if counts[i] > 0 {
                lastValue = sums[i] / Double(counts[i])
            }
            result[i] = lastValue
        }

        return result.map { ($0 * 10).rounded() / 10 }
    }
}

// MARK: - RunningDynamicsAverager

/// Pure averaging for the running-dynamics block of the Watch ingest
/// contract (phase2-contract.md, PR B). `HealthKitBackfill.fetchWorkouts`
/// reads `.runningPower` / `.runningGroundContactTime` / `.runningStrideLength`
/// averages and the `.stepCount` sum straight off `HKWorkout.statistics(for:)`
/// — the same zero-extra-query mechanism already used there for
/// kcal/distance/avgHr/maxHr — and hands the raw numbers here to turn into
/// the wire shape.
enum RunningDynamicsAverager {

    /// - Parameters:
    ///   - stepSum: `.stepCount` summed over the workout window, if any.
    ///   - durationMin: the workout's duration in minutes (cadence divisor).
    ///   - avgPowerW: average `.runningPower`, in watts, if any samples existed.
    ///   - avgGroundContactMs: average `.runningGroundContactTime`, in ms, if any.
    ///   - avgStrideM: average `.runningStrideLength`, in meters, if any.
    /// - Returns: `DailyIngestRunning` with whichever fields have data, or
    ///   nil when every field would be nil (no running-dynamics data at all).
    static func average(
        stepSum: Double?,
        durationMin: Double,
        avgPowerW: Double?,
        avgGroundContactMs: Double?,
        avgStrideM: Double?
    ) -> DailyIngestRunning? {
        let cadenceSpm: Double? = {
            guard let stepSum, durationMin > 0 else { return nil }
            return stepSum / durationMin
        }()

        guard cadenceSpm != nil || avgPowerW != nil || avgGroundContactMs != nil || avgStrideM != nil else {
            return nil
        }

        return DailyIngestRunning(
            cadenceSpm: cadenceSpm,
            groundContactMs: avgGroundContactMs,
            powerW: avgPowerW,
            strideM: avgStrideM
        )
    }
}
