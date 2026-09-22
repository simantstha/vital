import Foundation
import os

/// Per-turn voice latency instrumentation (spec `ux-spec-v4` §3.4 latency
/// budget, delivery slice §10 V1). One instance is created per voice turn
/// (see `CoachViewModel`); it records a monotonic `Date` for each stage as
/// it happens, computes the derived durations the spec calls out, emits
/// `os_signpost` intervals for Instruments, and logs one summary line via
/// `Logger` once the turn completes.
///
/// TODO(spec §10 V1): also POST these numbers to a `voice_turn_timing`
/// backend endpoint once one exists. Out of scope for this PR — client-side
/// telemetry only.
final class VoiceTurnTimer {

    /// One stage in a voice turn. Not every voice turn hits every marker
    /// (e.g. `sttUploadStart`/`End` are skipped if the recording had no
    /// audio file to upload).
    enum Marker: String, CaseIterable {
        case recordingStart = "recording_start"
        case lastSpeechPartial = "last_speech_partial"
        case endpointFired = "endpoint_fired"
        case sttUploadStart = "stt_upload_start"
        case sttUploadEnd = "stt_upload_end"
        case sendStart = "send_start"
        case firstSSEToken = "first_sse_token"
        case firstTTSAudioPlaybackStart = "first_tts_audio_playback_start"
    }

    /// The derived latencies the spec's §3.4 table calls out, in seconds.
    /// Nil when either endpoint of the pair was never marked (e.g. no STT
    /// upload happened, or the reply never produced audio).
    struct Durations: Equatable {
        var endpointWait: TimeInterval?
        var sttWait: TimeInterval?
        var timeToFirstToken: TimeInterval?
        var speechEndToFirstAudio: TimeInterval?
    }

    private static let subsystem = Bundle.main.bundleIdentifier ?? "com.simantstha.vital"
    private static let signposter = OSSignposter(subsystem: subsystem, category: "voice")
    private static let logger = Logger(subsystem: subsystem, category: "voice")

    private(set) var timestamps: [Marker: Date] = [:]
    let turnId = UUID()

    /// Live signpost intervals whose true start time is known the moment
    /// they begin (`stt_wait`, `time_to_first_token`, and
    /// `speech_end_to_first_audio`, which starts the instant the endpoint
    /// fires). `endpoint_wait`'s true start (the *last* partial before the
    /// endpoint fires) can only be known in hindsight — once no more
    /// partials arrive — so it doesn't get a live-accurate interval; its
    /// duration is still computed correctly from the recorded `Date`s in
    /// `finish()`.
    private var sttWaitState: OSSignpostIntervalState?
    private var timeToFirstTokenState: OSSignpostIntervalState?
    private var speechEndToFirstAudioState: OSSignpostIntervalState?

    /// Records `marker` at `date` (defaults to now). The first call for a
    /// given marker in this turn wins — a watchdog or a duplicate callback
    /// firing twice must not distort the timing — with one exception:
    /// `lastSpeechPartial` is expected to be called repeatedly (once per
    /// live partial result) and always overwrites, since only the *last*
    /// call before the endpoint fires is meaningful.
    @discardableResult
    func mark(_ marker: Marker, at date: Date = Date()) -> Date {
        if marker == .lastSpeechPartial {
            timestamps[marker] = date
        } else if timestamps[marker] == nil {
            timestamps[marker] = date
        } else {
            return timestamps[marker]!
        }

        switch marker {
        case .sttUploadStart:
            sttWaitState = Self.signposter.beginInterval("stt_wait")
        case .sttUploadEnd:
            if let state = sttWaitState { Self.signposter.endInterval("stt_wait", state) }
        case .sendStart:
            timeToFirstTokenState = Self.signposter.beginInterval("time_to_first_token")
        case .firstSSEToken:
            if let state = timeToFirstTokenState { Self.signposter.endInterval("time_to_first_token", state) }
        case .endpointFired:
            speechEndToFirstAudioState = Self.signposter.beginInterval("speech_end_to_first_audio")
        case .firstTTSAudioPlaybackStart:
            if let state = speechEndToFirstAudioState {
                Self.signposter.endInterval("speech_end_to_first_audio", state)
            }
        case .recordingStart, .lastSpeechPartial:
            break
        }

        return date
    }

    /// Computes the derived durations from whatever markers were recorded,
    /// logs one summary line, and returns them (for the DEBUG voice HUD).
    /// Safe to call once per turn; call sites don't need to worry about
    /// double-logging since nothing here is destructive.
    @discardableResult
    func finish() -> Durations {
        var durations = Durations()
        durations.endpointWait = interval(from: .lastSpeechPartial, to: .endpointFired)
        durations.sttWait = interval(from: .sttUploadStart, to: .sttUploadEnd)
        durations.timeToFirstToken = interval(from: .sendStart, to: .firstSSEToken)
        durations.speechEndToFirstAudio = interval(from: .endpointFired, to: .firstTTSAudioPlaybackStart)

        Self.logger.notice(
            "voice_turn \(self.turnId.uuidString, privacy: .public) endpoint_wait=\(Self.format(durations.endpointWait), privacy: .public) stt_wait=\(Self.format(durations.sttWait), privacy: .public) time_to_first_token=\(Self.format(durations.timeToFirstToken), privacy: .public) speech_end_to_first_audio=\(Self.format(durations.speechEndToFirstAudio), privacy: .public)"
        )

        return durations
    }

    /// Duration between two markers in seconds, or nil if either is
    /// missing or the pair is out of order (defensive — should never
    /// happen given the call sites, but a negative "duration" would be a
    /// worse bug to ship silently than an absent one).
    func interval(from start: Marker, to end: Marker) -> TimeInterval? {
        guard let startDate = timestamps[start], let endDate = timestamps[end] else { return nil }
        let delta = endDate.timeIntervalSince(startDate)
        return delta >= 0 ? delta : nil
    }

    private static func format(_ value: TimeInterval?) -> String {
        guard let value else { return "–" }
        return String(format: "%.3f", value)
    }
}
