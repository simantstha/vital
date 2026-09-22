import XCTest
@testable import Vital

final class VoiceTurnTimerTests: XCTestCase {

    private let base = Date(timeIntervalSince1970: 1_700_000_000)

    /// Full turn, every marker present, in spec order — the "happy path"
    /// latency budget from ux-spec-v4 §3.4.
    func testDerivedDurationsAcrossAFullTurn() {
        let timer = VoiceTurnTimer()
        timer.mark(.recordingStart, at: base)
        timer.mark(.lastSpeechPartial, at: base.addingTimeInterval(2.0))
        timer.mark(.endpointFired, at: base.addingTimeInterval(2.8))          // +0.8s endpoint wait
        timer.mark(.sttUploadStart, at: base.addingTimeInterval(2.9))
        timer.mark(.sttUploadEnd, at: base.addingTimeInterval(4.1))           // +1.2s stt wait
        timer.mark(.sendStart, at: base.addingTimeInterval(4.1))
        timer.mark(.firstSSEToken, at: base.addingTimeInterval(5.0))          // +0.9s to first token
        timer.mark(.firstTTSAudioPlaybackStart, at: base.addingTimeInterval(5.35)) // +2.55s since endpoint fired

        let durations = timer.finish()

        XCTAssertEqual(durations.endpointWait!, 0.8, accuracy: 0.0001)
        XCTAssertEqual(durations.sttWait!, 1.2, accuracy: 0.0001)
        XCTAssertEqual(durations.timeToFirstToken!, 0.9, accuracy: 0.0001)
        XCTAssertEqual(durations.speechEndToFirstAudio!, 2.55, accuracy: 0.0001)
    }

    /// A voice turn whose recording had no uploadable audio (STT upload
    /// skipped, Apple's on-device transcript used directly) leaves
    /// `sttWait` nil rather than reporting a bogus zero or crashing.
    func testMissingMarkerPairLeavesThatDurationNil() {
        let timer = VoiceTurnTimer()
        timer.mark(.recordingStart, at: base)
        timer.mark(.lastSpeechPartial, at: base.addingTimeInterval(1.0))
        timer.mark(.endpointFired, at: base.addingTimeInterval(1.7))
        timer.mark(.sendStart, at: base.addingTimeInterval(1.7))
        timer.mark(.firstSSEToken, at: base.addingTimeInterval(2.5))
        timer.mark(.firstTTSAudioPlaybackStart, at: base.addingTimeInterval(3.0))

        let durations = timer.finish()

        XCTAssertNil(durations.sttWait)
        XCTAssertEqual(durations.endpointWait!, 0.7, accuracy: 0.0001)
        XCTAssertEqual(durations.timeToFirstToken!, 0.8, accuracy: 0.0001)
        XCTAssertEqual(durations.speechEndToFirstAudio!, 1.3, accuracy: 0.0001)
    }

    /// A turn cut short before any audio played (e.g. the user stopped
    /// generation) leaves every downstream duration nil.
    func testAllDurationsNilWhenNoMarkersRecorded() {
        let timer = VoiceTurnTimer()
        let durations = timer.finish()

        XCTAssertNil(durations.endpointWait)
        XCTAssertNil(durations.sttWait)
        XCTAssertNil(durations.timeToFirstToken)
        XCTAssertNil(durations.speechEndToFirstAudio)
    }

    /// `lastSpeechPartial` is expected to be called repeatedly (once per
    /// live partial result) — only the *last* call before the endpoint
    /// fires should count toward `endpointWait`.
    func testLastSpeechPartialOverwritesOnEveryCall() {
        let timer = VoiceTurnTimer()
        timer.mark(.lastSpeechPartial, at: base)
        timer.mark(.lastSpeechPartial, at: base.addingTimeInterval(0.5))
        timer.mark(.lastSpeechPartial, at: base.addingTimeInterval(1.5))
        timer.mark(.endpointFired, at: base.addingTimeInterval(2.3))

        let durations = timer.finish()

        // Measured from the *last* partial (t=1.5), not the first (t=0).
        XCTAssertEqual(durations.endpointWait!, 0.8, accuracy: 0.0001)
    }

    /// Every other marker is first-write-wins: a duplicate/late callback
    /// firing the same marker twice must not distort the timing.
    func testNonRollingMarkersOnlyRecordTheFirstCall() {
        let timer = VoiceTurnTimer()
        timer.mark(.sendStart, at: base)
        timer.mark(.sendStart, at: base.addingTimeInterval(5)) // ignored — already recorded
        timer.mark(.firstSSEToken, at: base.addingTimeInterval(1.0))

        let durations = timer.finish()

        XCTAssertEqual(durations.timeToFirstToken!, 1.0, accuracy: 0.0001)
    }

    /// Defensive: an out-of-order pair (end before start — should never
    /// happen given the real call sites) yields nil rather than a negative
    /// duration.
    func testOutOfOrderMarkersYieldNilRatherThanNegativeDuration() {
        let timer = VoiceTurnTimer()
        timer.mark(.sendStart, at: base.addingTimeInterval(5))
        timer.mark(.firstSSEToken, at: base)

        XCTAssertNil(timer.interval(from: .sendStart, to: .firstSSEToken))
    }
}
