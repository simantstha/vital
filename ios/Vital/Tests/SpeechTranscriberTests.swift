import XCTest
@testable import Vital

/// `SpeechTranscriber` itself needs a real `AVAudioEngine`/`SFSpeechRecognizer`
/// (no simulator/CI-friendly seam for those, unlike `CoachVoiceController`'s
/// `SpeechTranscribing` protocol), so only its pure, extracted decisions are
/// unit-tested directly here: `shouldRestartSegment` (segment-boundary vs.
/// turn-end) and `isRecognizerReset` (mid-segment transcript reset
/// detection — the pause-cutoff bug). `EndpointPolicyTests` covers the other
/// pure piece of the pipeline; `CoachVoiceControllerTests`' `FakeSpeechTranscriber`
/// covers `beginHold()`/`setAutoEndpointing(_:)` wiring.
final class SpeechTranscriberTests: XCTestCase {

    /// A natural mid-turn segment boundary (the on-device recognizer
    /// finalizing at a pause while the user is still recording) must
    /// restart recognition rather than end the turn — the other half of the
    /// pause-cutoff bug fix.
    func testFinalWhileStillRecordingRestartsTheSegment() {
        XCTAssertTrue(SpeechTranscriber.shouldRestartSegment(isFinal: true, isRecording: true))
    }

    /// The expected trailing `isFinal` that arrives after `stop()` itself
    /// already called `endAudio()` (so `isRecording` is already `false` by
    /// the time this fires) must NOT restart — the turn is genuinely over.
    func testFinalAfterStopDoesNotRestartTheSegment() {
        XCTAssertFalse(SpeechTranscriber.shouldRestartSegment(isFinal: true, isRecording: false))
    }

    /// A non-final (partial) result never restarts, recording or not.
    func testNonFinalNeverRestarts() {
        XCTAssertFalse(SpeechTranscriber.shouldRestartSegment(isFinal: false, isRecording: true))
        XCTAssertFalse(SpeechTranscriber.shouldRestartSegment(isFinal: false, isRecording: false))
    }

    // MARK: - isRecognizerReset

    /// The exact bug report: hold the mic, say "It was good.", pause 3s,
    /// say "but my calves were tight" — `SFSpeechRecognizer` can restart its
    /// transcription mid-segment without ever sending `isFinal`, so the next
    /// partial covers only the words since the pause. Fewer words AND a
    /// different first word — this must be caught as a reset.
    func testPauseCutoffIsARecognizerReset() {
        XCTAssertTrue(SpeechTranscriber.isRecognizerReset(previous: "It was good.", next: "But"))
    }

    /// Ordinary growth — more words, same leading word — is never a reset,
    /// regardless of how the trailing words evolve.
    func testOrdinaryGrowthIsNotAReset() {
        XCTAssertFalse(SpeechTranscriber.isRecognizerReset(previous: "it was good", next: "it was good but"))
    }

    /// Apple revising a word in place ("its" → "it's") keeps the same word
    /// count and must not be mistaken for a reset just because the leading
    /// token's spelling changed.
    func testInPlaceRevisionIsNotAReset() {
        XCTAssertFalse(SpeechTranscriber.isRecognizerReset(previous: "its good", next: "it's good"))
    }

    /// Nothing decoded yet this segment — there's nothing to have reset
    /// away from.
    func testEmptyPreviousIsNotAReset() {
        XCTAssertFalse(SpeechTranscriber.isRecognizerReset(previous: "", next: "hello"))
    }

    /// An unchanged transcript (e.g. a duplicate callback) is not a reset.
    func testIdenticalStringIsNotAReset() {
        XCTAssertFalse(SpeechTranscriber.isRecognizerReset(previous: "hello world", next: "hello world"))
    }
}
