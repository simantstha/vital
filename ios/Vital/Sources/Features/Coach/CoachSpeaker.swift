import Foundation
import AVFoundation

/// Speaks a streamed coach reply aloud, sentence by sentence, so audio starts
/// while the reply is still rendering as text in the transcript. Only used
/// when the user's message was spoken (see `CoachViewModel`) — typed
/// messages are never read aloud.
@MainActor
final class CoachSpeaker: NSObject, ObservableObject {

    @Published var isSpeaking: Bool = false

    private let synthesizer = AVSpeechSynthesizer()
    private var buffer: String = ""
    private var isSessionActive = false
    private lazy var voice: AVSpeechSynthesisVoice? = Self.bestEnglishVoice()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    // MARK: - Feeding streamed text

    /// Appends a streamed text delta to the buffer and enqueues an utterance
    /// for each complete sentence found (boundary: `.`, `!`, `?`, newline).
    /// Any trailing partial sentence stays buffered until the next delta or
    /// `finish()`.
    func feed(delta: String) {
        buffer += delta
        while let range = buffer.rangeOfCharacter(from: Self.sentenceTerminators) {
            let sentence = String(buffer[buffer.startIndex...range.lowerBound])
            buffer.removeSubrange(buffer.startIndex...range.lowerBound)
            enqueue(sentence)
        }
    }

    /// Flushes whatever's left in the buffer (a final clause with no
    /// trailing punctuation) once the stream ends.
    func finish() {
        let remaining = buffer
        buffer = ""
        enqueue(remaining)
    }

    /// Cancels everything queued and currently speaking. Called when the
    /// user starts a new recording or sends a new message.
    func stop() {
        buffer = ""
        guard synthesizer.isSpeaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        deactivateSession()
    }

    // MARK: - Private

    private func enqueue(_ raw: String) {
        let plain = Self.stripMarkdown(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !plain.isEmpty else { return }

        if !isSessionActive { activateSession() }

        let utterance = AVSpeechUtterance(string: plain)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }

    private func activateSession() {
        isSessionActive = true
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, options: .duckOthers)
            try session.setActive(true)
        } catch {
            // Non-fatal — the utterance still attempts to play through
            // whatever session state is currently active.
        }
    }

    private func deactivateSession() {
        guard isSessionActive else { return }
        isSessionActive = false
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Voice selection

    /// Picks the best installed English voice: premium > enhanced > default.
    private static func bestEnglishVoice() -> AVSpeechSynthesisVoice? {
        let englishVoices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
        if let premium = englishVoices.first(where: { $0.quality == .premium }) {
            return premium
        }
        if let enhanced = englishVoices.first(where: { $0.quality == .enhanced }) {
            return enhanced
        }
        return AVSpeechSynthesisVoice(language: "en-US")
    }

    // MARK: - Markdown stripping (audio-only; the transcript still renders MarkdownText)

    private static let sentenceTerminators = CharacterSet(charactersIn: ".!?\n")

    private static func stripMarkdown(_ text: String) -> String {
        var s = text
        // Links: [label](url) -> label
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^\)]+\)"#, with: "$1", options: .regularExpression)
        // Bold/italic emphasis
        s = s.replacingOccurrences(of: #"\*\*\*(.+?)\*\*\*"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\*\*(.+?)\*\*"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\*(.+?)\*"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"__(.+?)__"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"_(.+?)_"#, with: "$1", options: .regularExpression)
        // Inline code / fences
        s = s.replacingOccurrences(of: "`", with: "")
        // Headings
        s = s.replacingOccurrences(of: #"^#{1,6}\s*"#, with: "", options: [.regularExpression, .anchored])
        // Bullet / numbered list markers
        s = s.replacingOccurrences(of: #"^\s*[-*+]\s+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^\s*\d+\.\s+"#, with: "", options: .regularExpression)
        return s
    }
}

// MARK: - AVSpeechSynthesizerDelegate

extension CoachSpeaker: AVSpeechSynthesizerDelegate {
    // AVSpeechSynthesizer invokes its delegate off the main actor, so these
    // hop back via Task rather than touching @MainActor state directly.
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = true }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.handleUtteranceEnded() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.handleUtteranceEnded() }
    }

    @MainActor
    private func handleUtteranceEnded() {
        guard !synthesizer.isSpeaking else { return }
        isSpeaking = false
        deactivateSession()
    }
}
