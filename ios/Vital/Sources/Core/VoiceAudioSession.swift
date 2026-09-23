import AVFoundation

// MARK: - VoiceAudioSession

/// The single `AVAudioSession` configuration for every leg of a voice turn —
/// recording (`SpeechTranscriber`) and playback (`CoachSpeaker`) — so the two
/// no longer fight over separate categories (`.record`/`.measurement` vs
/// `.playback`), which made barge-in impossible (spec `ux-spec-v4` §3.5).
///
/// `.playAndRecord`/`.voiceChat` keeps the mic and the speaker live at the
/// same time, `.defaultToSpeaker` routes to the speaker instead of the
/// earpiece when nothing else is attached, and `.allowBluetoothHFP` lets a
/// Bluetooth headset's mic and speaker both work through the same session.
/// `setAllowHapticsAndSystemSoundsDuringRecording(true)` matters on its own:
/// without it, iOS silently mutes every haptic (including the `turnEnd`/
/// `yourTurn`/`interrupt` conversation-mode cues in `Theme.Haptics`, spec
/// §6) for as long as the mic is live.
///
/// TODO(V7): enable `AVAudioEngine` voice-processing / echo cancellation
/// (`setVoiceProcessingEnabled(true)` on the input node) once barge-in (spec
/// §3.5) lands. Not enabled here — V3 is session unification only.
///
/// **`configure()` vs `activate()` (post-V3 review fix):** `setActive(true)`
/// is what actually takes audio focus from other apps — with
/// `.duckOthers`, it's what ducks Spotify/a podcast. `configure()` only sets
/// the category/mode/options on an otherwise-untouched session, which does
/// *not* affect other apps' audio. `CoachVoiceController.prewarm()` — which
/// runs on `.onAppear`, i.e. possibly just from opening the app to the
/// Today tab, before the user has touched the mic — must call `configure()`
/// only. Only a real recording/playback start (`SpeechTranscriber.start()`,
/// `CoachSpeaker.activateSession()`) calls `activate()`.
enum VoiceAudioSession {

    /// Sets the session's category/mode/options and the haptics-during-
    /// recording flag, without taking audio focus (`setActive` is never
    /// called here). Safe to call at any time, including before the user
    /// has interacted with voice at all — it does not duck or interrupt
    /// whatever else is currently playing.
    static func configure() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers]
        )
        try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
    }

    /// Configures (see above) and then activates the shared session — this
    /// is the call that takes audio focus and (with `.duckOthers`) ducks
    /// other apps' audio. Only call this to actually start recording or
    /// speaking, never speculatively. Safe to call repeatedly — re-applying
    /// the same category/mode/options and re-activating an already-active
    /// session is a cheap no-op as far as the caller is concerned.
    static func activate() throws {
        try configure()
        try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
    }

    /// Deactivates the shared session, handing audio focus back to whatever
    /// else wants it. Non-throwing — callers (recording stop, playback
    /// finishing) treat deactivation failure as non-fatal, same as the code
    /// this replaces did.
    static func deactivate() {
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }
}
