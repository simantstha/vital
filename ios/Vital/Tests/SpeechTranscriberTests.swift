import XCTest
@testable import Vital

/// `SpeechTranscriber` itself needs a real `AVAudioEngine`/`SFSpeechRecognizer`
/// (no simulator/CI-friendly seam for those, unlike `CoachVoiceController`'s
/// `SpeechTranscribing` protocol), so only its one pure, extracted decision
/// is unit-tested directly here. `EndpointPolicyTests` covers the other pure
/// piece of the pipeline; `CoachVoiceControllerTests`' `FakeSpeechTranscriber`
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
}
