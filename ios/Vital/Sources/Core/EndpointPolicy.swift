import Foundation

/// Adaptive end-of-speech ("endpointing") window, replacing
/// `SpeechTranscriber`'s old fixed 1.8s silence timer (spec `ux-spec-v4`
/// §3.3, delivery slice V1). A pure, unit-testable policy: given the live
/// partial transcript and how long the user has been speaking, it returns
/// how long to wait, after the last partial result, before treating the
/// turn as finished.
///
/// Kept deliberately dependency-free (no `SpeechTranscriber`/`Speech`
/// import) so it can be tested in isolation and reused by any future
/// pipeline (e.g. `CoachVoiceController` in a later PR).
enum EndpointPolicy {

    /// Spec §3.3's bounds — every window this policy returns falls inside
    /// this range, regardless of input.
    static let minWindow: TimeInterval = 0.6
    static let maxWindow: TimeInterval = 1.2

    /// "Anything else (default)" row.
    static let defaultWindow: TimeInterval = 0.8
    /// "A trailing filler or conjunction" row.
    static let fillerWindow: TimeInterval = 1.2
    /// "A dangling number or unit" row.
    static let danglingNumberWindow: TimeInterval = 1.0
    /// Below this much speech, treat the utterance as "very short" and widen
    /// the window so a quick reply isn't clipped mid-word.
    static let shortUtteranceThreshold: TimeInterval = 1.0
    /// The floor applied to very short utterances.
    static let shortUtteranceFloor: TimeInterval = 1.0

    /// Trailing words that read as mid-thought rather than turn-final.
    private static let fillerWords: Set<String> = [
        "um", "uh", "umm", "erm", "hmm",
        "and", "but", "so", "or", "because", "like",
    ]

    /// Trailing words that often precede a number/unit still being spoken
    /// ("3 by 5 at…", "182 point…").
    private static let danglingTrailWords: Set<String> = ["point", "by", "at", "times", "of"]

    /// How long to wait after the last partial transcript before ending the
    /// turn.
    ///
    /// - Parameters:
    ///   - partialTranscript: the live (possibly still-forming) transcript
    ///     at the moment of the last partial result.
    ///   - speechDuration: how long the user has been speaking in this turn
    ///     so far (elapsed time since the first non-empty partial).
    static func silenceWindow(for partialTranscript: String, speechDuration: TimeInterval) -> TimeInterval {
        let trimmed = partialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = trimmed
            .split(separator: " ")
            .map { $0.trimmingCharacters(in: .punctuationCharacters).lowercased() }
            .filter { !$0.isEmpty }
        let lastWord = words.last ?? ""

        var window: TimeInterval
        if let lastChar = trimmed.last, isTerminalPunctuation(lastChar) {
            window = minWindow
        } else if fillerWords.contains(lastWord) {
            window = fillerWindow
        } else if isDanglingNumber(words) {
            window = danglingNumberWindow
        } else {
            window = defaultWindow
        }

        // Very short utterances get widened regardless of how they end —
        // a one-word reply ending in "." shouldn't be clipped just because
        // punctuation looked terminal.
        if speechDuration < shortUtteranceThreshold {
            window = max(window, shortUtteranceFloor)
        }

        return min(max(window, minWindow), maxWindow)
    }

    private static func isTerminalPunctuation(_ char: Character) -> Bool {
        char == "." || char == "!" || char == "?"
    }

    /// True when the transcript trails off on a bare number ("182", "3.5")
    /// or a word that typically precedes one still being spoken ("point",
    /// "by", "at", "times", "of") immediately after a number.
    private static func isDanglingNumber(_ words: [String]) -> Bool {
        guard let last = words.last, !last.isEmpty else { return false }
        if last.contains(where: \.isNumber) { return true }
        guard danglingTrailWords.contains(last), words.count >= 2 else { return false }
        return words[words.count - 2].contains(where: \.isNumber)
    }
}
