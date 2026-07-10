import Foundation
import AVFoundation

/// Speaks a streamed coach reply aloud, sentence by sentence, so audio starts
/// while the reply is still rendering as text in the transcript. Only used
/// when the user's message was spoken (see `CoachViewModel`) — typed
/// messages are never read aloud.
///
/// Each sentence is synthesized server-side via ElevenLabs (`POST /api/tts`,
/// see that route for the contract) so the coach speaks in a natural voice
/// instead of the on-device robotic one. To hide network latency, a
/// sentence's audio fetch is kicked off the moment it's enqueued — fetches
/// for later sentences can run concurrently with earlier ones playing — but
/// a single playback loop consumes the queue strictly in order, so audio
/// never plays out of sequence. If a sentence's fetch fails (offline, 503
/// when the backend has no ElevenLabs key configured, etc.) that one
/// sentence falls back to the on-device `AVSpeechSynthesizer`, and the queue
/// continues in order from there.
@MainActor
final class CoachSpeaker: NSObject, ObservableObject {

    @Published var isSpeaking: Bool = false

    // MARK: - Queue item

    /// One sentence's worth of speech: the plain (markdown-stripped) text and
    /// its audio fetch, started immediately on enqueue.
    private struct QueueItem {
        let text: String
        let fetchTask: Task<Data?, Never>
    }

    private var buffer: String = ""
    private var pendingQueue: [QueueItem] = []
    /// The item currently being awaited/played by the playback loop. Kept
    /// separate from `pendingQueue` (rather than peeking at index 0) so
    /// `stop()` can reach its in-flight fetch task directly.
    private var currentItem: QueueItem? = nil

    private var playbackLoopTask: Task<Void, Never>? = nil
    private var currentPlayer: AVAudioPlayer? = nil

    /// Resumed exactly once per playback (by the AVAudioPlayer/AVSpeechSynthesizer
    /// delegate callback on natural completion, or by `stop()` on early
    /// cancellation) — whichever happens first wins, since it's nilled out
    /// immediately before resuming.
    private var playbackContinuation: CheckedContinuation<Void, Never>? = nil

    /// Bumped every time `stop()` runs. The playback loop and every
    /// in-flight fetch/playback closure captures the generation at the time
    /// it started and checks it after every suspension point, so work left
    /// over from a cancelled turn can never affect state (or speak) for a
    /// new one.
    private var generation = 0

    private var isSessionActive = false

    private let synthesizer = AVSpeechSynthesizer()
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

    /// Cancels everything queued and currently speaking/playing. Called when
    /// the user starts a new recording or sends a new message. Safe to call
    /// at any time (including when nothing is speaking); a subsequent
    /// `feed()` always starts a fresh session.
    func stop() {
        generation += 1
        buffer = ""

        currentItem?.fetchTask.cancel()
        currentItem = nil
        for item in pendingQueue { item.fetchTask.cancel() }
        pendingQueue.removeAll()

        playbackLoopTask?.cancel()
        playbackLoopTask = nil

        currentPlayer?.stop()
        currentPlayer = nil
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        resumePlaybackContinuationIfNeeded()

        isSpeaking = false
        deactivateSession()
    }

    // MARK: - Private — enqueue + playback loop

    private func enqueue(_ raw: String) {
        let plain = Self.stripMarkdown(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !plain.isEmpty else { return }

        if !isSessionActive { activateSession() }

        let fetchTask = Task<Data?, Never> {
            await APIClient.shared.fetchTTSAudio(text: plain)
        }
        pendingQueue.append(QueueItem(text: plain, fetchTask: fetchTask))
        isSpeaking = true

        if playbackLoopTask == nil {
            let gen = generation
            playbackLoopTask = Task { await self.runPlaybackLoop(generation: gen) }
        }
    }

    /// Drains `pendingQueue` strictly in order: waits for each item's fetch
    /// (already in flight since enqueue), plays the resulting audio, and
    /// falls back to on-device speech for that one sentence if the fetch
    /// failed — then moves to the next item. Exits (and tears down the
    /// audio session) once the queue is empty, unless superseded by a newer
    /// generation from `stop()`.
    private func runPlaybackLoop(generation startGen: Int) async {
        while generation == startGen {
            guard !pendingQueue.isEmpty else { break }
            let item = pendingQueue.removeFirst()
            currentItem = item

            let data = await item.fetchTask.value
            guard generation == startGen else { return }

            if let data, !data.isEmpty {
                await playAudio(data, generation: startGen)
            } else {
                await speakFallback(item.text, generation: startGen)
            }
            guard generation == startGen else { return }
            currentItem = nil
        }

        guard generation == startGen else { return }
        playbackLoopTask = nil
        isSpeaking = false
        deactivateSession()
    }

    private func playAudio(_ data: Data, generation startGen: Int) async {
        guard let player = try? AVAudioPlayer(data: data) else {
            await speakFallback(currentItem?.text ?? "", generation: startGen)
            return
        }
        player.delegate = self
        currentPlayer = player

        await withCheckedContinuation { continuation in
            self.playbackContinuation = continuation
            if !player.play() {
                self.resumePlaybackContinuationIfNeeded()
            }
        }

        guard generation == startGen else { return }
        currentPlayer = nil
    }

    private func speakFallback(_ text: String, generation startGen: Int) async {
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate

        await withCheckedContinuation { continuation in
            self.playbackContinuation = continuation
            synthesizer.speak(utterance)
        }
    }

    private func resumePlaybackContinuationIfNeeded() {
        guard let continuation = playbackContinuation else { return }
        playbackContinuation = nil
        continuation.resume()
    }

    // MARK: - Audio session

    private func activateSession() {
        isSessionActive = true
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, options: .duckOthers)
            try session.setActive(true)
        } catch {
            // Non-fatal — playback still attempts to proceed through
            // whatever session state is currently active.
        }
    }

    private func deactivateSession() {
        guard isSessionActive else { return }
        isSessionActive = false
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Voice selection (fallback path only)

    /// Picks the best installed English voice: premium > enhanced > default.
    /// Only used when a sentence falls back to on-device speech.
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

// MARK: - AVAudioPlayerDelegate

extension CoachSpeaker: AVAudioPlayerDelegate {
    // AVAudioPlayer invokes its delegate off the main actor, so these hop
    // back via Task rather than touching @MainActor state directly.
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.resumePlaybackContinuationIfNeeded() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.resumePlaybackContinuationIfNeeded() }
    }
}

// MARK: - AVSpeechSynthesizerDelegate

extension CoachSpeaker: AVSpeechSynthesizerDelegate {
    // AVSpeechSynthesizer invokes its delegate off the main actor, so these
    // hop back via Task rather than touching @MainActor state directly.
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.resumePlaybackContinuationIfNeeded() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.resumePlaybackContinuationIfNeeded() }
    }
}
