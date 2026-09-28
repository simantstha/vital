import XCTest
@testable import Vital

/// `HeartRateResampler` turns raw Watch heart-rate samples into the
/// evenly-spaced `hrSeries` curve `DailyIngestWorkout` posts to
/// `/api/ingest/daily` (phase2-contract.md, PR B). These tests pin its
/// binning, forward-fill, rounding, and cutoff rules independent of
/// HealthKit.
final class HeartRateResamplerTests: XCTestCase {

    private let referenceStart = Date(timeIntervalSince1970: 1_700_000_000)

    private func sample(_ offsetSec: Double, _ bpm: Double) -> HeartRateResampler.Sample {
        HeartRateResampler.Sample(date: referenceStart.addingTimeInterval(offsetSec), bpm: bpm)
    }

    // MARK: - Even distribution

    func testEvenlyDistributedSamplesAverageWithinEachBin() {
        // 30-minute workout (1800s) → min(120, 1800/15) = 120 bins, 15s wide.
        // Two samples per bin, at a constant 140bpm and 150bpm, so every bin's
        // mean should come out to 145.0.
        let end = referenceStart.addingTimeInterval(1800)
        var samples: [HeartRateResampler.Sample] = []
        var t = 0.0
        while t < 1800 {
            samples.append(sample(t, 140))
            samples.append(sample(t + 7, 150))
            t += 15
        }

        let series = HeartRateResampler.resample(samples: samples, start: referenceStart, end: end)

        XCTAssertEqual(series?.count, 120)
        XCTAssertEqual(series, Array(repeating: 145.0, count: 120))
    }

    // MARK: - Gaps (forward fill)

    func testGapsCarryThePreviousBinValueForward() {
        // 5-minute workout (300s) → min(120, 300/15) = 20 bins, 15s wide.
        // Only the first 5 bins (0..<75s) and the last bin (285..<300s) have
        // samples; everything in between must carry bin 4's value forward.
        let end = referenceStart.addingTimeInterval(300)
        var samples: [HeartRateResampler.Sample] = []
        for i in 0..<5 {
            samples.append(sample(Double(i) * 15 + 1, 100 + Double(i)))
        }
        // Pad with duplicate samples so the "fewer than 10" cutoff isn't hit.
        for i in 0..<5 {
            samples.append(sample(Double(i) * 15 + 2, 100 + Double(i)))
        }
        samples.append(sample(290, 200))

        let series = try? XCTUnwrap(HeartRateResampler.resample(samples: samples, start: referenceStart, end: end))

        XCTAssertEqual(series?.count, 20)
        // Bins 0-4 hold their own means (100, 101, 102, 103, 104).
        XCTAssertEqual(series?[0], 100.0)
        XCTAssertEqual(series?[4], 104.0)
        // Bins 5-18 have no samples — forward-filled from bin 4's value.
        for i in 5...18 {
            XCTAssertEqual(series?[i], 104.0, "bin \(i) should carry bin 4's value forward")
        }
        // Bin 19 (285..<300s) has its own sample.
        XCTAssertEqual(series?[19], 200.0)
    }

    func testLeadingEmptyBinsTakeTheFirstNonEmptyValue() {
        // 5-minute workout, but the only samples land after the first 2
        // minutes — bins 0..<7 (0..<105s) must all take bin 8's value.
        let end = referenceStart.addingTimeInterval(300)
        var samples: [HeartRateResampler.Sample] = []
        for i in 0..<10 {
            samples.append(sample(120 + Double(i), 160))
        }

        let series = try? XCTUnwrap(HeartRateResampler.resample(samples: samples, start: referenceStart, end: end))

        XCTAssertEqual(series?.count, 20)
        for i in 0..<8 {
            XCTAssertEqual(series?[i], 160.0, "leading bin \(i) should take the first non-empty value")
        }
    }

    // MARK: - Fewer than 10 samples

    func testFewerThanTenSamplesReturnsNil() {
        let end = referenceStart.addingTimeInterval(600)
        let samples = (0..<9).map { sample(Double($0) * 60, 130) }

        let series = HeartRateResampler.resample(samples: samples, start: referenceStart, end: end)

        XCTAssertNil(series)
    }

    func testExactlyTenSamplesResamples() {
        let end = referenceStart.addingTimeInterval(600)
        let samples = (0..<10).map { sample(Double($0) * 60, 130) }

        let series = HeartRateResampler.resample(samples: samples, start: referenceStart, end: end)

        XCTAssertNotNil(series)
    }

    // MARK: - 120-point cap

    func testLongWorkoutIsCappedAt120Points() {
        // A 3-hour workout (10,800s) would be 720 bins uncapped; must cap at 120.
        let end = referenceStart.addingTimeInterval(10_800)
        var samples: [HeartRateResampler.Sample] = []
        var t = 0.0
        while t < 10_800 {
            samples.append(sample(t, 150))
            t += 60
        }

        let series = HeartRateResampler.resample(samples: samples, start: referenceStart, end: end)

        XCTAssertEqual(series?.count, 120)
    }

    // MARK: - Short workout

    func testShortWorkoutUsesFewerBins() {
        // A 1-minute workout (60s) → min(120, 60/15) = 4 bins, 15s wide.
        let end = referenceStart.addingTimeInterval(60)
        let samples: [HeartRateResampler.Sample] = [
            sample(0, 120), sample(3, 122), sample(6, 124),
            sample(15, 130), sample(18, 132), sample(21, 134),
            sample(30, 140), sample(33, 142), sample(36, 144),
            sample(45, 150), sample(48, 152), sample(51, 154),
        ]

        let series = try? XCTUnwrap(HeartRateResampler.resample(samples: samples, start: referenceStart, end: end))

        XCTAssertEqual(series?.count, 4)
        XCTAssertEqual(series?[0], 122.0)
        XCTAssertEqual(series?[1], 132.0)
        XCTAssertEqual(series?[2], 142.0)
        XCTAssertEqual(series?[3], 152.0)
    }

    // MARK: - Rounding

    func testValuesAreRoundedToOneDecimal() {
        let end = referenceStart.addingTimeInterval(15)
        // Mean of 120, 121, 122 = 121.0; mean of 100..109 (10 samples) = 104.5.
        var samples: [HeartRateResampler.Sample] = [
            sample(0, 120), sample(1, 121), sample(2, 122),
        ]
        for i in 0..<10 {
            samples.append(sample(3 + Double(i) * 0.1, 100 + Double(i)))
        }

        let series = try? XCTUnwrap(HeartRateResampler.resample(samples: samples, start: referenceStart, end: end))

        // A single 15s bin averaging all 13 samples: (120+121+122 + 100+101+...+109) / 13.
        let tail: Double = (100...109).reduce(0.0) { $0 + Double($1) }
        let expectedSum: Double = 120.0 + 121.0 + 122.0 + tail
        let expected = (expectedSum / 13 * 10).rounded() / 10
        XCTAssertEqual(series?.count, 1)
        XCTAssertEqual(series?[0], expected)
    }
}
