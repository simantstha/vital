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
enum VoiceAudioSession {

    /// Activates the shared session. Safe to call repeatedly — re-applying
    /// the same category/mode/options and re-activating an already-active
    /// session is a cheap no-op as far as the caller is concerned.
    static func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers]
        )
        try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
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
