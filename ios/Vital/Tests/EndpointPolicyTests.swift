import XCTest
@testable import Vital

final class EndpointPolicyTests: XCTestCase {

    // MARK: - Table rows (retuned 2026-09 after a live pause-cutoff bug report)

    /// The exact bug report: "It was good, but…" must NOT get the shortest
    /// window just because on-device punctuation made it look terminal.
    func testCompleteSentenceGetsTheTerminalPunctuationWindow() {
        let window = EndpointPolicy.silenceWindow(
            for: "It was good.",
            speechDuration: 2.5
        )
        XCTAssertEqual(window, EndpointPolicy.terminalPunctuationWindow)
        XCTAssertGreaterThanOrEqual(window, 1.3)
    }

    func testQuestionGetsTheTerminalPunctuationWindow() {
        let window = EndpointPolicy.silenceWindow(
            for: "What's my HRV trend this week?",
            speechDuration: 2.5
        )
        XCTAssertEqual(window, EndpointPolicy.terminalPunctuationWindow)
    }

    /// The other half of the bug report: "it was good but" (trailing
    /// conjunction) must get the long window, not be cut short.
    func testTrailingConjunctionGetsTheLongWindow() {
        let window = EndpointPolicy.silenceWindow(
            for: "it was good but",
            speechDuration: 2.5
        )
        XCTAssertEqual(window, EndpointPolicy.fillerWindow)
        XCTAssertEqual(window, 2.4)
    }

    func testTrailingFillerGetsTheLongWindow() {
        let window = EndpointPolicy.silenceWindow(
            for: "I went for a run this morning, um",
            speechDuration: 2.5
        )
        XCTAssertEqual(window, EndpointPolicy.fillerWindow)
    }

    func testDanglingNumberGetsTheMidWindow() {
        let window = EndpointPolicy.silenceWindow(
            for: "Log 3 sets by 5 at",
            speechDuration: 2.5
        )
        XCTAssertEqual(window, EndpointPolicy.danglingNumberWindow)
    }

    func testDanglingBareNumberGetsTheMidWindow() {
        let window = EndpointPolicy.silenceWindow(
            for: "I weighed 182",
            speechDuration: 2.5
        )
        XCTAssertEqual(window, EndpointPolicy.danglingNumberWindow)
    }

    func testOrdinaryMidSentenceTextGetsTheDefaultWindow() {
        let window = EndpointPolicy.silenceWindow(
            for: "I had a pretty good workout today",
            speechDuration: 2.5
        )
        XCTAssertEqual(window, EndpointPolicy.defaultWindow)
    }

    // MARK: - Short-utterance floor

    /// A one-word reply ending in terminal punctuation would otherwise get
    /// the (now longer, but still shorter than the floor) terminal-
    /// punctuation window — but under a second of speech is easy to clip,
    /// so the floor takes over regardless of how the utterance ends.
    func testVeryShortUtteranceWidensEvenACompleteSentence() {
        let window = EndpointPolicy.silenceWindow(for: "Yes.", speechDuration: 0.4)
        XCTAssertEqual(window, EndpointPolicy.shortUtteranceFloor)
    }

    func testVeryShortUtteranceWidensTheDefaultWindow() {
        let window = EndpointPolicy.silenceWindow(for: "Sleep", speechDuration: 0.2)
        XCTAssertGreaterThanOrEqual(window, EndpointPolicy.shortUtteranceFloor)
    }

    /// A short utterance that would already get an even longer window (e.g.
    /// a trailing filler) keeps that longer window rather than being
    /// shortened down to the floor.
    func testShortUtteranceNeverShortensAnAlreadyLongerWindow() {
        let window = EndpointPolicy.silenceWindow(for: "um", speechDuration: 0.3)
        XCTAssertEqual(window, EndpointPolicy.fillerWindow)
    }

    /// At/above the 1s threshold, the short-utterance floor no longer
    /// applies — falls through to the (now longer) terminal-punctuation
    /// window instead of the old bare minimum.
    func testSpeechDurationAtThresholdDoesNotTriggerTheFloor() {
        let window = EndpointPolicy.silenceWindow(for: "Done.", speechDuration: 1.0)
        XCTAssertEqual(window, EndpointPolicy.terminalPunctuationWindow)
    }

    // MARK: - Edge cases

    func testEmptyTranscriptFallsBackToDefaultWindow() {
        let window = EndpointPolicy.silenceWindow(for: "", speechDuration: 2.5)
        XCTAssertEqual(window, EndpointPolicy.defaultWindow)
    }

    func testEmptyTranscriptWithShortDurationStillWidens() {
        let window = EndpointPolicy.silenceWindow(for: "  ", speechDuration: 0.1)
        XCTAssertEqual(window, EndpointPolicy.shortUtteranceFloor)
    }

    // MARK: - Bounds

    /// Every combination this policy can produce stays inside the spec's
    /// [1.2, 2.6]s bounds.
    func testWindowAlwaysStaysWithinSpecBounds() {
        let transcripts = [
            "", " ", "Hello.", "Hello?", "Hello!", "and", "um", "so", "because",
            "182", "182 point", "3 by 5 at", "Log a workout", "yes", "no thanks",
            "I think it was around 14 or so, but", "It was good, but",
        ]
        let durations: [TimeInterval] = [0, 0.1, 0.5, 0.99, 1.0, 1.5, 5, 30]

        for transcript in transcripts {
            for duration in durations {
                let window = EndpointPolicy.silenceWindow(for: transcript, speechDuration: duration)
                XCTAssertGreaterThanOrEqual(window, EndpointPolicy.minWindow, "transcript=\(transcript) duration=\(duration)")
                XCTAssertLessThanOrEqual(window, EndpointPolicy.maxWindow, "transcript=\(transcript) duration=\(duration)")
            }
        }
    }
}
